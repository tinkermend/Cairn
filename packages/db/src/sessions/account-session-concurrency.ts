import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  deriveAccountSessionStatus,
  effectiveAccountSessionCap,
  type AccountSessionStatus,
  type RunWaitReason,
  type SessionOperationWaitReason,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { databaseNow, schemaFor } from '../native.js'
import type { SessionLeaseRow } from '../records.js'
import { loadResolvedSessionPolicyForTarget } from './session-policy.js'
import { findLiveSessions, isClaimable, type SessionKey, type SessionRecord } from './sessions.js'

export type SessionProfileKey = SessionKey & { accountSlot: number }

export function profileKeyFrom(key: SessionKey, accountSlot = 1): SessionProfileKey {
  return { ...key, accountSlot }
}

export type AccountSessionCap = {
  effectiveCap: number
  mode: 'exclusive' | 'concurrent'
  maxConcurrentSessions: number
}

export async function readAccountSessionCap(db: Db, key: SessionKey): Promise<AccountSessionCap> {
  const policy = await loadResolvedSessionPolicyForTarget(db, key.targetId)
  const { targetAccounts } = schemaFor(db)
  const [account] = await db
    .select({ maxConcurrentSessions: targetAccounts.maxConcurrentSessions })
    .from(targetAccounts)
    .where(eq(targetAccounts.id, key.targetAccountId))
    .limit(1)
  const maxConcurrentSessions = account?.maxConcurrentSessions ?? 1
  return {
    mode: policy.accountSessionMode,
    maxConcurrentSessions,
    effectiveCap: effectiveAccountSessionCap({
      accountSessionMode: policy.accountSessionMode,
      maxConcurrentSessions,
    }),
  }
}

export function concurrencyProtocolRequired(effectiveCap: number, liveCount: number): boolean {
  return effectiveCap > 1 || liveCount > 1
}

export function workerHasConcurrencyProtocol(protocols: readonly string[] | null | undefined): boolean {
  return Boolean(protocols?.includes(SESSION_ACCOUNT_CONCURRENCY_PROTOCOL))
}

export function workerHasOccupancyProtocol(protocols: readonly string[] | null | undefined): boolean {
  return Boolean(protocols?.includes(SESSION_OCCUPANCY_PROTOCOL))
}

export function assignMinFreeSlot(lives: readonly SessionRecord[], effectiveCap: number): number | null {
  const used = new Set(lives.map((row) => row.accountSlot))
  for (let slot = 1; slot <= effectiveCap; slot += 1) {
    if (!used.has(slot)) return slot
  }
  return null
}

export function localReusableSessions(
  lives: readonly SessionRecord[],
  input: { workerId: string; instanceId: string },
): SessionRecord[] {
  return lives.filter(
    (session) =>
      session.status === 'OPEN' &&
      isClaimable(session) &&
      session.ownerWorkerId === input.workerId &&
      session.ownerWorkerInstanceId === input.instanceId,
  )
}

export function pickOldestReusable(sessions: readonly SessionRecord[]): SessionRecord | null {
  return (
    [...sessions].sort((left, right) => {
      const byUsed = left.lastUsedAt.getTime() - right.lastUsedAt.getTime()
      if (byUsed !== 0) return byUsed
      return left.id < right.id ? -1 : 1
    })[0] ?? null
  )
}

const WORST_IDLE: AccountSessionStatus[] = [
  'identity_mismatch',
  'needs_login',
  'needs_check',
  'ready',
]

