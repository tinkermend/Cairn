import type { RunLeaseRow, WorkerRow } from '../records.js'
import { scheduledStartDeadlineExpired } from '../runs/deadline.js'
import { schemaFor } from '../native.js'
import { updateRows, updateRowsCount } from '../native.js'
import { and, asc, eq, gt, inArray, isNull, ne, not, or, sql } from 'drizzle-orm'
import {
  DEFAULT_BROWSER_MAX_SESSIONS,
  AI_ATOMIC_ACTIONS_PROTOCOL,
  LIST_OUTPUT_PROTOCOL,
  AI_TASK_EVIDENCE_PROTOCOL,
  IMPORTED_OUTCOME_PROTOCOL,
  MAP_CONSUMPTION_PROTOCOL,
  MAP_JOBS_PROTOCOL,
  OUTCOME_MANIFEST_PROTOCOL,
  SUITE_ADMISSION_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
  RESOLUTION_PROTOCOL,
  CONTROL_FLOW_PROTOCOL,
  CONTROL_FLOW_PROTOCOL_V2,
  SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  registrationRequiresOccupancy,
  isFinishedRunStatus,
  nextHandleMismatchStreak,
  runGrantSchema,
  type RunGrant,
  type RunLeaseErrorCode,
  type RunSnapshot,
  type RunStatus,
  type WorkerStatus,
} from '@cairn/shared'
import { appendRunEvents } from '../observe/events.js'
import { conflict, isUniqueViolation, notFound } from '../runs/errors.js'
import type { Db, DbHandle } from '../client.js'
import { newId } from '../id.js'
import { runs } from '../schema/execution.js'
import { locked, databaseNow, afterSeconds, clockNow, driverOf, insertRows, jsonHasKey, jsonText, jsonTextEquals } from '../native.js'
import type { IsolatedLostRow } from '../sessions/lost-disposition.js'
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
  listenHost: string | null
  listenPort: number | null
  hostname: string | null
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
    listenHost: row.listenHost ?? null,
    listenPort: row.listenPort ?? null,
    hostname: row.hostname ?? null,
  }
}

