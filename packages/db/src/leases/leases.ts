import type { RunLeaseRow, WorkerRow } from '../records.js'
import { expireRunDeadlines } from '../runs/deadline.js'
import { schemaFor } from '../native.js'
import { updateRows } from '../native.js'
import { and, asc, eq, inArray, isNull, ne, not, notInArray, or, sql } from 'drizzle-orm'
import {
  DEFAULT_BROWSER_MAX_SESSIONS,
  MAP_JOBS_PROTOCOL,
  OUTCOME_MANIFEST_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
  isFinishedRunStatus,
  isMapJobRun,
  nextHandleMismatchStreak,
  runGrantSchema,
  type RunGrant,
  type RunLeaseErrorCode,
  type RunSnapshot,
  type RunStatus,
  type WorkerStatus,
} from '@cairn/shared'
import { appendRunEvents } from '../observe/events.js'
import { conflict, isUniqueViolation } from '../runs/errors.js'
import type { Db, DbHandle } from '../client.js'
import { newId } from '../id.js'
import { runs } from '../schema/execution.js'
import { browserSessions } from '../schema/session.js'
import { locked, databaseNow, afterSeconds, clockNow, insertRows, jsonHasKey } from '../native.js'
import { mapJobs } from '../schema/map-jobs.js'
import { evaluateRunSessionEligibility } from '../sessions/occupancy-placement.js'
import { readSessionScheduling } from '../sessions/occupancy-read.js'
import { runLeases, workers } from '../schema/worker.js'

/** 用共享枚举标注，让"抛出的码"与"对外声明的码"由类型接住，而不是各写一遍字面量。 */
export const WORKER_ID_CONFLICT: RunLeaseErrorCode = 'WORKER_ID_CONFLICT'

export type WorkerRecord = {
  id: string
  instanceId: string
  status: WorkerStatus
  capacity: number
  maxSessions: number
  heartbeatAt: Date
  internalBaseUrl: string | null
  lostAfterSeconds: number | null
  heartbeatExpiresAt: Date | null
  liveHandleCount: number | null
  sampledSlotCount: number | null
  handleMismatchStreak: number
  handleSampledAt: Date | null
  protocolCapabilities: string[]
}

export type RegisterWorkerResult = {
  worker: WorkerRecord
  revokedRunIds: string[]
}

function toWorker(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    instanceId: row.instanceId,
    status: row.status,
    capacity: row.capacity,
    maxSessions: row.maxSessions,
    heartbeatAt: row.heartbeatAt,
    internalBaseUrl: row.internalBaseUrl,
    lostAfterSeconds: row.lostAfterSeconds,
    heartbeatExpiresAt: row.heartbeatExpiresAt,
    liveHandleCount: row.liveHandleCount,
    sampledSlotCount: row.sampledSlotCount,
    handleMismatchStreak: row.handleMismatchStreak,
    handleSampledAt: row.liveHandleCount === null && row.sampledSlotCount === null ? null : row.heartbeatAt,
    protocolCapabilities: row.protocolCapabilities ?? [],
  }
}

function registrationValues(input: {
  instanceId: string
  capacity: number
  maxSessions?: number
  lostAfterSeconds: number
  protocolCapabilities?: string[]
  internalBaseUrl?: string | null
  now: Date
}) {
  const expires = new Date(input.now.getTime() + input.lostAfterSeconds * 1000)
  return {
    instanceId: input.instanceId,
    status: 'READY' as const,
    capacity: input.capacity,
    maxSessions: input.maxSessions ?? DEFAULT_BROWSER_MAX_SESSIONS,
    heartbeatAt: input.now,
    startedAt: input.now,
    updatedAt: input.now,
    stoppedAt: null,
    internalBaseUrl: input.internalBaseUrl ?? null,
    lostAfterSeconds: input.lostAfterSeconds,
    heartbeatExpiresAt: expires,
    liveHandleCount: null,
    sampledSlotCount: null,
    handleMismatchStreak: 0,
    protocolCapabilities: input.protocolCapabilities ?? [],
  }
}