export function pickWorstIdle(sessions: readonly SessionRecord[]): SessionRecord | null {
  return (
    [...sessions].sort((left, right) => {
      const leftStatus = deriveAccountSessionStatus({
        liveStatus: left.status,
        authState: left.authState,
        identityState: left.identityState,
        leasePurpose: null,
        occupyingRunId: null,
        occupyingOperationId: null,
        holding: false,
      })
      const rightStatus = deriveAccountSessionStatus({
        liveStatus: right.status,
        authState: right.authState,
        identityState: right.identityState,
        leasePurpose: null,
        occupyingRunId: null,
        occupyingOperationId: null,
        holding: false,
      })
      const rank = WORST_IDLE.indexOf(leftStatus) - WORST_IDLE.indexOf(rightStatus)
      if (rank !== 0) return rank
      return left.lastUsedAt.getTime() - right.lastUsedAt.getTime()
    })[0] ?? null
  )
}

export async function findActiveLeasesBySession(
  db: Db,
  sessionIds: readonly string[],
): Promise<Map<string, SessionLeaseRow>> {
  const map = new Map<string, SessionLeaseRow>()
  if (sessionIds.length === 0) return map
  const { sessionLeases } = schemaFor(db)
  const rows = await db
    .select()
    .from(sessionLeases)
    .where(and(inArray(sessionLeases.sessionId, [...sessionIds]), eq(sessionLeases.status, 'ACTIVE')))
  for (const row of rows) {
    if (!map.has(row.sessionId)) map.set(row.sessionId, row)
  }
  return map
}

export async function workerEligibleToOwnIdle(
  db: Db,
  input: {
    ownerWorkerId: string
    ownerWorkerInstanceId: string | null
    requireConcurrencyProtocol: boolean
    checkRunCapacity: boolean
  },
): Promise<boolean> {
  const { workers, runLeases } = schemaFor(db)
  const [owner] = await db.select().from(workers).where(eq(workers.id, input.ownerWorkerId)).limit(1)
  if (!owner || owner.status !== 'READY') return false
  if (owner.instanceId !== input.ownerWorkerInstanceId) return false
  if (!workerHasOccupancyProtocol(owner.protocolCapabilities)) return false
  if (input.requireConcurrencyProtocol && !workerHasConcurrencyProtocol(owner.protocolCapabilities)) {
    return false
  }
  if (!input.checkRunCapacity) return true
  const [held] = await db
    .select({ n: sql<number>`count(*)` })
    .from(runLeases)
    .where(
      and(
        eq(runLeases.holderWorkerId, owner.id),
        eq(runLeases.status, 'ACTIVE'),
        sql`${runLeases.expiresAt} > ${databaseNow(db)}`,
      ),
    )
  return Number(held?.n ?? 0) < owner.capacity
}

export async function findEligibleForeignIdle(
  db: Db,
  input: {
    lives: readonly SessionRecord[]
    leases: Map<string, SessionLeaseRow>
    holderWorkerId: string
    holderInstanceId: string
    requireConcurrencyProtocol: boolean
    checkRunCapacity: boolean
  },
): Promise<SessionRecord | null> {
  for (const session of input.lives) {
    if (session.status !== 'OPEN' || !isClaimable(session)) continue
    if (input.leases.has(session.id)) continue
    if (
      session.ownerWorkerId === input.holderWorkerId &&
      session.ownerWorkerInstanceId === input.holderInstanceId
    ) {
      continue
    }
    if (
      await workerEligibleToOwnIdle(db, {
        ownerWorkerId: session.ownerWorkerId,
        ownerWorkerInstanceId: session.ownerWorkerInstanceId,
        requireConcurrencyProtocol: input.requireConcurrencyProtocol,
        checkRunCapacity: input.checkRunCapacity,
      })
    ) {
      return session
    }
  }
  return null
}

export async function findDestructiveReservation(
  db: Db,
  key: SessionKey,
): Promise<{ id: string; expectedSessionId: string | null } | null> {
  const { sessionOperations } = schemaFor(db)
  const [row] = await db
    .select({
      id: sessionOperations.id,
      expectedSessionId: sessionOperations.expectedSessionId,
    })
    .from(sessionOperations)
    .where(
      and(
        eq(sessionOperations.targetId, key.targetId),
        eq(sessionOperations.targetAccountId, key.targetAccountId),
        eq(sessionOperations.status, 'RUNNING'),
        inArray(sessionOperations.kind, ['CLOSE', 'RESTART', 'RESET_PROFILE']),
      ),
    )
    .limit(1)
  return row ?? null
}