function registrationValues(input: {
  instanceId: string
  capacity: number
  maxSessions?: number
  lostAfterSeconds: number
  protocolCapabilities?: string[]
  internalBaseUrl?: string | null
  listenHost?: string | null
  listenPort?: number | null
  hostname?: string | null
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
    sampledRssBytes: null,
    sampledEventLoopDelayMs: null,
    sampledCpuPercent: null,
    sampledProfileBytes: null,
    sampledProfileCount: null,
    sampledProfileDiskFreeBytes: null,
    sampledMidsceneBytes: null,
    sampledBrowserProcessCount: null,
    processClockSkewMs: null,
    sampledDiskAt: null,
    listenHost: input.listenHost ?? null,
    listenPort: input.listenPort ?? null,
    hostname: input.hostname ?? null,
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
): Promise<IsolatedLostRow[]> {
  const { browserSessions, sessionLeases, workers } = schemaFor(tx)
  const [current] = await locked(
    tx,
    tx.select({ instanceId: workers.instanceId }).from(workers).where(eq(workers.id, workerId)),
  )
  if (!current || current.instanceId !== currentInstanceId) return []
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
    {
      id: browserSessions.id,
      targetId: browserSessions.targetId,
      targetAccountId: browserSessions.targetAccountId,
      generation: browserSessions.generation,
      closeReason: browserSessions.closeReason,
    },
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
  return rows.map((row) => ({
    id: row.id,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    generation: row.generation,
    closeReason: row.closeReason,
  }))
}

async function finishIsolatedSessions(tx: Db, rows: IsolatedLostRow[]): Promise<void> {
  if (rows.length === 0) return
  const { recordIsolatedSessionLoss, applyAutoLostDisposition } = await import(
    '../sessions/lost-disposition.js'
  )
  await recordIsolatedSessionLoss(tx, rows)
  await applyAutoLostDisposition(tx, rows)
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
    listenHost?: string | null
    listenPort?: number | null
    hostname?: string | null
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

      if (
        registrationRequiresOccupancy(input.protocolCapabilities) &&
        !input.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL)
      ) {
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
        await finishIsolatedSessions(
          tx as unknown as Db,
          await isolateOrphanedSessionsTx(tx as unknown as Db, input.workerId, input.instanceId),
        )
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

export type WorkerHeartbeatTelemetry = {
  internalBaseUrl?: string | null
  liveHandleCount?: number | null
  rssBytes?: number | null
  eventLoopDelayMs?: number | null
  cpuPercent?: number | null
  profileBytes?: number | null
  profileCount?: number | null
  profileDiskFreeBytes?: number | null
  midsceneBytes?: number | null
  browserProcessCount?: number | null
  clockSkewMs?: number | null
  diskSampledAt?: Date | null
  listenHost?: string | null
  listenPort?: number | null
  hostname?: string | null
}

export async function heartbeatWorker(
  db: Db,
  workerId: string,
  instanceId: string,
  telemetry?: WorkerHeartbeatTelemetry,
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
    if (current.status !== 'READY' && current.status !== 'DISABLED') return 'lost'
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
      browserProcessCount: telemetry?.browserProcessCount ?? null,
    })

    // 只判是否命中 CAS，不读回实体：MySQL 下省掉 SELECT FOR UPDATE + 回读两次往返。
    const updated = await updateRowsCount(
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
        sampledRssBytes: telemetry?.rssBytes ?? null,
        sampledEventLoopDelayMs: telemetry?.eventLoopDelayMs ?? null,
        sampledCpuPercent: telemetry?.cpuPercent ?? null,
        sampledProfileBytes: telemetry?.profileBytes ?? null,
        sampledProfileCount: telemetry?.profileCount ?? null,
        sampledProfileDiskFreeBytes: telemetry?.profileDiskFreeBytes ?? null,
        sampledMidsceneBytes: telemetry?.midsceneBytes ?? null,
        sampledBrowserProcessCount: telemetry?.browserProcessCount ?? null,
        processClockSkewMs: Date.now() - now.getTime(),
        sampledDiskAt: telemetry?.diskSampledAt ?? null,
        ...(telemetry?.listenHost !== undefined ? { listenHost: telemetry.listenHost } : {}),
        ...(telemetry?.listenPort !== undefined ? { listenPort: telemetry.listenPort } : {}),
        ...(telemetry?.hostname !== undefined ? { hostname: telemetry.hostname } : {}),
      },
      and(
        eq(workers.id, workerId),
        eq(workers.instanceId, instanceId),
        inArray(workers.status, ['READY', 'DISABLED']),
        sql`${workers.heartbeatExpiresAt} > ${databaseNow(tx as unknown as Db)}`,
      ),
    )
    return updated > 0 ? 'ok' : 'lost'
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
  return (
    (await updateRowsCount(
      db,
      workers,
      { status: 'DRAINING', updatedAt: now },
      and(eq(workers.id, workerId), eq(workers.instanceId, instanceId), eq(workers.status, 'READY')),
    )) > 0
  )
}

export async function markWorkerStopped(
  db: Db,
  workerId: string,
  instanceId: string,
): Promise<boolean> {
  const { workers } = schemaFor(db)
  const now = await clockNow(db)
  return (
    (await updateRowsCount(
      db,
      workers,
      { status: 'STOPPED', stoppedAt: now, updatedAt: now },
      and(
        eq(workers.id, workerId),
        eq(workers.instanceId, instanceId),
        inArray(workers.status, ['READY', 'DRAINING', 'DISABLED']),
      ),
    )) > 0
  )
}

export async function markLostWorkers(db: Db, _lostAfterSeconds?: number): Promise<string[]> {
  const { workers } = schemaFor(db)
  const now = new Date()
  const rows = await updateRows(
    db,
    workers,
    { status: 'LOST', updatedAt: now, stoppedAt: now },
    sql`${workers.status} IN ('READY', 'DRAINING', 'DISABLED')
        AND ${workers.heartbeatExpiresAt} IS NOT NULL
        AND ${workers.heartbeatExpiresAt} <= ${databaseNow(db)}`,
    { id: workers.id },
  )
  return rows.map((row) => row.id)
}

export async function disableWorker(db: Db, workerId: string): Promise<WorkerRecord> {
  const { workers } = schemaFor(db)
  const now = await clockNow(db)
  return db.transaction(async (tx) => {
    const [worker] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1)
    if (!worker) throw notFound('WORKER_NOT_FOUND', '执行节点不存在')
    if (worker.status !== 'READY') {
      throw conflict('INVALID_WORKER_STATUS', `节点当前状态为 ${worker.status}，仅就绪节点允许禁用`)
    }
    await tx.update(workers).set({ status: 'DISABLED', updatedAt: now }).where(eq(workers.id, workerId))
    const [updated] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1)
    return toWorker(updated!)
  })
}