function canTakeOver(existing: WorkerRow, now: Date): boolean {
  if (existing.status === 'STOPPED') return true
  if (!existing.heartbeatExpiresAt) return false
  return existing.heartbeatExpiresAt.getTime() <= now.getTime()
}

async function isolateOrphanedSessionsTx(
  tx: Db,
  workerId: string,
  currentInstanceId: string,
): Promise<number> {
  const { browserSessions, sessionLeases, workers } = schemaFor(tx)
  const [current] = await locked(
    tx,
    tx.select({ instanceId: workers.instanceId }).from(workers).where(eq(workers.id, workerId)),
  )
  if (!current || current.instanceId !== currentInstanceId) return 0
  const now = await clockNow(tx)
  const rows = await updateRows(
    tx,
    browserSessions,
    {
      status: 'LOST',
      updatedAt: now,
      closeReason: 'owner_instance_replaced',
      version: sql`${browserSessions.version} + 1`,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      authControlEpoch: sql`${browserSessions.authControlEpoch} + 1`,
    },
    and(
      eq(browserSessions.ownerWorkerId, workerId),
      inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      or(
        isNull(browserSessions.ownerWorkerInstanceId),
        sql`${browserSessions.ownerWorkerInstanceId} <> ${currentInstanceId}`,
      ),
    ),
    { id: browserSessions.id },
  )
  if (rows.length > 0) {
    const sessionIds = rows.map((row) => row.id)
    // AUTH_WAIT 留给 reapSessionLeases 走 holder-lost：立刻到期，但不先 REVOKED，
    // 否则统一回收器看不见 ACTIVE 租约，等待中的 Run 会永远停在 WAITING_FOR_AUTH。
    await updateRows(
      tx,
      sessionLeases,
      { expiresAt: now, heartbeatAt: now },
      and(
        eq(sessionLeases.status, 'ACTIVE'),
        eq(sessionLeases.purpose, 'AUTH_WAIT'),
        inArray(sessionLeases.sessionId, sessionIds),
      ),
    )
    await updateRows(
      tx,
      sessionLeases,
      {
        status: 'REVOKED',
        releasedAt: now,
        releaseReason: 'owner_instance_replaced',
      },
      and(
        eq(sessionLeases.status, 'ACTIVE'),
        ne(sessionLeases.purpose, 'AUTH_WAIT'),
        inArray(sessionLeases.sessionId, sessionIds),
      ),
    )
  }
  return rows.length
}

function toGrant(
  row: Pick<RunLeaseRow, 'id' | 'runId' | 'fencingToken' | 'holderWorkerId' | 'expiresAt'>,
): RunGrant {
  return runGrantSchema.parse({
    runId: row.runId,
    leaseId: row.id,
    fencingToken: row.fencingToken,
    holderWorkerId: row.holderWorkerId,
    expiresAt: row.expiresAt.toISOString(),
  })
}