export function reservationBlocksSession(
  reserved: { id: string; expectedSessionId: string | null } | null,
  sessionId: string | null,
  lives: readonly SessionRecord[],
  owner: { kind: string; operationId?: string },
): boolean {
  if (!reserved) return false
  if (owner.kind === 'SESSION_OPERATION' && owner.operationId === reserved.id) return false
  const reservedSessionId = reserved.expectedSessionId ?? (lives.length === 1 ? lives[0]?.id ?? null : null)
  if (!reservedSessionId) return false
  return sessionId == null || sessionId === reservedSessionId
}

export type SessionClaimDecision =
  | { action: 'reuse'; session: SessionRecord }
  | { action: 'create'; accountSlot: number }
  | {
      action: 'reject'
      code:
        | 'SESSION_BUSY'
        | 'SESSION_NOT_CLAIMABLE'
        | 'SESSION_CAPACITY_EXCEEDED'
        | 'SESSION_ACCOUNT_CAP_EXCEEDED'
      waitReason?: RunWaitReason
      message?: string
      /** 会话操作排队时落账的原因与上下文；Run 侧仍用 waitReason。 */
      operationWait?: SessionClaimOperationWait
    }

export type SessionClaimOperationWait = {
  reason: SessionOperationWaitReason
  detail?: Record<string, unknown>
}