export async function enableWorker(db: Db, workerId: string): Promise<WorkerRecord> {
  const { workers } = schemaFor(db)
  const now = await clockNow(db)
  return db.transaction(async (tx) => {
    const [worker] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1)
    if (!worker) throw notFound('WORKER_NOT_FOUND', '执行节点不存在')
    if (worker.status !== 'DISABLED') {
      throw conflict('INVALID_WORKER_STATUS', `节点当前状态为 ${worker.status}，仅已禁用节点允许启用`)
    }
    const fresh = Boolean(worker.heartbeatExpiresAt && worker.heartbeatExpiresAt.getTime() > now.getTime())
    if (!fresh) {
      throw conflict('HEARTBEAT_EXPIRED', '节点心跳已过期，请先在服务器启动该 Worker 进程')
    }
    await tx.update(workers).set({ status: 'READY', updatedAt: now }).where(eq(workers.id, workerId))
    const [updated] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1)
    return toWorker(updated!)
  })
}

export async function deregisterWorker(db: Db, workerId: string): Promise<void> {
  const { workers, browserSessions, runLeases } = schemaFor(db)
  const now = await clockNow(db)
  await db.transaction(async (tx) => {
    const [worker] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1)
    if (!worker) throw notFound('WORKER_NOT_FOUND', '执行节点不存在')

    const activeLeases = await tx
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(and(eq(runLeases.holderWorkerId, workerId), eq(runLeases.status, 'ACTIVE'), gt(runLeases.expiresAt, now)))
    if (activeLeases.length > 0) {
      throw conflict('WORKER_HAS_ACTIVE_TASKS', `当前节点有正在运行的任务（${activeLeases.length} 个在跑），不允许删除`)
    }

    const activeSessions = await tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(and(eq(browserSessions.ownerWorkerId, workerId), inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING'])))
    if (activeSessions.length > 0) {
      throw conflict('WORKER_HAS_ACTIVE_TASKS', `当前节点有活跃的浏览器会话（${activeSessions.length} 个），不允许删除`)
    }

    const fresh = Boolean(worker.heartbeatExpiresAt && worker.heartbeatExpiresAt.getTime() > now.getTime())
    if (worker.status === 'READY' && fresh) {
      throw conflict('WORKER_IS_ACTIVE', '当前节点正在正常运行中，若要删除请先将节点【禁用】或停止 Worker 进程')
    }

    await tx.delete(workers).where(eq(workers.id, workerId))
  })
}

export async function purgeStaleWorkers(db: Db): Promise<{ purgedCount: number; purgedWorkerIds: string[] }> {
  const { workers, browserSessions, runLeases } = schemaFor(db)
  const now = await clockNow(db)
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(workers)
      .where(inArray(workers.status, ['STOPPED', 'LOST']))

    const toDelete: string[] = []
    for (const w of candidates) {
      const activeLeases = await tx
        .select({ id: runLeases.id })
        .from(runLeases)
        .where(and(eq(runLeases.holderWorkerId, w.id), eq(runLeases.status, 'ACTIVE'), gt(runLeases.expiresAt, now)))
      if (activeLeases.length > 0) continue

      const activeSessions = await tx
        .select({ id: browserSessions.id })
        .from(browserSessions)
        .where(and(eq(browserSessions.ownerWorkerId, w.id), inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING'])))
      if (activeSessions.length > 0) continue

      const fresh = Boolean(w.heartbeatExpiresAt && w.heartbeatExpiresAt.getTime() > now.getTime())
      if (w.status === 'DISABLED' && fresh) continue

      toDelete.push(w.id)
    }

    if (toDelete.length > 0) {
      await tx.delete(workers).where(inArray(workers.id, toDelete))
    }

    return { purgedCount: toDelete.length, purgedWorkerIds: toDelete }
  })
}

export async function isolateOrphanedSessions(
  db: Db,
  workerId: string,
  currentInstanceId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const isolated = await isolateOrphanedSessionsTx(
      tx as unknown as Db,
      workerId,
      currentInstanceId,
    )
    await finishIsolatedSessions(tx as unknown as Db, isolated)
    return isolated.length
  })
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

export const CLAIM_SCAN_LIMIT = 64
export const CLAIM_EXCLUDE_LIMIT = 64
const CLAIM_WINDOW_SIZE = 32