export async function registerWorker(
  db: Db,
  input: {
    workerId: string
    instanceId: string
    capacity: number
    maxSessions?: number
    lostAfterSeconds: number
    protocolCapabilities?: string[]
    internalBaseUrl?: string | null
  },
): Promise<RegisterWorkerResult> {
  const { runLeases, workers } = schemaFor(db)
  return db
    .transaction(async (tx) => {
      const [existing] = await locked(
        tx,
        tx.select().from(workers).where(eq(workers.id, input.workerId)),
      )
      const now = await clockNow(tx as unknown as Db)
      const values = registrationValues({ ...input, now })

      if (!input.protocolCapabilities?.includes('session-occupancy@2')) {
        throw conflict('WORKER_PROTOCOL_UNSUPPORTED', 'Worker 未声明 session-occupancy@2')
      }

      if (existing && existing.instanceId === input.instanceId) {
        const [row] = await tx.select().from(workers).where(eq(workers.id, input.workerId)).limit(1)
        return { worker: toWorker(row!), revokedRunIds: [] }
      }

      if (existing && existing.instanceId !== input.instanceId && !canTakeOver(existing, now)) {
        throw conflict(WORKER_ID_CONFLICT, `Worker ${input.workerId} 仍有有效登记`)
      }

      if (!existing) {
        await tx.insert(workers).values({
          id: input.workerId,
          ...values,
        })
      } else {
        await tx.update(workers).set(values).where(eq(workers.id, input.workerId))
        await isolateOrphanedSessionsTx(tx as unknown as Db, input.workerId, input.instanceId)
      }

      const revoked = await updateRows(
        tx,
        runLeases,
        {
          status: 'REVOKED',
          releasedAt: now,
          releaseReason: 'worker_restart',
        },
        and(eq(runLeases.holderWorkerId, input.workerId), eq(runLeases.status, 'ACTIVE')),
        { runId: runLeases.runId },
      )

      const [row] = await tx.select().from(workers).where(eq(workers.id, input.workerId)).limit(1)
      return { worker: toWorker(row!), revokedRunIds: revoked.map((item) => item.runId) }
    })
    .catch((error: unknown) => {
      // Two first registrations may both see no row; the primary key chooses the owner.
      if (isUniqueViolation(error))
        throw conflict(WORKER_ID_CONFLICT, `Worker ${input.workerId} 已被另一个实例注册`)
      throw error
    })
}

/**
 * 心跳结果。两种失败原因的处置完全不同，所以不能压成一个 boolean：
 *
 * - `lost`：行不在，或状态已不是 `READY`（被同伴判失联）。本实例仍是这个 ID 的登记者，
 *   允许用新的 `instance_id` 重新注册自愈。
 * - `instance_taken`：这个 Worker ID 已经属于另一个活实例。按 D4「同 ID 只能有一个活实例」，
 *   不得抢回，本进程只能退出。
 */
export type WorkerHeartbeatOutcome = 'ok' | 'lost' | 'instance_taken'

export async function heartbeatWorker(
  db: Db,
  workerId: string,
  instanceId: string,
  telemetry?: { internalBaseUrl?: string | null; liveHandleCount?: number | null },
): Promise<WorkerHeartbeatOutcome> {
  const { workers, browserSessions } = schemaFor(db)
  return db.transaction(async (tx) => {
    const [current] = await locked(
      tx,
      tx.select().from(workers).where(eq(workers.id, workerId)),
    )
    const now = await clockNow(tx as unknown as Db)
    if (!current) return 'lost'
    if (current.instanceId !== instanceId) return 'instance_taken'
    if (current.status !== 'READY') return 'lost'
    if (!current.heartbeatExpiresAt || current.heartbeatExpiresAt.getTime() <= now.getTime()) {
      return 'lost'
    }
    const lostAfter = current.lostAfterSeconds
    if (!lostAfter) return 'lost'

    const occupied = await tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, workerId),
          inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
        ),
      )
    const liveHandleCount = telemetry?.liveHandleCount ?? null
    const sampledSlotCount = liveHandleCount === null ? null : occupied.length
    const streak = nextHandleMismatchStreak({
      previous: current.handleMismatchStreak,
      liveHandleCount,
      sampledSlotCount,
    })

    const [row] = await updateRows(
      tx,
      workers,
      {
        heartbeatAt: now,
        heartbeatExpiresAt: new Date(now.getTime() + lostAfter * 1000),
        updatedAt: now,
        internalBaseUrl: telemetry?.internalBaseUrl ?? current.internalBaseUrl,
        liveHandleCount,
        sampledSlotCount,
        handleMismatchStreak: streak,
      },
      and(
        eq(workers.id, workerId),
        eq(workers.instanceId, instanceId),
        eq(workers.status, 'READY'),
        sql`${workers.heartbeatExpiresAt} > ${databaseNow(tx as unknown as Db)}`,
      ),
      { id: workers.id },
    )
    return row ? 'ok' : 'lost'
  })
}