export async function decideAccountSessionClaim(
  db: Db,
  input: {
    key: SessionKey
    lives: readonly SessionRecord[]
    leases: Map<string, SessionLeaseRow>
    holderWorkerId: string
    holderInstanceId: string
    holderMaxSessions: number
    holderOccupied: number
    holderProtocols: readonly string[] | null | undefined
    purpose: 'EXECUTION' | 'MAINTENANCE'
    expectedSessionId?: string | null
    pickIdle: 'oldest' | 'worst'
  },
): Promise<SessionClaimDecision> {
  const cap = await readAccountSessionCap(db, input.key)
  const requireConcurrency = concurrencyProtocolRequired(cap.effectiveCap, input.lives.length)
  if (requireConcurrency && !workerHasConcurrencyProtocol(input.holderProtocols)) {
    return { action: 'reject', code: 'SESSION_NOT_CLAIMABLE', message: 'Worker 未声明账号并发协议' }
  }

  if (input.expectedSessionId) {
    const session = input.lives.find((row) => row.id === input.expectedSessionId)
    if (!session) return { action: 'reject', code: 'SESSION_NOT_CLAIMABLE', message: '指定会话不存在或已关闭' }
    if (session.status === 'CLOSING' || session.status === 'LOST') {
      return {
        action: 'reject',
        code: 'SESSION_BUSY',
        waitReason: session.status === 'LOST' ? 'SESSION_LOST' : undefined,
        operationWait: {
          reason: session.status === 'LOST' ? 'SESSION_LOST' : 'SESSION_BUSY',
          detail: { sessionId: session.id, sessionStatus: session.status },
        },
      }
    }
    if (
      session.ownerWorkerId !== input.holderWorkerId ||
      session.ownerWorkerInstanceId !== input.holderInstanceId
    ) {
      return {
        action: 'reject',
        code: 'SESSION_BUSY',
        message: '会话属于其他 Worker',
        operationWait: {
          reason: 'SESSION_ON_OTHER_WORKER',
          detail: { sessionId: session.id, workerId: session.ownerWorkerId },
        },
      }
    }
    if (session.status === 'OPEN' && !isClaimable(session)) {
      return { action: 'reject', code: 'SESSION_NOT_CLAIMABLE' }
    }
    if (input.leases.has(session.id)) {
      const lease = input.leases.get(session.id)
      return {
        action: 'reject',
        code: 'SESSION_BUSY',
        operationWait: {
          reason: 'SESSION_BUSY',
          detail: {
            sessionId: session.id,
            purpose: lease?.purpose ?? null,
            occupyingRunId: lease?.runId ?? null,
            occupyingOperationId: lease?.operationId ?? null,
          },
        },
      }
    }
    return { action: 'reuse', session }
  }

  const localIdle = localReusableSessions(input.lives, {
    workerId: input.holderWorkerId,
    instanceId: input.holderInstanceId,
  }).filter((session) => !input.leases.has(session.id))
  const local = input.pickIdle === 'worst' ? pickWorstIdle(localIdle) : pickOldestReusable(localIdle)
  if (local) return { action: 'reuse', session: local }

  const foreign = await findEligibleForeignIdle(db, {
    lives: input.lives,
    leases: input.leases,
    holderWorkerId: input.holderWorkerId,
    holderInstanceId: input.holderInstanceId,
    requireConcurrencyProtocol: requireConcurrency,
    checkRunCapacity: input.purpose === 'EXECUTION',
  })
  if (foreign) {
    return {
      action: 'reject',
      code: 'SESSION_BUSY',
      message: '空闲会话应由其所属节点领取',
      operationWait: {
        reason: 'SESSION_ON_OTHER_WORKER',
        detail: { sessionId: foreign.id, workerId: foreign.ownerWorkerId },
      },
    }
  }

  if (input.lives.length >= cap.effectiveCap) {
    const lostOnly = input.lives.every((row) => row.status === 'LOST')
    const exclusiveLost = cap.effectiveCap === 1 && input.lives.some((row) => row.status === 'LOST')
    return {
      action: 'reject',
      code: input.purpose === 'MAINTENANCE' ? 'SESSION_ACCOUNT_CAP_EXCEEDED' : 'SESSION_BUSY',
      waitReason: lostOnly || exclusiveLost
        ? 'SESSION_LOST'
        : cap.effectiveCap === 1
          ? undefined
          : 'SESSION_ACCOUNT_AT_CAPACITY',
      message: '账号并发会话已达上限',
      operationWait: lostOnly || exclusiveLost
        ? { reason: 'SESSION_LOST' }
        : cap.effectiveCap === 1
          ? { reason: 'SESSION_BUSY', detail: { lives: input.lives.length, cap: cap.effectiveCap } }
          : { reason: 'SESSION_ACCOUNT_AT_CAPACITY', detail: { lives: input.lives.length, cap: cap.effectiveCap } },
    }
  }

  if (input.holderOccupied >= input.holderMaxSessions) {
    return {
      action: 'reject',
      code: 'SESSION_CAPACITY_EXCEEDED',
      waitReason: 'WORKER_SESSION_CAPACITY',
      message: '本 Worker 会话数已达上限',
      operationWait: {
        reason: 'WORKER_SESSION_CAPACITY',
        detail: {
          workerId: input.holderWorkerId,
          occupied: input.holderOccupied,
          maxSessions: input.holderMaxSessions,
        },
      },
    }
  }

  const slot = assignMinFreeSlot(input.lives, cap.effectiveCap)
  if (slot == null) {
    return {
      action: 'reject',
      code: 'SESSION_BUSY',
      waitReason: 'SESSION_ACCOUNT_AT_CAPACITY',
      operationWait: {
        reason: 'SESSION_ACCOUNT_AT_CAPACITY',
        detail: { lives: input.lives.length, cap: cap.effectiveCap },
      },
    }
  }
  return { action: 'create', accountSlot: slot }
}

export async function loadLiveAccountSessions(db: Db, key: SessionKey) {
  const lives = await findLiveSessions(db, key)
  const leases = await findActiveLeasesBySession(db, lives.map((row) => row.id))
  return { lives, leases }
}