export type ClaimScanKey = { createdAt: string; id: string }
export type ClaimScanCursor = { RECOVERING: ClaimScanKey | null; QUEUED: ClaimScanKey | null }
export type ClaimRunResult = {
  grant: RunGrant | null
  cursor: ClaimScanCursor
  reason: 'claimed' | 'idle' | 'budget_exhausted' | 'unavailable'
}

export type ClaimRunDiagnostics = {
  /** SQL 资格筛选后，进入应用层尝试的候选数；延续原监控口径。 */
  scanned: number
  /** 按索引窗口读出的原始 Run 数；不是 PostgreSQL 的实际访问行数。 */
  windowRows: number
  windows: number
  candidateSqlMs: number
  totalMs: number
  reason: ClaimRunResult['reason'] | null
  excluded: number
  selected: boolean
  recorded: boolean
}

let lastClaimDiagnostics: ClaimRunDiagnostics = {
  scanned: 0, windowRows: 0, windows: 0, candidateSqlMs: 0,
  totalMs: 0, reason: null, excluded: 0, selected: false, recorded: false,
}

export function takeLastClaimDiagnostics(): ClaimRunDiagnostics {
  return { ...lastClaimDiagnostics }
}

function mapJobStartBefore(tx: Db) {
  const { runs } = schemaFor(tx)
  return jsonText(tx, runs.snapshot, ['mapJob', 'startBefore'])
}

function mapJobJobId(tx: Db) {
  const { runs } = schemaFor(tx)
  return jsonText(tx, runs.snapshot, ['mapJob', 'jobId'])
}

function claimCursorTimestamp(tx: Db) {
  const { runs } = schemaFor(tx)
  return driverOf(tx) === 'mysql'
    ? sql<string>`CAST(${runs.createdAt} AS CHAR(64))`
    : sql<string>`CAST(${runs.createdAt} AS TEXT)`
}

function jsonTextCompare(tx: Db, left: ReturnType<typeof jsonText>, op: '<=' | '>', right: string) {
  if (driverOf(tx) === 'mysql') {
    return op === '<='
      ? sql`(${left} COLLATE utf8mb4_bin) <= (${right} COLLATE utf8mb4_bin)`
      : sql`(${left} COLLATE utf8mb4_bin) > (${right} COLLATE utf8mb4_bin)`
  }
  return op === '<=' ? sql`${left} <= ${right}` : sql`${left} > ${right}`
}

function suiteAdmissionPredicate(tx: Db) {
  const { runs, suiteRunItems, suiteRuns } = schemaFor(tx)
  return sql`(
    ${runs.executionOrigin} <> 'suite_member'
    OR EXISTS (
      SELECT 1 FROM ${suiteRunItems} admitted
      INNER JOIN ${suiteRuns} parent ON parent.id = admitted.suite_run_id
      WHERE admitted.child_run_id = ${runs.id}
        AND admitted.admission_status = 'ACTIVE'
        AND parent.cancel_requested_at IS NULL
        AND parent.status IN ('QUEUED', 'RUNNING', 'WAITING')
        AND parent.deadline_at > ${new Date()}
    )
  )`
}

function mapJobYieldPredicate(tx: Db) {
  const { runLeases, runs, suiteRunItems } = schemaFor(tx)
  return sql`NOT (
    ${jsonHasKey(tx, runs.snapshot, 'mapJob')}
    AND ${runs.targetAccountId} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${runs} AS yield_user_runs
      WHERE yield_user_runs.target_id = ${runs.targetId}
        AND yield_user_runs.target_account_id = ${runs.targetAccountId}
        AND yield_user_runs.status IN ('QUEUED', 'RECOVERING')
        AND yield_user_runs.deleted_at IS NULL AND yield_user_runs.cancel_requested_at IS NULL
        AND yield_user_runs.id <> ${runs.id}
        AND NOT ${jsonHasKey(tx, sql`yield_user_runs.snapshot`, 'mapJob')}
        AND (
          yield_user_runs.execution_origin <> 'suite_member'
          OR EXISTS (
            SELECT 1 FROM ${suiteRunItems} yield_suite_items
            WHERE yield_suite_items.child_run_id = yield_user_runs.id
              AND yield_suite_items.admission_status = 'ACTIVE'
          )
        )
        AND NOT EXISTS (SELECT 1 FROM ${runLeases} l WHERE l.run_id = yield_user_runs.id AND l.status = 'ACTIVE')
    )
  )`
}