export async function getWorkerById(db: Db, workerId: string): Promise<WorkerRecord | null> {
  const { workers } = schemaFor(db)
  const [row] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1)
  return row ? toWorker(row) : null
}

export async function markWorkerDraining(
  db: Db,
  workerId: string,
  instanceId: string,
): Promise<boolean> {
  const { workers } = schemaFor(db)
  const now = await clockNow(db)
  const [row] = await updateRows(
    db,
    workers,
    { status: 'DRAINING', updatedAt: now },
    and(eq(workers.id, workerId), eq(workers.instanceId, instanceId), eq(workers.status, 'READY')),
    { id: workers.id },
  )
  return row !== undefined
}

export async function markWorkerStopped(
  db: Db,
  workerId: string,
  instanceId: string,
): Promise<boolean> {
  const { workers } = schemaFor(db)
  const now = await clockNow(db)
  const [row] = await updateRows(
    db,
    workers,
    { status: 'STOPPED', stoppedAt: now, updatedAt: now },
    and(
      eq(workers.id, workerId),
      eq(workers.instanceId, instanceId),
      inArray(workers.status, ['READY', 'DRAINING']),
    ),
    { id: workers.id },
  )
  return row !== undefined
}

export async function markLostWorkers(db: Db, _lostAfterSeconds?: number): Promise<string[]> {
  const { workers } = schemaFor(db)
  const now = new Date()
  const rows = await updateRows(
    db,
    workers,
    { status: 'LOST', updatedAt: now, stoppedAt: now },
    sql`${workers.status} IN ('READY', 'DRAINING')
        AND ${workers.heartbeatExpiresAt} IS NOT NULL
        AND ${workers.heartbeatExpiresAt} <= ${databaseNow(db)}`,
    { id: workers.id },
  )
  return rows.map((row) => row.id)
}

export async function isolateOrphanedSessions(
  db: Db,
  workerId: string,
  currentInstanceId: string,
): Promise<number> {
  return db.transaction((tx) =>
    isolateOrphanedSessionsTx(tx as unknown as Db, workerId, currentInstanceId),
  )
}

export async function lockRunRow(tx: Db, runId: string) {
  const { runs } = schemaFor(tx)
  const [row] = await locked(
    tx,
    tx
      .select({
        id: runs.id,
        status: runs.status,
        cancelRequestedAt: runs.cancelRequestedAt,
        updatedAt: runs.updatedAt,
        eventSeq: runs.eventSeq,
        authCheckpoint: runs.authCheckpoint,
        deadlineAt: runs.deadlineAt,
        context: runs.context,
      })
      .from(runs)
      .where(and(eq(runs.id, runId), isNull(runs.deletedAt))),
  )
  return row ?? null
}

export async function verifyRunLeaseForWrite(tx: Db, grant: RunGrant): Promise<boolean> {
  const { runLeases } = schemaFor(tx)
  const [row] = await tx
    .select({ id: runLeases.id })
    .from(runLeases)
    .where(
      and(
        eq(runLeases.id, grant.leaseId),
        eq(runLeases.runId, grant.runId),
        eq(runLeases.fencingToken, grant.fencingToken),
        eq(runLeases.holderWorkerId, grant.holderWorkerId),
        eq(runLeases.status, 'ACTIVE'),
        sql`${runLeases.expiresAt} > ${databaseNow(tx)}`,
      ),
    )
    .limit(1)
  return row !== undefined
}

async function markMapJobWindowClosed(tx: Db, jobId: string): Promise<void> {
  const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, jobId)))
  if (!job || job.jobStatus === 'cancelled' || job.jobStatus === 'completed' || job.jobStatus === 'failed') return
  const now = await clockNow(tx)
  await tx
    .update(mapJobs)
    .set({ jobStatus: 'cancelled', stopReason: 'window_closed', activeGuard: null, updatedAt: now })
    .where(eq(mapJobs.id, jobId))
}

