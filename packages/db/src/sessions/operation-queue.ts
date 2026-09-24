import { and, desc, eq, gt, lt, lte, or, sql } from 'drizzle-orm'
import {
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  isSessionMaintenanceKind,
  type SessionOperationKind,
  type SessionOperationWaitReason,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { databaseNow, locked, schemaFor, updateRows } from '../native.js'
import type { SessionOperationRow } from '../records.js'
import {
  concurrencyProtocolRequired,
  readAccountSessionCap,
  workerHasConcurrencyProtocol,
} from './account-session-concurrency.js'
import { appendSessionEvent } from './session-events.js'
import { findLiveSessions, type SessionKey } from './sessions.js'
import { getSessionOperation, toSessionOperationDto } from './occupancy-read.js'

/** 同一原因只按此间隔刷新评估时间，避免每个领取周期都回写候选行。 */
export const WAIT_REFRESH_SECONDS = 30

/**
 * 把过了排队截止仍 QUEUED 的操作判为 OPERATION_QUEUE_EXPIRED。
 * 以 status = QUEUED 为守卫，Worker 领取与 API 受理可并发重入，只会有一方写终态与事件。
 */
export async function expireQueuedSessionOperations(
  tx: Db,
  input: { now: Date; key?: SessionKey; limit?: number },
): Promise<number> {
  const { sessionOperations, targetAccounts } = schemaFor(tx)
  const rows = await tx
    .select()
    .from(sessionOperations)
    .where(
      and(
        eq(sessionOperations.status, 'QUEUED'),
        lte(sessionOperations.queueDeadlineAt, input.now),
        ...(input.key
          ? [
              eq(sessionOperations.targetId, input.key.targetId),
              eq(sessionOperations.targetAccountId, input.key.targetAccountId),
            ]
          : []),
      ),
    )
    .limit(input.limit ?? 20)
  let expired = 0
  for (const row of rows) {
    await locked(
      tx,
      tx.select({ id: targetAccounts.id }).from(targetAccounts).where(eq(targetAccounts.id, row.targetAccountId)),
    )
    const [moved] = await updateRows(
      tx,
      sessionOperations,
      { status: 'FAILED', errorCode: 'OPERATION_QUEUE_EXPIRED', finishedAt: input.now, updatedAt: input.now },
      and(eq(sessionOperations.id, row.id), eq(sessionOperations.status, 'QUEUED')),
    )
    if (!moved) continue
    expired += 1
    await appendSessionEvent(tx, {
      key: row,
      type: 'operation.finished',
      operationId: row.id,
      sessionId: row.expectedSessionId,
      payload: {
        kind: row.kind,
        status: 'FAILED',
        errorCode: 'OPERATION_QUEUE_EXPIRED',
        ...(row.waitReason ? { waitReason: row.waitReason } : {}),
        queuedMs: Math.max(0, input.now.getTime() - row.createdAt.getTime()),
      },
    })
  }
  return expired
}

export type MaintenanceWorkerAvailability = {
  /** READY 且心跳未过期的节点数。 */
  online: number
  /** 在线且声明了领取该操作所需协议的节点数。 */
  eligible: number
}

/** 与领取同口径判断「有没有节点能领这个操作」，只读。 */
export async function countEligibleMaintenanceWorkers(
  db: Db,
  input: { key: SessionKey; kind: SessionOperationKind },
): Promise<MaintenanceWorkerAvailability> {
  const { workers } = schemaFor(db)
  const rows = await db
    .select({ protocols: workers.protocolCapabilities })
    .from(workers)
    .where(
      and(
        eq(workers.status, 'READY'),
        or(sql`${workers.heartbeatExpiresAt} IS NULL`, gt(workers.heartbeatExpiresAt, databaseNow(db))),
      ),
    )
  if (!rows.length) return { online: 0, eligible: 0 }
  const needsMaintenance = isSessionMaintenanceKind(input.kind)
  const cap = await readAccountSessionCap(db, input.key)
  const lives = await findLiveSessions(db, input.key)
  const needsConcurrency = concurrencyProtocolRequired(cap.effectiveCap, lives.length)
  const eligible = rows.filter(({ protocols }) => {
    if (!protocols?.includes(SESSION_OCCUPANCY_PROTOCOL)) return false
    if (needsMaintenance && !protocols.includes(SESSION_MAINTENANCE_PROTOCOL)) return false
    if (needsConcurrency && !workerHasConcurrencyProtocol(protocols)) return false
    return true
  }).length
  return { online: rows.length, eligible }
}

export function availabilityWaitReason(
  availability: MaintenanceWorkerAvailability,
): SessionOperationWaitReason | null {
  if (availability.online === 0) return 'NO_ELIGIBLE_WORKER'
  if (availability.eligible === 0) return 'WORKER_PROTOCOL_MISSING'
  return null
}

/**
 * 记录一次「评估过但没领到」。原因不变时只按 WAIT_REFRESH_SECONDS 刷新评估时间与上下文。
 * 事件跟「上一次已落事件的原因」比较，且两条事件至少间隔 WAIT_REFRESH_SECONDS：
 * 多节点给出的原因交替出现时不会刷屏，短时间内被压下的新原因也会在下一次刷新时补上。
 * 调用方须已持有账号锁与操作行锁（领取事务内）。
 */
export async function recordOperationWait(
  tx: Db,
  op: Pick<
    SessionOperationRow,
    'id' | 'targetId' | 'targetAccountId' | 'kind' | 'expectedSessionId' | 'waitReason' | 'lastClaimAttemptAt'
  >,
  now: Date,
  reason: SessionOperationWaitReason,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  const { sessionOperations, sessionEvents } = schemaFor(tx)
  const changed = op.waitReason !== reason
  const stale =
    !op.lastClaimAttemptAt || now.getTime() - op.lastClaimAttemptAt.getTime() >= WAIT_REFRESH_SECONDS * 1000
  if (!changed && !stale) return
  await updateRows(
    tx,
    sessionOperations,
    { waitReason: reason, waitDetail: detail, lastClaimAttemptAt: now },
    and(eq(sessionOperations.id, op.id), eq(sessionOperations.status, 'QUEUED')),
  )
  const [last] = await tx
    .select({ payload: sessionEvents.payload, createdAt: sessionEvents.createdAt })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.targetId, op.targetId),
        eq(sessionEvents.targetAccountId, op.targetAccountId),
        eq(sessionEvents.operationId, op.id),
        eq(sessionEvents.type, 'operation.queue_waiting'),
      ),
    )
    .orderBy(desc(sessionEvents.seq))
    .limit(1)
  if (last?.payload?.waitReason === reason) return
  if (last && now.getTime() - last.createdAt.getTime() < WAIT_REFRESH_SECONDS * 1000) return
  await appendSessionEvent(tx, {
    key: op,
    type: 'operation.queue_waiting',
    operationId: op.id,
    sessionId: op.expectedSessionId,
    payload: { kind: op.kind, waitReason: reason, ...(detail ? { detail } : {}) },
  })
}