function claimEligiblePredicate(
  tx: Db,
  status: 'RECOVERING' | 'QUEUED',
  worker: WorkerRow,
  input: { workerId: string; instanceId: string },
  candidateIds: string[],
  nowIso: string,
) {
  const { browserSessions, runLeases, runs } = schemaFor(tx)
  const startBefore = mapJobStartBefore(tx)
  return and(
    eq(runs.status, status),
    isNull(runs.deletedAt),
    isNull(runs.cancelRequestedAt),
    or(isNull(runs.deadlineAt), sql`${runs.deadlineAt} > ${databaseNow(tx)}`),
    inArray(runs.id, candidateIds),
    worker.protocolCapabilities?.includes('snapshot.moduleManifest@1')
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'moduleManifest')),
    worker.protocolCapabilities?.includes('snapshot.candidateGroups@1')
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'candidateGroups')),
    worker.protocolCapabilities?.includes(MAP_JOBS_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'mapJob')),
    // 冻结了「启用」的地图消费的 Run，只能交给声明 map-consumption@1 的 Worker：
    // 不认识该协议的旧 Worker 会按「无地图」悄悄执行，违背快照里的承诺。
    // 不能像上面那些协议一样只判键存在：freezeMapConsumptionTx 在消费关闭时
    // 也会写 { mode: 'off' }，键几乎总是存在，按键拦会把旧 Worker 挡在所有 Run 之外。
    // 所以看值：缺键（旧快照）或 mode = 'off' 都不需要该协议。
    worker.protocolCapabilities?.includes(MAP_CONSUMPTION_PROTOCOL)
      ? undefined
      : or(
          isNull(jsonText(tx, runs.snapshot, ['mapConsumption', 'mode'])),
          jsonTextEquals(tx, runs.snapshot, ['mapConsumption', 'mode'], 'off'),
        ),
    worker.protocolCapabilities?.includes(OUTCOME_MANIFEST_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'outcomeManifest')),
    worker.protocolCapabilities?.includes(AI_ATOMIC_ACTIONS_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'aiAtomicActionsProtocol')),
    worker.protocolCapabilities?.includes(LIST_OUTPUT_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'listOutputProtocol')),
    worker.protocolCapabilities?.includes(AI_TASK_EVIDENCE_PROTOCOL)
      ? undefined
      : or(
          isNull(jsonText(tx, runs.snapshot, ['aiTaskEvidence', 'actionEdge'])),
          jsonTextEquals(tx, runs.snapshot, ['aiTaskEvidence', 'actionEdge'], 'off'),
        ),
    worker.protocolCapabilities?.includes(IMPORTED_OUTCOME_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'importedOutcomeProtocol')),
    worker.protocolCapabilities?.includes(RUNTIME_INVARIANT_MANIFEST_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'runtimeInvariantManifest')),
    worker.protocolCapabilities?.includes(SUITE_ADMISSION_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'suiteAdmission')),
    worker.protocolCapabilities?.includes(RESOLUTION_PROTOCOL)
      ? undefined
      : not(jsonHasKey(tx, runs.snapshot, 'resolution')),
    worker.protocolCapabilities?.includes(CONTROL_FLOW_PROTOCOL_V2)
      ? undefined
      : worker.protocolCapabilities?.includes(CONTROL_FLOW_PROTOCOL)
        ? or(
            isNull(jsonText(tx, runs.snapshot, ['controlFlow', 'protocol'])),
            jsonTextEquals(tx, runs.snapshot, ['controlFlow', 'protocol'], CONTROL_FLOW_PROTOCOL),
          )
        : not(jsonHasKey(tx, runs.snapshot, 'controlFlow')),
    suiteAdmissionPredicate(tx),
    not(scheduledStartDeadlineExpired(tx, new Date(nowIso))!),
    sql`NOT EXISTS (SELECT 1 FROM ${runLeases} l WHERE l.run_id = ${runs.id} AND l.status = 'ACTIVE')`,
    or(
      isNull(runs.targetAccountId),
      sql`EXISTS (
          SELECT 1 FROM ${browserSessions} s
           WHERE s.target_id = ${runs.targetId} AND s.target_account_id = ${runs.targetAccountId}
 AND s.status = 'OPEN' AND s.health <> 'UNHEALTHY'
 AND s.owner_worker_id = ${input.workerId}
 AND s.owner_worker_instance_id = ${input.instanceId}
        )`,
      and(
        sql`(
          SELECT COUNT(*) FROM ${browserSessions} s
           WHERE s.owner_worker_id = ${input.workerId}
 AND s.status IN ('CREATING', 'OPEN', 'CLOSING')
        ) < ${worker.maxSessions}`,
        worker.protocolCapabilities?.includes(SESSION_ACCOUNT_CONCURRENCY_PROTOCOL)
          ? undefined
          : sql`NOT EXISTS (
          SELECT 1 FROM ${browserSessions} s
           WHERE s.target_id = ${runs.targetId} AND s.target_account_id = ${runs.targetAccountId}
 AND s.status IN ('CREATING', 'OPEN', 'CLOSING', 'LOST')
 AND NOT (s.status = 'OPEN' AND s.owner_worker_id = ${input.workerId})
        )`,
      ),
    ),
    sql`(
      NOT ${jsonHasKey(tx, runs.snapshot, 'mapJob')}
      OR ${startBefore} IS NULL
      OR ${jsonTextCompare(tx, startBefore, '>', nowIso)}
    )`,
    mapJobYieldPredicate(tx),
  )
}