async function hasClaimableUserRunOnKey(
  tx: Db,
  run: { id: string; targetId: string; targetAccountId: string | null; snapshot: RunSnapshot },
): Promise<boolean> {
  if (!run.targetAccountId || !isMapJobRun(run.snapshot)) return false
  const { runs, runLeases } = schemaFor(tx)
  const rows = await tx
    .select({ id: runs.id, snapshot: runs.snapshot })
    .from(runs)
    .where(
      and(
        eq(runs.targetId, run.targetId),
        eq(runs.targetAccountId, run.targetAccountId),
        inArray(runs.status, ['QUEUED', 'RECOVERING']),
        isNull(runs.deletedAt),
        isNull(runs.cancelRequestedAt),
        ne(runs.id, run.id),
      ),
    )
  for (const row of rows) {
    if (isMapJobRun(row.snapshot as RunSnapshot)) continue
    const [lease] = await tx
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(and(eq(runLeases.runId, row.id), eq(runLeases.status, 'ACTIVE')))
      .limit(1)
    if (!lease) return true
  }
  return false
}

export async function claimRun(
  handle: DbHandle,
  input: {
    workerId: string
    instanceId: string
    leaseTtlSeconds: number
    excludeRunIds?: string[]
  },
): Promise<RunGrant | null> {
  const db = handle.db
  await expireRunDeadlines(db)
  const { runs, browserSessions, runLeases, workers } = schemaFor(db)
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const [worker] = await locked(
      tx,
      tx
        .select()
        .from(workers)
        .where(
          and(
            eq(workers.id, input.workerId),
            eq(workers.instanceId, input.instanceId),
            eq(workers.status, 'READY'),
          ),
        ),
    )
    if (!worker) return null
    let scheduling
    try {
      ;({ scheduling } = await readSessionScheduling(tx))
    } catch {
      return null
    }
    const held = await tx
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(
        and(
          eq(runLeases.holderWorkerId, input.workerId),
          eq(runLeases.status, 'ACTIVE'),
          sql`${runLeases.expiresAt} > ${databaseNow(tx)}`,
        ),
      )
    if (held.length >= worker.capacity) return null
    const skipped = new Set(input.excludeRunIds ?? [])
    for (const status of ['RECOVERING', 'QUEUED'] as const) {
      for (;;) {
        const exclude = [...skipped]
        // Lock only Run rows; correlated predicates avoid outer-join lock differences.
        const [run] = await locked(
          tx,
          tx
            .select({
              id: runs.id,
              createdAt: runs.createdAt,
              targetId: runs.targetId,
              targetAccountId: runs.targetAccountId,
              snapshot: runs.snapshot,
            })
            .from(runs)
            .where(
              and(
                eq(runs.status, status),
                isNull(runs.deletedAt),
                isNull(runs.cancelRequestedAt),
                or(isNull(runs.deadlineAt), sql`${runs.deadlineAt} > ${databaseNow(tx)}`),
                exclude.length ? notInArray(runs.id, exclude) : undefined,
                worker.protocolCapabilities?.includes('snapshot.moduleManifest@1')
                  ? undefined
                  : not(jsonHasKey(tx, runs.snapshot, 'moduleManifest')),
                worker.protocolCapabilities?.includes('snapshot.candidateGroups@1')
                  ? undefined
                  : not(jsonHasKey(tx, runs.snapshot, 'candidateGroups')),
                worker.protocolCapabilities?.includes(MAP_JOBS_PROTOCOL)
                  ? undefined
                  : not(jsonHasKey(tx, runs.snapshot, 'mapJob')),
                worker.protocolCapabilities?.includes(OUTCOME_MANIFEST_PROTOCOL)
                  ? undefined
                  : not(jsonHasKey(tx, runs.snapshot, 'outcomeManifest')),
                worker.protocolCapabilities?.includes(RUNTIME_INVARIANT_MANIFEST_PROTOCOL)
                  ? undefined
                  : not(jsonHasKey(tx, runs.snapshot, 'runtimeInvariantManifest')),
                sql`NOT EXISTS (SELECT 1 FROM ${runLeases} l WHERE l.run_id = ${runs.id} AND l.status = 'ACTIVE')`,
                or(
                  isNull(runs.targetAccountId),
                  sql`NOT EXISTS (
          SELECT 1 FROM ${browserSessions} s
           WHERE s.target_id = ${runs.targetId} AND s.target_account_id = ${runs.targetAccountId}
             AND s.status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
             AND NOT (s.status = 'OPEN' AND s.owner_worker_id = ${input.workerId})
        )`,
                ),
              ),
            )
            .orderBy(asc(runs.createdAt), asc(runs.id))
            .limit(1),
          true,
        )
        if (!run) break
        skipped.add(run.id)
        const snapshot = run.snapshot as RunSnapshot
        if (isMapJobRun(snapshot)) {
          const startBefore = snapshot.mapJob.startBefore
          if (startBefore) {
            const now = await clockNow(tx)
            if (Date.parse(startBefore) <= now.getTime()) {
              await markMapJobWindowClosed(tx, snapshot.mapJob.jobId)
              continue
            }
          }
          if (await hasClaimableUserRunOnKey(tx, { ...run, snapshot })) continue
        }
        const eligibility = await evaluateRunSessionEligibility(tx, {
          run: {
            id: run.id,
            createdAt: run.createdAt,
            targetId: run.targetId,
            targetAccountId: run.targetAccountId,
          },
          workerId: input.workerId,
          instanceId: input.instanceId,
          maxSessions: worker.maxSessions,
          scheduling,
        })
        if (!eligibility.eligible) continue
        await tx
          .update(runs)
          .set({
            status: 'RUNNING',
            startedAt: sql`COALESCE(${runs.startedAt}, ${databaseNow(tx)})`,
            updatedAt: databaseNow(tx),
          })
          .where(eq(runs.id, run.id))
        await appendRunEvents(tx, run.id, [
          { type: 'run.status_changed', payload: { status: 'RUNNING' } },
        ])
        const [max] = await tx
          .select({ token: sql<number>`COALESCE(MAX(${runLeases.fencingToken}), 0) + 1` })
          .from(runLeases)
          .where(eq(runLeases.runId, run.id))
        const [lease] = await insertRows(tx, runLeases, {
          id: newId(),
          runId: run.id,
          fencingToken: Number(max!.token),
          holderWorkerId: input.workerId,
          status: 'ACTIVE',
          expiresAt: afterSeconds(tx, input.leaseTtlSeconds),
        })
        return toGrant(lease!)
      }
    }
    return null
  })
}

