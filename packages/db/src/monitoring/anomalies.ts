import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm'
import {
  CLEANUP_FAILURE_MIN_ATTEMPTS,
  DEFAULT_MONITOR_MAX_RECOVERIES,
  DEFAULT_OBJECT_PENDING_TTL_SECONDS,
  MONITOR_UPLOAD_FAILED_REASONS,
  knownMetric,
  unknownMetric,
  type MonitorAnomaliesCard,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { asCount, occupancyStatuses } from './util.js'

export async function summarizeAnomalies(
  db: Db,
  asOf?: Date,
  options?: { maxRecoveries?: number; pendingTtlSeconds?: number },
): Promise<{ asOf: Date; data: MonitorAnomaliesCard }> {
  const resolved = asOf ?? (await clockNow(db))
  const maxRecoveries = options?.maxRecoveries ?? DEFAULT_MONITOR_MAX_RECOVERIES
  const pendingTtlSeconds = options?.pendingTtlSeconds ?? DEFAULT_OBJECT_PENDING_TTL_SECONDS
  const { runLeases, sessionLeases, browserSessions, attempts, stepRuns, runs, evidences, storedObjects } =
    schemaFor(db)
  const occupancy = occupancyStatuses()

  const [expiredRun] = await db
    .select({ n: sql`count(*)` })
    .from(runLeases)
    .where(and(eq(runLeases.status, 'ACTIVE'), sql`${runLeases.expiresAt} <= ${resolved}`))

  const [expiredSession] = await db
    .select({ n: sql`count(*)` })
    .from(sessionLeases)
    .where(and(eq(sessionLeases.status, 'ACTIVE'), sql`${sessionLeases.expiresAt} <= ${resolved}`))

  const leftoverHold = sql`EXISTS (
    SELECT 1 FROM ${sessionLeases} l
     WHERE l.session_id = ${browserSessions.id}
       AND l.status = 'ACTIVE'
       AND l.purpose = 'AUTH_WAIT'
       AND l.wait_deadline_at IS NOT NULL
       AND l.wait_deadline_at <= ${resolved}
  )`
  const [leftover] = await db
    .select({ n: sql`sum(case when ${leftoverHold} then 1 else 0 end)` })
    .from(browserSessions)
    .where(inArray(browserSessions.status, occupancy))

  const [orphans] = await db
    .select({ n: sql`count(*)` })
    .from(attempts)
    .innerJoin(stepRuns, eq(attempts.stepRunId, stepRuns.id))
    .where(
      and(
        eq(attempts.status, 'RUNNING'),
        sql`NOT EXISTS (
          SELECT 1 FROM ${runLeases} rl
           WHERE rl.run_id = ${stepRuns.runId}
             AND rl.status = 'ACTIVE'
             AND rl.expires_at > ${resolved}
        )`,
      ),
    )

  const capped = { n: await countRecoveryCappedRuns(db, maxRecoveries) }

  const [pending] = await db
    .select({ n: sql`count(*)` })
    .from(evidences)
    .where(eq(evidences.status, 'pending'))
  const [failed] = await db
    .select({ n: sql`count(*)` })
    .from(evidences)
    .where(and(eq(evidences.status, 'missing'), inArray(evidences.missingReason, [...MONITOR_UPLOAD_FAILED_REASONS])))
  const [maxAttempts] = await db
    .select({ n: sql`coalesce(max(${evidences.uploadAttempts}), 0)` })
    .from(evidences)
  const missingRows = await db
    .select({
      reason: evidences.missingReason,
      n: sql`count(*)`,
    })
    .from(evidences)
    .where(isNotNull(evidences.missingReason))
    .groupBy(evidences.missingReason)
    .limit(32)

  const pendingBefore = new Date(resolved.getTime() - pendingTtlSeconds * 1000)
  const [purgeBacklog] = await db
    .select({ n: sql`count(*)` })
    .from(storedObjects)
    .where(
      or(
        and(eq(storedObjects.status, 'available'), lt(storedObjects.retainUntil, resolved)),
        and(eq(storedObjects.status, 'pending'), lt(storedObjects.createdAt, pendingBefore)),
        and(
          or(eq(storedObjects.status, 'pending'), eq(storedObjects.status, 'available')),
          isNotNull(storedObjects.deleteRequestedAt),
        ),
      ),
    )
  const [purgeFailed] = await db
    .select({ n: sql`count(*)` })
    .from(storedObjects)
    .where(
      and(
        ne(storedObjects.status, 'purged'),
        or(
          isNotNull(storedObjects.lastPurgeErrorAt),
          gte(storedObjects.purgeAttempts, CLEANUP_FAILURE_MIN_ATTEMPTS),
        ),
      ),
    )

  return {
    asOf: resolved,
    data: {
      leases: {
        expiredActiveRunLeases: knownMetric(asCount(expiredRun?.n)),
        expiredActiveSessionLeases: knownMetric(asCount(expiredSession?.n)),
        leftoverAuthHolds: knownMetric(asCount(leftover?.n)),
        orphanAttempts: knownMetric(asCount(orphans?.n)),
        recoveryCappedRuns: knownMetric(asCount(capped?.n)),
      },
      evidence: {
        pendingUpload: knownMetric(asCount(pending?.n)),
        uploadFailed: knownMetric(asCount(failed?.n)),
        maxUploadAttempts: knownMetric(asCount(maxAttempts?.n)),
        purgeBacklog: knownMetric(asCount(purgeBacklog?.n)),
        purgeFailed: knownMetric(asCount(purgeFailed?.n)),
        missingReasons: missingRows
          .filter((row) => row.reason)
          .map((row) => ({ reason: String(row.reason), count: asCount(row.n) })),
      },
      clockSkew: { maxAbsSkewMs: await maxAbsClockSkew(db, resolved) },
    },
  }
}

const RECOVERY_CAPPED_STATUSES = [
  'QUEUED',
  'RECOVERING',
  'RUNNING',
  'HOLDING',
  'WAITING_FOR_AUTH',
  'NEEDS_REVIEW',
] as const

/** 与恢复路径 `countFailedRecoveries` 同一口径：EXPIRED / REVOKED 租约数 ≥ maxRecoveries。 */
export async function countRecoveryCappedRuns(db: Db, maxRecoveries: number): Promise<number> {
  const { runLeases, runs } = schemaFor(db)
  const cappedLeaseRuns = db
    .select({ runId: runLeases.runId })
    .from(runLeases)
    .where(inArray(runLeases.status, ['EXPIRED', 'REVOKED']))
    .groupBy(runLeases.runId)
    .having(sql`count(*) >= ${maxRecoveries}`)
    .as('capped_lease_runs')
  const [capped] = await db
    .select({ n: sql`count(*)` })
    .from(cappedLeaseRuns)
    .innerJoin(runs, eq(runs.id, cappedLeaseRuns.runId))
    .where(and(sql`${runs.deletedAt} IS NULL`, inArray(runs.status, [...RECOVERY_CAPPED_STATUSES])))
  return asCount(capped?.n)
}

/** 旧实现：从活跃 Run 出发逐条数租约。仅供等价与 EXPLAIN 对照。 */
export async function countRecoveryCappedRunsFromRuns(db: Db, maxRecoveries: number): Promise<number> {
  const { runLeases, runs } = schemaFor(db)
  const [capped] = await db
    .select({ n: sql`count(*)` })
    .from(runs)
    .where(
      and(
        sql`${runs.deletedAt} IS NULL`,
        inArray(runs.status, [...RECOVERY_CAPPED_STATUSES]),
        sql`(
          SELECT count(*) FROM ${runLeases} l
           WHERE l.run_id = ${runs.id}
             AND l.status IN ('EXPIRED', 'REVOKED')
        ) >= ${maxRecoveries}`,
      ),
    )
  return asCount(capped?.n)
}

async function maxAbsClockSkew(db: Db, asOf: Date) {
  const { workers } = schemaFor(db)
  const [row] = await db
    .select({
      n: sql`max(abs(${workers.processClockSkewMs}))`,
    })
    .from(workers)
    .where(
      and(
        sql`${workers.heartbeatExpiresAt} IS NOT NULL`,
        sql`${workers.heartbeatExpiresAt} > ${asOf}`,
        isNotNull(workers.processClockSkewMs),
      ),
    )
  return row?.n == null ? unknownMetric('not_collected') : knownMetric(asCount(row.n))
}