export async function expireMapJobClaimWindows(handle: DbHandle, limit = 100): Promise<{ scanned: number }> {
  const db = handle.db
  const { mapJobs, runs } = schemaFor(db)
  const nowIso = (await clockNow(db)).toISOString()
  const startBefore = mapJobStartBefore(db)
  const jobIdAsText = driverOf(db) === 'mysql'
    ? sql`CAST(expiring_job.id AS CHAR(36))`
    : sql`CAST(expiring_job.id AS TEXT)`
  const rows = await db.select({ id: runs.id, jobId: mapJobJobId(db) }).from(runs).where(and(
    inArray(runs.status, ['QUEUED', 'RECOVERING']), isNull(runs.deletedAt),
    jsonHasKey(db, runs.snapshot, 'mapJob'), sql`${startBefore} IS NOT NULL`,
    jsonTextCompare(db, startBefore, '<=', nowIso),
    sql`EXISTS (SELECT 1 FROM ${mapJobs} AS expiring_job WHERE ${jobIdAsText} = ${mapJobJobId(db)} AND expiring_job.job_status IN ('queued', 'running'))`,
  )).orderBy(asc(runs.createdAt), asc(runs.id)).limit(limit)
  for (const row of rows) {
    if (!row.jobId) continue
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db
      const { mapJobs, runs } = schemaFor(tx)
      const [job] = await locked(tx, tx.select({ jobStatus: mapJobs.jobStatus }).from(mapJobs)
        .where(eq(mapJobs.id, row.jobId as string)))
      if (!job || !['queued', 'running'].includes(job.jobStatus)) return
      const [run] = await tx.select({ id: runs.id }).from(runs).where(and(
        eq(runs.id, row.id), inArray(runs.status, ['QUEUED', 'RECOVERING']),
        isNull(runs.deletedAt),
        jsonTextCompare(tx, mapJobStartBefore(tx), '<=', (await clockNow(tx)).toISOString()),
      )).limit(1)
      if (run) await markMapJobWindowClosed(tx, row.jobId as string)
    })
  }
  return { scanned: rows.length }
}

async function markMapJobRunning(tx: Db, jobId: string): Promise<void> {
  const { mapJobs } = schemaFor(tx)
  const now = await clockNow(tx)
  await tx
    .update(mapJobs)
    .set({ jobStatus: 'running', updatedAt: now })
    .where(and(eq(mapJobs.id, jobId), inArray(mapJobs.jobStatus, ['queued', 'running'])))
}

async function markMapJobWindowClosed(tx: Db, jobId: string): Promise<void> {
  const { mapJobs } = schemaFor(tx)
  const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, jobId)))
  if (!job || job.jobStatus === 'cancelled' || job.jobStatus === 'completed' || job.jobStatus === 'failed') return
  const now = await clockNow(tx)
  await tx
    .update(mapJobs)
    .set({ jobStatus: 'cancelled', stopReason: 'window_closed', activeGuard: null, updatedAt: now })
    .where(eq(mapJobs.id, jobId))
}