export async function renewRunLease(
  db: Db,
  grant: RunGrant,
  leaseTtlSeconds: number,
): Promise<Date | null> {
  const { runLeases } = schemaFor(db)
  const [row] = await updateRows(
    db,
    runLeases,
    {
      expiresAt: afterSeconds(db, leaseTtlSeconds),
      heartbeatAt: databaseNow(db),
    },
    and(
      eq(runLeases.id, grant.leaseId),
      eq(runLeases.runId, grant.runId),
      eq(runLeases.fencingToken, grant.fencingToken),
      eq(runLeases.holderWorkerId, grant.holderWorkerId),
      eq(runLeases.status, 'ACTIVE'),
      sql`${runLeases.expiresAt} > ${databaseNow(db)}`,
    ),
    { expiresAt: runLeases.expiresAt },
  )
  return row?.expiresAt ?? null
}

/**
 * 释放租约。
 *
 * `'unknown'` = 这份租约已经不是本持有者的 ACTIVE 租约（被判过期、被撤销、或压根不存在），
 * 本次释放没有改动任何事实。之前这里把"行还在"也算成 `'released'`，等于把"我早就丢租了"
 * 报成"我正常交回了"——调用方再想区分也区分不出来。
 */
export async function releaseRunLeaseTx(
  tx: Db,
  grant: RunGrant,
  reason: string,
): Promise<'released' | 'unknown'> {
  const { runLeases } = schemaFor(tx)
  const now = new Date()
  const [row] = await updateRows(
    tx,
    runLeases,
    { status: 'RELEASED', releasedAt: now, releaseReason: reason },
    and(
      eq(runLeases.id, grant.leaseId),
      eq(runLeases.holderWorkerId, grant.holderWorkerId),
      eq(runLeases.status, 'ACTIVE'),
    ),
    { id: runLeases.id },
  )
  return row ? 'released' : 'unknown'
}

