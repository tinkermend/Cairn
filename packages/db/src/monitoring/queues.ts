import { and, eq, inArray, sql } from 'drizzle-orm'
import { knownMetric, unknownMetric, type MonitorQueuesCard } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'
import { GLOBAL_RECLAIM_WATERMARK, readRuntimeWatermark } from '../runtime/watermarks.js'
import { readLatestClaimScanCount } from './samples.js'
import { asCount, claimableRunCondition, onlineClaimerCondition, workerCoversSnapshot } from './util.js'

function percentileNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percentile / 100) * sorted.length)))
  return sorted[rank - 1]!
}

export async function countSessionOperationBacklog(db: Db): Promise<number> {
  const { sessionOperations } = schemaFor(db)
  const [queued] = await db
    .select({ n: sql`count(*)` })
    .from(sessionOperations)
    .where(eq(sessionOperations.status, 'QUEUED'))
  const [active] = await db
    .select({ n: sql`count(*)` })
    .from(sessionOperations)
    .where(inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']))
  return asCount(queued?.n) + asCount(active?.n)
}

export async function summarizeQueues(
  db: Db,
  asOf?: Date,
): Promise<{ asOf: Date; data: MonitorQueuesCard }> {
  const resolved = asOf ?? (await clockNow(db))
  const { runs, workers, scheduleOccurrences, mapJobs } = schemaFor(db)
  const claimable = claimableRunCondition(db, resolved)

  const [queueRow] = await db
    .select({
      claimable: sql`count(*)`,
      oldestCreatedAt: sql`min(${runs.createdAt})`,
    })
    .from(runs)
    .where(claimable)

  const [recoveringRow] = await db
    .select({ n: sql`count(*)` })
    .from(runs)
    .where(eq(runs.status, 'RECOVERING'))

  const [reviewRow] = await db
    .select({ n: sql`count(*)` })
    .from(runs)
    .where(eq(runs.status, 'NEEDS_REVIEW'))

  const [unclaimableRow] = await db
    .select({ n: sql`count(*)` })
    .from(runs)
    .where(
      and(
        claimable,
        sql`NOT EXISTS (
          SELECT 1 FROM ${workers}
           WHERE ${onlineClaimerCondition(db, resolved)}
             AND ${workerCoversSnapshot(db)}
        )`,
      ),
    )

  const sessionOperations = await countSessionOperationBacklog(db)

  const [scheduleRow] = await db
    .select({ n: sql`count(*)` })
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.admissionStatus, 'PENDING'))

  const [mapRow] = await db
    .select({
      queued: sql`sum(case when ${mapJobs.jobStatus} = 'queued' then 1 else 0 end)`,
      running: sql`sum(case when ${mapJobs.jobStatus} = 'running' then 1 else 0 end)`,
      active: sql`sum(case when ${mapJobs.jobStatus} IN ('queued', 'running') then 1 else 0 end)`,
      mismatch: sql`sum(case
        when ${mapJobs.jobStatus} IN ('queued', 'running') AND ${mapJobs.activeGuard} IS NULL then 1
        when ${mapJobs.jobStatus} NOT IN ('queued', 'running') AND ${mapJobs.activeGuard} IS NOT NULL then 1
        else 0 end)`,
    })
    .from(mapJobs)

  const targetCounts = await db
    .select({ n: sql`count(*)` })
    .from(runs)
    .where(claimable)
    .groupBy(runs.targetId)
  const backlogSizes = targetCounts.map((row) => asCount(row.n)).filter((count) => count > 0)
  const maxTargetBacklog = backlogSizes.reduce((max, count) => Math.max(max, count), 0)
  const lastClaimScanCount = await readLatestClaimScanCount(db)

  const reclaimAt = await readRuntimeWatermark(db, GLOBAL_RECLAIM_WATERMARK)

  const claimableRuns = asCount(queueRow?.claimable)
  const oldest = queueRow?.oldestCreatedAt
  const waitedMs =
    claimableRuns === 0 || oldest == null
      ? 0
      : resolved.getTime() - new Date(oldest as string | Date).getTime()
  const oldestWaitMs = Number.isFinite(waitedMs) ? Math.max(0, waitedMs) : 0

  return {
    asOf: resolved,
    data: {
      claimableRuns: knownMetric(claimableRuns),
      oldestWaitMs: knownMetric(oldestWaitMs),
      unclaimableRuns: knownMetric(asCount(unclaimableRow?.n)),
      recovering: knownMetric(asCount(recoveringRow?.n)),
      needsReview: knownMetric(asCount(reviewRow?.n)),
      sessionOperations: knownMetric(sessionOperations),
      schedulePending: knownMetric(asCount(scheduleRow?.n)),
      mapJobsActive: knownMetric(asCount(mapRow?.active)),
      mapJobsQueued: knownMetric(asCount(mapRow?.queued)),
      mapJobsRunning: knownMetric(asCount(mapRow?.running)),
      mapJobsActiveGuardMismatch: knownMetric(asCount(mapRow?.mismatch)),
      maxTargetBacklog: knownMetric(maxTargetBacklog),
      targetsWithBacklog: knownMetric(backlogSizes.length),
      targetBacklogP95: knownMetric(percentileNearestRank(backlogSizes, 95)),
      lastClaimScanCount:
        lastClaimScanCount == null ? unknownMetric('not_collected') : knownMetric(lastClaimScanCount),
      lastGlobalReclaimAgeMs: reclaimAt
        ? knownMetric(Math.max(0, resolved.getTime() - reclaimAt.getTime()))
        : unknownMetric('not_collected'),
    },
  }
}