export async function claimRunWithCursor(
  handle: DbHandle,
  input: {
    workerId: string
    instanceId: string
    leaseTtlSeconds: number
    excludeRunIds?: string[]
    cursor?: ClaimScanCursor
  },
): Promise<ClaimRunResult> {
  const db = handle.db
  const startedAt = performance.now()
  const diagnostics: ClaimRunDiagnostics = {
    scanned: 0, windowRows: 0, windows: 0, candidateSqlMs: 0,
    totalMs: 0, reason: null, excluded: 0, selected: false, recorded: true,
  }
  const cursor: ClaimScanCursor = {
    RECOVERING: input.cursor?.RECOVERING ?? null,
    QUEUED: input.cursor?.QUEUED ?? null,
  }
  const result = (grant: RunGrant | null, reason: ClaimRunResult['reason']): ClaimRunResult => {
    diagnostics.totalMs = performance.now() - startedAt
    diagnostics.reason = reason
    lastClaimDiagnostics = diagnostics
    return { grant, cursor, reason }
  }
  const { runs, workers } = schemaFor(db)
  const [worker] = await db.select().from(workers).where(and(
    eq(workers.id, input.workerId), eq(workers.instanceId, input.instanceId), eq(workers.status, 'READY'),
  )).limit(1)
  if (!worker) return result(null, 'unavailable')
  let scheduling: Awaited<ReturnType<typeof readSessionScheduling>>['scheduling'] | undefined
  const excluded = (input.excludeRunIds ?? []).slice(0, CLAIM_EXCLUDE_LIMIT)
  diagnostics.excluded = excluded.length
  let needsContinuation = false
  let totalScanned = 0
  for (const status of ['RECOVERING', 'QUEUED'] as const) {
    // Recovery gets the first half; QUEUED can use every unused scan slot.
    const budget = status === 'RECOVERING' ? CLAIM_SCAN_LIMIT / 2 : CLAIM_SCAN_LIMIT - totalScanned
    let scannedForStatus = 0
    while (scannedForStatus < budget) {
      const after = cursor[status]
      const windowStartedAt = performance.now()
      const window = await db.select({
        id: runs.id, createdAt: runs.createdAt, targetId: runs.targetId,
        targetAccountId: runs.targetAccountId, cursorCreatedAt: claimCursorTimestamp(db),
      }).from(runs).where(and(
        eq(runs.status, status), isNull(runs.deletedAt),
        after ? or(
          sql`${runs.createdAt} > ${after.createdAt}`,
          and(sql`${runs.createdAt} = ${after.createdAt}`, gt(runs.id, after.id)),
        ) : undefined,
      )).orderBy(asc(runs.createdAt), asc(runs.id)).limit(Math.min(CLAIM_WINDOW_SIZE, budget - scannedForStatus))
      diagnostics.candidateSqlMs += performance.now() - windowStartedAt
      if (!window.length) {
        cursor[status] = null
        break
      }
      diagnostics.windowRows += window.length
      diagnostics.windows += 1
      scannedForStatus += window.length
      totalScanned += window.length
      const last = window[window.length - 1]!
      cursor[status] = { createdAt: last.cursorCreatedAt, id: last.id }
      const ids = window.map((row) => row.id).filter((id) => !excluded.includes(id))
      if (!ids.length) continue
      const nowIso = (await clockNow(db)).toISOString()
      const candidateStartedAt = performance.now()
      const candidateRuns = await db.select({
        id: runs.id, createdAt: runs.createdAt, targetId: runs.targetId,
        targetAccountId: runs.targetAccountId, mapJobId: mapJobJobId(db),
        mapJobStartBefore: mapJobStartBefore(db),
      }).from(runs).where(claimEligiblePredicate(db, status, worker, input, ids, nowIso))
      diagnostics.candidateSqlMs += performance.now() - candidateStartedAt
      diagnostics.scanned += candidateRuns.length
      if (!candidateRuns.length) continue
      if (!scheduling) {
        try {
          ;({ scheduling } = await readSessionScheduling(db))
        } catch {
          return result(null, 'unavailable')
        }
      }
      const currentScheduling = scheduling!
      const targetIds = [...new Set(candidateRuns.map((row) => row.targetId))]
      const runningCounts = await db.select({ targetId: runs.targetId, count: sql<number>`count(*)` })
        .from(runs).where(and(inArray(runs.targetId, targetIds), eq(runs.status, 'RUNNING'), isNull(runs.deletedAt)))
        .groupBy(runs.targetId)
      const counts = new Map(runningCounts.map((row) => [row.targetId, Number(row.count)]))
      candidateRuns.sort((a, b) =>
        (counts.get(a.targetId) ?? 0) - (counts.get(b.targetId) ?? 0)
        || a.createdAt.getTime() - b.createdAt.getTime()
        || a.id.localeCompare(b.id))
      for (const candidate of candidateRuns) {
        const attempt = await db.transaction(async (transaction) => {
          const tx = transaction as unknown as Db
          const { mapJobs, runLeases, runs, targetAccounts, workers } = schemaFor(tx)
          const [currentWorker] = await locked(tx, tx.select().from(workers).where(and(
            eq(workers.id, input.workerId), eq(workers.instanceId, input.instanceId), eq(workers.status, 'READY'),
          )))
          if (!currentWorker) return { grant: null, unavailable: true }
          const [held] = await tx.select({ count: sql<number>`count(*)` }).from(runLeases).where(and(
            eq(runLeases.holderWorkerId, input.workerId), eq(runLeases.status, 'ACTIVE'),
            sql`${runLeases.expiresAt} > ${databaseNow(tx)}`,
          ))
          if (Number(held?.count ?? 0) >= currentWorker.capacity) return { grant: null, unavailable: true }
          const mapJobId = candidate.mapJobId as string | null
          if (mapJobId) {
            const [job] = await locked(tx, tx.select({ jobStatus: mapJobs.jobStatus }).from(mapJobs)
              .where(eq(mapJobs.id, mapJobId)), true)
            if (!job || !['queued', 'running'].includes(job.jobStatus)) return { grant: null, unavailable: false }
            const windowEnd = candidate.mapJobStartBefore as string | null
            if (windowEnd && Date.parse(windowEnd) <= (await clockNow(tx)).getTime()) {
              await markMapJobWindowClosed(tx, mapJobId)
              return { grant: null, unavailable: false }
            }
          }
          if (candidate.targetAccountId) {
            const [account] = await locked(tx, tx.select({ id: targetAccounts.id }).from(targetAccounts)
              .where(eq(targetAccounts.id, candidate.targetAccountId)), true)
            if (!account) return { grant: null, unavailable: false }
          }
          const [run] = await locked(tx, tx.select({
            id: runs.id, createdAt: runs.createdAt, targetId: runs.targetId,
            targetAccountId: runs.targetAccountId,
          }).from(runs).where(claimEligiblePredicate(
            tx, status, currentWorker, input, [candidate.id], (await clockNow(tx)).toISOString(),
          )).limit(1), true)
          if (!run) return { grant: null, unavailable: false }
          const eligibility = await evaluateRunSessionEligibility(tx, {
            run, workerId: input.workerId, instanceId: input.instanceId,
            maxSessions: currentWorker.maxSessions, scheduling: currentScheduling,
            protocolCapabilities: currentWorker.protocolCapabilities,
          })
          if (!eligibility.eligible) return { grant: null, unavailable: false }
          await tx.update(runs).set({
            status: 'RUNNING', startedAt: sql`COALESCE(${runs.startedAt}, ${databaseNow(tx)})`,
            updatedAt: databaseNow(tx),
          }).where(eq(runs.id, run.id))
          await appendRunEvents(tx, run.id, [{ type: 'run.status_changed', payload: { status: 'RUNNING' } }])
          if (mapJobId) await markMapJobRunning(tx, mapJobId)
          const [max] = await tx.select({ token: sql<number>`COALESCE(MAX(${runLeases.fencingToken}), 0) + 1` })
            .from(runLeases).where(eq(runLeases.runId, run.id))
          const [lease] = await insertRows(tx, runLeases, {
            id: newId(), runId: run.id, fencingToken: Number(max!.token),
            holderWorkerId: input.workerId, status: 'ACTIVE',
            expiresAt: afterSeconds(tx, input.leaseTtlSeconds),
          })
          return { grant: toGrant(lease!), unavailable: false }
        })
        if (attempt.unavailable) return result(null, 'unavailable')
        if (attempt.grant) {
          // A successful claim removes only one row from the window. Revisit its
          // remaining rows on the next claim so one Worker can fill every slot.
          cursor[status] = after
          diagnostics.selected = true
          return result(attempt.grant, 'claimed')
        }
      }
    }
    if (scannedForStatus >= budget) needsContinuation = true
  }
  return result(null, needsContinuation ? 'budget_exhausted' : 'idle')
}

export async function claimRun(
  handle: DbHandle,
  input: Parameters<typeof claimRunWithCursor>[1],
): Promise<RunGrant | null> {
  let cursor = input.cursor
  // Callers that do not retain a cursor keep the old behavior of searching
  // beyond one bounded window. The executor uses claimRunWithCursor directly.
  for (let i = 0; i < 256; i += 1) {
    const claim = await claimRunWithCursor(handle, { ...input, cursor })
    if (claim.grant || claim.reason !== 'budget_exhausted') return claim.grant
    cursor = claim.cursor
  }
  return null
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