export async function findActiveLeaseForRun(db: Db, runId: string): Promise<RunGrant | null> {
  const { runLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.status, 'ACTIVE')))
    .limit(1)
  return row ? toGrant(row) : null
}

export async function listActiveLeasesForWorker(db: Db, workerId: string): Promise<RunGrant[]> {
  const { runLeases } = schemaFor(db)
  const rows = await db
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.holderWorkerId, workerId), eq(runLeases.status, 'ACTIVE')))
  return rows.map((row) => toGrant(row))
}

export async function listActiveLeasesByRunIds(
  db: Db,
  runIds: string[],
): Promise<Map<string, RunGrant>> {
  const { runLeases } = schemaFor(db)
  const out = new Map<string, RunGrant>()
  if (runIds.length === 0) return out
  const rows = await db
    .select()
    .from(runLeases)
    .where(and(inArray(runLeases.runId, runIds), eq(runLeases.status, 'ACTIVE')))
  for (const row of rows) out.set(row.runId, toGrant(row))
  return out
}

export async function listExpiredActiveLeases(
  db: Db,
  limit: number,
): Promise<Array<{ leaseId: string; runId: string }>> {
  const { runLeases } = schemaFor(db)
  const rows = await db
    .select({ leaseId: runLeases.id, runId: runLeases.runId })
    .from(runLeases)
    .where(and(eq(runLeases.status, 'ACTIVE'), sql`${runLeases.expiresAt} <= ${databaseNow(db)}`))
    .orderBy(runLeases.expiresAt)
    .limit(limit)
  return rows
}

export async function expireLeaseIfDue(tx: Db, leaseId: string): Promise<boolean> {
  const { runLeases } = schemaFor(tx)
  const now = new Date()
  const [row] = await updateRows(
    tx,
    runLeases,
    { status: 'EXPIRED', releasedAt: now, releaseReason: 'lease_expired' },
    and(
      eq(runLeases.id, leaseId),
      eq(runLeases.status, 'ACTIVE'),
      sql`${runLeases.expiresAt} <= ${databaseNow(tx)}`,
    ),
    { id: runLeases.id },
  )
  return row !== undefined
}

export async function countFailedRecoveries(tx: Db, runId: string): Promise<number> {
  const { runLeases } = schemaFor(tx)
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), sql`${runLeases.status} IN ('EXPIRED', 'REVOKED')`))
  return Number(row?.n ?? 0)
}

export async function listDriftedRunningIds(
  db: Db,
  leaseTtlSeconds: number,
  limit: number,
): Promise<string[]> {
  const { runs, runLeases } = schemaFor(db)
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        or(eq(runs.status, 'RUNNING'), eq(runs.status, 'HOLDING')),
        sql`${runs.updatedAt} < ${afterSeconds(db, -leaseTtlSeconds)}`,
        sql`NOT EXISTS (SELECT 1 FROM ${runLeases} l WHERE l.run_id = ${runs.id} AND l.status = 'ACTIVE')`,
      ),
    )
    .orderBy(runs.updatedAt, runs.id)
    .limit(limit)
  return rows.map((row) => row.id)
}

export function isFinishedOrNeedsReview(status: RunStatus): boolean {
  return isFinishedRunStatus(status) || status === 'NEEDS_REVIEW'
}

export type { RunLeaseRow, WorkerRow }