/** 与领取同口径：全局 QUEUED、未过期、按 (createdAt, id) 排在它之前的操作数。 */
export async function queuePositionOf(
  db: Db,
  op: Pick<SessionOperationRow, 'id' | 'status' | 'createdAt' | 'queueDeadlineAt'>,
): Promise<number | null> {
  if (op.status !== 'QUEUED') return null
  const { sessionOperations } = schemaFor(db)
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(sessionOperations)
    .where(
      and(
        eq(sessionOperations.status, 'QUEUED'),
        gt(sessionOperations.queueDeadlineAt, databaseNow(db)),
        or(
          lt(sessionOperations.createdAt, op.createdAt),
          and(eq(sessionOperations.createdAt, op.createdAt), lt(sessionOperations.id, op.id)),
        ),
      ),
    )
  return Number(row?.n ?? 0)
}

/**
 * 读时推导排队原因：节点可用性优先于最近一次领取评估，
 * 这样 Worker 全停时不依赖任何节点回写也能说清楚。
 */
export async function effectiveOperationWaitReason(
  db: Db,
  op: Pick<SessionOperationRow, 'status' | 'kind' | 'targetId' | 'targetAccountId' | 'waitReason'>,
): Promise<SessionOperationWaitReason | null> {
  if (op.status !== 'QUEUED') return null
  const derived = availabilityWaitReason(
    await countEligibleMaintenanceWorkers(db, {
      key: { targetId: op.targetId, targetAccountId: op.targetAccountId },
      kind: op.kind,
    }),
  )
  if (derived) return derived
  if (op.waitReason === 'NO_ELIGIBLE_WORKER' || op.waitReason === 'WORKER_PROTOCOL_MISSING') {
    return 'AWAITING_CLAIM'
  }
  return op.waitReason ?? 'AWAITING_CLAIM'
}

/** 操作详情：在账本行之上补读时推导的排队原因与队列位置。 */
export async function getSessionOperationView(db: Db, operationId: string) {
  const row = await getSessionOperation(db, operationId)
  if (!row) return null
  const dto = toSessionOperationDto(row)
  if (row.status !== 'QUEUED') return dto
  return {
    ...dto,
    waitReason: await effectiveOperationWaitReason(db, row),
    queuePosition: await queuePositionOf(db, row),
  }
}
