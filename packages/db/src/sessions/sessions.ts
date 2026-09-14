import type { BrowserSessionRow, SessionLeaseRow } from '../records.js'
import { schemaFor } from '../native.js'
import { insertRows } from '../native.js'
import { and, asc, desc, eq, inArray, isNull, isNotNull, ne, or, sql } from 'drizzle-orm'
import {
  LOCAL_SECRET_PROVIDER,
  sessionDtoSchema,
  type SessionAuthState,
  type SessionDto,
  type SessionErrorCode,
  type SessionGrant,
  type SessionHealth,
  type SessionReusePolicy,
  type SessionStatus,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { locked, databaseNow, afterSeconds, updateRows, clockNow } from '../native.js'
import { newId } from '../id.js'
import { constraintName, isUniqueViolation, badRequest, conflict, notFound } from '../runs/errors.js'
import { browserSessions, sessionLeases } from '../schema/session.js'
import { secrets } from '../schema/targets.js'
import { lockRunRow } from '../leases/leases.js'

export type SessionKey = { targetId: string; targetAccountId: string }

export type SessionRecord = {
  id: string
  targetId: string
  targetAccountId: string
  status: SessionStatus
  health: SessionHealth
  authState: SessionAuthState
  ownerWorkerId: string
  generation: number
  fencingToken: number
  version: number
  profileKey: string
  reusePolicy: SessionReusePolicy
  idleTtlSeconds: number
  maxLifetimeSeconds: number
  expiresAt: Date
  lastUsedAt: Date
  authHoldWorkerId: string | null
  authHoldExpiresAt: Date | null
  authHoldRunId: string | null
  authHoldSessionGeneration: number | null
  authHoldWorkerInstanceId: string | null
  authControlEpoch: number
  authControlActorId: string | null
  authControlTokenHash: string | null
  authControlExpiresAt: Date | null
  authControlPageId: string | null
  closeReason: string | null
  closedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type LeaseRecord = {
  id: string
  sessionId: string
  sessionGeneration: number
  sessionFencingToken: number
  runId: string
  runFencingToken: number | null
  holderWorkerId: string
  status: SessionLeaseRow['status']
  acquiredAt: Date
  heartbeatAt: Date
  expiresAt: Date
  releasedAt: Date | null
  releaseReason: string | null
}

export type LeaseBusyInfo = {
  code: 'SESSION_BUSY'
  holderWorkerId: string
  expiresAt: Date
  leaseId: string
}

export type LeaseOutcome =
  | { ok: true; lease: LeaseRecord; created: boolean }
  | { ok: false; code: 'SESSION_BUSY'; busy: LeaseBusyInfo }
  | { ok: false; code: 'SESSION_NOT_CLAIMABLE' }

export class SessionDomainError extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.name = 'SessionDomainError'
    this.code = code
  }
}

const LIVE_STATUSES: SessionStatus[] = ['CREATING', 'OPEN', 'CLOSING', 'LOST']

function toSession(row: BrowserSessionRow): SessionRecord {
  return {
    id: row.id,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    status: row.status,
    health: row.health,
    authState: row.authState,
    ownerWorkerId: row.ownerWorkerId,
    generation: row.generation,
    fencingToken: row.fencingToken,
    version: row.version,
    profileKey: row.profileKey,
    reusePolicy: row.reusePolicy,
    idleTtlSeconds: row.idleTtlSeconds,
    maxLifetimeSeconds: row.maxLifetimeSeconds,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    authHoldWorkerId: row.authHoldWorkerId,
    authHoldExpiresAt: row.authHoldExpiresAt,
    authHoldRunId: row.authHoldRunId,
    authHoldSessionGeneration: row.authHoldSessionGeneration,
    authHoldWorkerInstanceId: row.authHoldWorkerInstanceId,
    authControlEpoch: row.authControlEpoch,
    authControlActorId: row.authControlActorId,
    authControlTokenHash: row.authControlTokenHash,
    authControlExpiresAt: row.authControlExpiresAt,
    authControlPageId: row.authControlPageId,
    closeReason: row.closeReason,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toLease(row: SessionLeaseRow): LeaseRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sessionGeneration: row.sessionGeneration,
    sessionFencingToken: row.sessionFencingToken,
    runId: row.runId,
    runFencingToken: row.runFencingToken,
    holderWorkerId: row.holderWorkerId,
    status: row.status,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
    releaseReason: row.releaseReason,
  }
}

/** 派生谓词：可跨 Run 复用。 */
export function isReusable(
  session: Pick<SessionRecord, 'status' | 'health' | 'authState'>,
): boolean {
  return (
    session.status === 'OPEN' &&
    session.health === 'HEALTHY' &&
    session.authState === 'AUTHENTICATED'
  )
}

/** 派生谓词：可被领取（无 ACTIVE 租约由调用方另查）。 */
export function isClaimable(session: Pick<SessionRecord, 'status' | 'health'>): boolean {
  return session.status === 'OPEN' && session.health !== 'UNHEALTHY'
}

export function profileKeyFor(key: SessionKey): string {
  return `${key.targetId}/${key.targetAccountId}`
}

export async function findLiveSession(db: Db, key: SessionKey): Promise<SessionRecord | null> {
  const { browserSessions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.targetId, key.targetId),
        eq(browserSessions.targetAccountId, key.targetAccountId),
        inArray(browserSessions.status, LIVE_STATUSES),
      ),
    )
    .limit(1)
  return row ? toSession(row) : null
}

export async function getSessionById(db: Db, sessionId: string): Promise<SessionRecord | null> {
  const { browserSessions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(eq(browserSessions.id, sessionId))
    .limit(1)
  return row ? toSession(row) : null
}

export async function getLeaseById(db: Db, leaseId: string): Promise<LeaseRecord | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db.select().from(sessionLeases).where(eq(sessionLeases.id, leaseId)).limit(1)
  return row ? toLease(row) : null
}

export async function countOpenSessionsForWorker(db: Db, workerId: string): Promise<number> {
  const { browserSessions } = schemaFor(db)
  const rows = await db
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      ),
    )
  return rows.length
}

export async function nextGenerationForKey(db: Db, key: SessionKey): Promise<number> {
  const { browserSessions } = schemaFor(db)
  const [row] = await db
    .select({ generation: browserSessions.generation })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.targetId, key.targetId),
        eq(browserSessions.targetAccountId, key.targetAccountId),
      ),
    )
    .orderBy(desc(browserSessions.generation))
    .limit(1)
  return (row?.generation ?? 0) + 1
}

export type CreateSessionInput = {
  key: SessionKey
  ownerWorkerId: string
  reusePolicy: SessionReusePolicy
  idleTtlSeconds: number
  maxLifetimeSeconds: number
  id?: string
}

export type CreateSessionResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; code: 'SESSION_POLICY_INVALID'; message: string }

export async function createSession(
  db: Db,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const { browserSessions } = schemaFor(db)
  if (input.maxLifetimeSeconds <= input.idleTtlSeconds) {
    return {
      ok: false,
      code: 'SESSION_POLICY_INVALID',
      message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
    }
  }
  const generation = await nextGenerationForKey(db, input.key)
  const id = input.id ?? newId()
  const now = await clockNow(db)
  const expiresAt = new Date(now.getTime() + input.maxLifetimeSeconds * 1000)
  try {
    const [row] = await insertRows(db, browserSessions, {
      id,
      targetId: input.key.targetId,
      targetAccountId: input.key.targetAccountId,
      status: 'CREATING',
      health: 'UNKNOWN',
      authState: 'UNKNOWN',
      ownerWorkerId: input.ownerWorkerId,
      generation,
      fencingToken: 0,
      version: 0,
      profileKey: profileKeyFor(input.key),
      reusePolicy: input.reusePolicy,
      idleTtlSeconds: input.idleTtlSeconds,
      maxLifetimeSeconds: input.maxLifetimeSeconds,
      expiresAt,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    return { ok: true, session: toSession(row!) }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const name = constraintName(error) ?? ''
      if (name.includes('browser_sessions_key_live')) {
        throw new SessionDomainError('SESSION_BUSY', '同键已有活会话')
      }
    }
    throw error
  }
}

export async function requireCreatedSession(
  db: Db,
  input: CreateSessionInput,
): Promise<SessionRecord> {
  const created = await createSession(db, input)
  if (!created.ok) throw new SessionDomainError(created.code, created.message)
  return created.session
}

/** D3b：本进程可提前回收的空闲会话。带租约或认证占用的不能腾。 */
export async function findEvictableSession(
  db: Db,
  workerId: string,
): Promise<SessionRecord | null> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        eq(browserSessions.status, 'OPEN'),
        isNull(browserSessions.authHoldWorkerId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${sessionLeases} l
           WHERE l.session_id = ${browserSessions.id}
             AND l.status = 'ACTIVE'
        )`,
      ),
    )
    .orderBy(asc(browserSessions.lastUsedAt), asc(browserSessions.id))
    .limit(1)
  return row ? toSession(row) : null
}

export async function setSessionStatus(
  db: Db,
  input: {
    sessionId: string
    expectedVersion: number
    status: SessionStatus
    closeReason?: string | null
    ownerWorkerId?: string
  },
): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  const now = new Date()
  const closed = input.status === 'CLOSED'
  const conditions = [
    eq(browserSessions.id, input.sessionId),
    eq(browserSessions.version, input.expectedVersion),
  ]
  if (input.ownerWorkerId) {
    conditions.push(eq(browserSessions.ownerWorkerId, input.ownerWorkerId))
  }
  const [row] = await updateRows(
    db,
    browserSessions,
    {
      status: input.status,
      version: input.expectedVersion + 1,
      updatedAt: now,
      ...(closed
        ? {
            closedAt: now,
            closeReason: input.closeReason ?? 'closed',
          }
        : {}),
      ...(input.status === 'CLOSING' || input.status === 'LOST'
        ? { closeReason: input.closeReason ?? null }
        : {}),
    },
    and(...conditions),
    { id: browserSessions.id },
  )
  return row !== undefined
}

export async function setSessionProbe(
  db: Db,
  input: {
    sessionId: string
    ownerWorkerId: string
    health?: SessionHealth
    authState?: SessionAuthState
  },
): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  if (input.health === undefined && input.authState === undefined) return false
  const [row] = await updateRows(
    db,
    browserSessions,
    {
      ...(input.health !== undefined ? { health: input.health } : {}),
      ...(input.authState !== undefined ? { authState: input.authState } : {}),
      updatedAt: new Date(),
    },
    and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.ownerWorkerId, input.ownerWorkerId),
      ne(browserSessions.status, 'CLOSED'),
    ),
    { id: browserSessions.id },
  )
  return row !== undefined
}

export async function touchSessionUsed(
  db: Db,
  input: { sessionId: string; ownerWorkerId: string },
): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  const [row] = await updateRows(
    db,
    browserSessions,
    { lastUsedAt: databaseNow(db), updatedAt: databaseNow(db) },
    and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.ownerWorkerId, input.ownerWorkerId),
      eq(browserSessions.status, 'OPEN'),
    ),
    { id: browserSessions.id },
  )
  return row !== undefined
}

export async function claimAuthHold(
  db: Db,
  input: {
    sessionId: string
    workerId: string
    holdSeconds: number
    runId: string
    sessionGeneration: number
    workerInstanceId: string
  },
): Promise<boolean> {
  if (!input.runId || input.sessionGeneration === undefined || !input.workerInstanceId) {
    throw badRequest('AUTH_HOLD_UNBOUND', '认证占用必须绑定 Run、会话代次与 Worker 进程')
  }
  const { browserSessions } = schemaFor(db)
  const now = await clockNow(db)
  const expires = new Date(now.getTime() + input.holdSeconds * 1000)
  const [row] = await updateRows(
    db,
    browserSessions,
    {
      authHoldWorkerId: input.workerId,
      authHoldExpiresAt: expires,
      authHoldRunId: input.runId,
      authHoldSessionGeneration: input.sessionGeneration,
      authHoldWorkerInstanceId: input.workerInstanceId,
      updatedAt: now,
    },
    and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.status, 'OPEN'),
      isNull(browserSessions.authHoldWorkerId),
    ),
    { id: browserSessions.id },
  )
  return row !== undefined
}

export async function releaseAuthHold(
  db: Db,
  input: { sessionId: string; workerId: string },
): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  const [row] = await updateRows(
    db,
    browserSessions,
    {
      authHoldWorkerId: null,
      authHoldExpiresAt: null,
      authHoldRunId: null,
      authHoldSessionGeneration: null,
      authHoldWorkerInstanceId: null,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      updatedAt: new Date(),
    },
    and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.authHoldWorkerId, input.workerId),
    ),
    { id: browserSessions.id },
  )
  return row !== undefined
}

/**
 * 获取租约：幂等（同 session+run+holder 已有 ACTIVE 则返回）+ 行锁 bump fencing。
 * 到期用库钟：`now() + make_interval`。
 */
export async function acquireSessionLease(
  db: Db,
  input: {
    sessionId: string
    runId: string
    holderWorkerId: string
    leaseTtlSeconds: number
    runFencingToken: number
    leaseId?: string
  },
): Promise<LeaseOutcome> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  if (!Number.isInteger(input.runFencingToken) || input.runFencingToken < 1) {
    return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
  }
  return db.transaction(async (tx) => {
    // 双锁顺序：先 Run 后 Session。反过来会与 finishAttempt 交叉死锁。
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run) return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }

    const [existing] = await tx
      .select()
      .from(sessionLeases)
      .where(
        and(
          eq(sessionLeases.sessionId, input.sessionId),
          eq(sessionLeases.runId, input.runId),
          eq(sessionLeases.holderWorkerId, input.holderWorkerId),
          eq(sessionLeases.status, 'ACTIVE'),
        ),
      )
      .limit(1)
    if (existing) {
      return { ok: true as const, lease: toLease(existing), created: false }
    }

    // 行锁串行化同会话并发获取
    const [sessionRow] = await locked(
      tx,
      tx.select().from(browserSessions).where(eq(browserSessions.id, input.sessionId)),
    )
    if (!sessionRow || sessionRow.status !== 'OPEN' || sessionRow.health === 'UNHEALTHY') {
      return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
    }

    const [active] = await tx
      .select()
      .from(sessionLeases)
      .where(and(eq(sessionLeases.sessionId, input.sessionId), eq(sessionLeases.status, 'ACTIVE')))
      .limit(1)
    if (active) {
      return {
        ok: false as const,
        code: 'SESSION_BUSY' as const,
        busy: {
          code: 'SESSION_BUSY',
          holderWorkerId: active.holderWorkerId,
          expiresAt: active.expiresAt,
          leaseId: active.id,
        },
      }
    }

    const [bumped] = await updateRows(
      tx,
      browserSessions,
      {
        fencingToken: sql`${browserSessions.fencingToken} + 1`,
        lastUsedAt: databaseNow(db),
        updatedAt: databaseNow(db),
      },
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.status, 'OPEN'),
        ne(browserSessions.health, 'UNHEALTHY'),
      ),
      {
        id: browserSessions.id,
        generation: browserSessions.generation,
        fencingToken: browserSessions.fencingToken,
      },
    )
    if (!bumped) {
      return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
    }

    const leaseId = input.leaseId ?? newId()
    try {
      const [lease] = await insertRows(tx, sessionLeases, {
        id: leaseId,
        sessionId: bumped.id,
        sessionGeneration: bumped.generation,
        sessionFencingToken: bumped.fencingToken,
        runId: input.runId,
        runFencingToken: input.runFencingToken,
        holderWorkerId: input.holderWorkerId,
        status: 'ACTIVE',
        expiresAt: afterSeconds(db, input.leaseTtlSeconds),
      })
      return { ok: true as const, lease: toLease(lease!), created: true }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const [busy] = await tx
          .select()
          .from(sessionLeases)
          .where(
            and(eq(sessionLeases.sessionId, input.sessionId), eq(sessionLeases.status, 'ACTIVE')),
          )
          .limit(1)
        if (busy) {
          return {
            ok: false as const,
            code: 'SESSION_BUSY' as const,
            busy: {
              code: 'SESSION_BUSY',
              holderWorkerId: busy.holderWorkerId,
              expiresAt: busy.expiresAt,
              leaseId: busy.id,
            },
          }
        }
      }
      throw error
    }
  })
}

export async function renewSessionLease(
  db: Db,
  input: { leaseId: string; holderWorkerId: string; leaseTtlSeconds: number },
): Promise<LeaseRecord | null> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  const [row] = await updateRows(
    db,
    sessionLeases,
    {
      expiresAt: afterSeconds(db, input.leaseTtlSeconds),
      heartbeatAt: databaseNow(db),
    },
    and(
      eq(sessionLeases.id, input.leaseId),
      eq(sessionLeases.holderWorkerId, input.holderWorkerId),
      eq(sessionLeases.status, 'ACTIVE'),
      sql`${sessionLeases.expiresAt} > ${databaseNow(db)}`,
      sql`EXISTS (SELECT 1 FROM ${browserSessions} s WHERE s.id = ${sessionLeases.sessionId}
      AND s.status = 'OPEN' AND s.generation = ${sessionLeases.sessionGeneration})`,
    ),
  )
  return row ? toLease(row) : null
}

export async function releaseSessionLease(
  db: Db,
  input: { leaseId: string; holderWorkerId: string; reason: string },
): Promise<'released' | 'already' | 'unknown'> {
  const { sessionLeases } = schemaFor(db)
  const [updated] = await updateRows(
    db,
    sessionLeases,
    {
      status: 'RELEASED',
      releasedAt: new Date(),
      releaseReason: input.reason,
    },
    and(
      eq(sessionLeases.id, input.leaseId),
      eq(sessionLeases.holderWorkerId, input.holderWorkerId),
      eq(sessionLeases.status, 'ACTIVE'),
    ),
    { id: sessionLeases.id },
  )
  if (updated) return 'released'

  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(eq(sessionLeases.id, input.leaseId))
    .limit(1)
  if (!row) return 'unknown'
  if (row.status !== 'ACTIVE') return 'already'
  return 'unknown'
}

export async function expireStaleLeases(db: Db, limit = 100): Promise<number> {
  const { sessionLeases } = schemaFor(db)
  return db.transaction(async (tx) => {
    const rows = await locked(
      tx,
      tx
        .select({ id: sessionLeases.id })
        .from(sessionLeases)
        .where(
          and(
            eq(sessionLeases.status, 'ACTIVE'),
            sql`${sessionLeases.expiresAt} <= ${databaseNow(db)}`,
          ),
        )
        .orderBy(sessionLeases.expiresAt, sessionLeases.id)
        .limit(limit),
      true,
    )
    if (!rows.length) return 0
    await tx
      .update(sessionLeases)
      .set({ status: 'EXPIRED', releasedAt: databaseNow(db), releaseReason: 'lease_expired' })
      .where(
        inArray(
          sessionLeases.id,
          rows.map((row) => row.id),
        ),
      )
    return rows.length
  })
}

export async function listReapableSessions(
  db: Db,
  workerId: string,
  limit = 50,
): Promise<SessionRecord[]> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  const rows = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        eq(browserSessions.status, 'OPEN'),
        isNull(browserSessions.authHoldWorkerId),
        sql`NOT EXISTS (SELECT 1 FROM ${sessionLeases} l WHERE l.session_id = ${browserSessions.id} AND l.status = 'ACTIVE')`,
        or(
          sql`${afterSeconds(db, browserSessions.idleTtlSeconds, browserSessions.lastUsedAt)} <= ${databaseNow(db)}`,
          sql`${browserSessions.expiresAt} <= ${databaseNow(db)}`,
        ),
      ),
    )
    .orderBy(browserSessions.lastUsedAt, browserSessions.id)
    .limit(limit)
  return rows.map(toSession)
}

export async function markSessionsClosing(
  db: Db,
  input: { workerId: string; sessionIds: string[]; reason: string },
): Promise<string[]> {
  const { browserSessions } = schemaFor(db)
  if (input.sessionIds.length === 0) return []
  const updated: string[] = []
  for (const sessionId of input.sessionIds) {
    const [row] = await updateRows(
      db,
      browserSessions,
      {
        status: 'CLOSING',
        version: sql`${browserSessions.version} + 1`,
        updatedAt: new Date(),
        closeReason: input.reason,
      },
      and(
        eq(browserSessions.id, sessionId),
        eq(browserSessions.ownerWorkerId, input.workerId),
        eq(browserSessions.status, 'OPEN'),
      ),
      { id: browserSessions.id },
    )
    if (row) updated.push(row.id)
  }
  return updated
}

export async function revokeWorkerLeases(db: Db, workerId: string): Promise<number> {
  const { sessionLeases } = schemaFor(db)
  const rows = await updateRows(
    db,
    sessionLeases,
    {
      status: 'REVOKED',
      releasedAt: new Date(),
      releaseReason: 'worker_restart',
    },
    and(eq(sessionLeases.status, 'ACTIVE'), eq(sessionLeases.holderWorkerId, workerId)),
    { id: sessionLeases.id },
  )
  return rows.length
}

/**
 * 失联 Worker 名下未关闭的浏览器会话标 LOST。
 * 只动 browser_sessions，不碰控制台账号，也不碰目标账号。
 */
export async function markSessionsLostForWorkers(db: Db, workerIds: string[]): Promise<number> {
  const { browserSessions } = schemaFor(db)
  if (workerIds.length === 0) return 0
  const now = new Date()
  const rows = await updateRows(
    db,
    browserSessions,
    {
      status: 'LOST',
      updatedAt: now,
      version: sql`${browserSessions.version} + 1`,
    },
    and(
      inArray(browserSessions.ownerWorkerId, workerIds),
      inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
    ),
    { id: browserSessions.id },
  )
  return rows.length
}

export async function closeWorkerSessions(db: Db, workerId: string): Promise<number> {
  const { browserSessions } = schemaFor(db)
  const rows = await updateRows(
    db,
    browserSessions,
    {
      status: 'CLOSED',
      closedAt: new Date(),
      closeReason: 'worker_restart',
      version: sql`${browserSessions.version} + 1`,
      updatedAt: new Date(),
    },
    and(
      eq(browserSessions.ownerWorkerId, workerId),
      inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
    ),
    { id: browserSessions.id },
  )
  return rows.length
}

/**
 * 提交边界：Attempt 写成功结果前校验租约仍 ACTIVE、holder 与 token 匹配、会话 OPEN 且未换代。
 */
export async function verifySessionLeaseForCommit(
  db: Db,
  grant: SessionGrant & { holderWorkerId: string },
): Promise<boolean> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  const rows = await db
    .select({ id: sessionLeases.id })
    .from(sessionLeases)
    .innerJoin(browserSessions, eq(browserSessions.id, sessionLeases.sessionId))
    .where(
      and(
        eq(sessionLeases.id, grant.leaseId),
        eq(sessionLeases.holderWorkerId, grant.holderWorkerId),
        eq(sessionLeases.status, 'ACTIVE'),
        sql`${sessionLeases.expiresAt} > ${databaseNow(db)}`,
        eq(sessionLeases.sessionFencingToken, grant.sessionFencingToken),
        eq(sessionLeases.sessionGeneration, grant.generation),
        eq(browserSessions.id, grant.sessionId),
        eq(browserSessions.status, 'OPEN'),
        eq(browserSessions.generation, grant.generation),
      ),
    )
    .limit(1)
  return rows.length > 0
}

export async function findActiveLeaseForSession(
  db: Db,
  sessionId: string,
): Promise<LeaseRecord | null> {
  const { sessionLeases } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.sessionId, sessionId), eq(sessionLeases.status, 'ACTIVE')))
    .limit(1)
  return row ? toLease(row) : null
}

export async function listActiveSessionLeasesForWorker(
  db: Db,
  workerId: string,
): Promise<LeaseRecord[]> {
  const { sessionLeases } = schemaFor(db)
  const rows = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.holderWorkerId, workerId), eq(sessionLeases.status, 'ACTIVE')))
    .orderBy(asc(sessionLeases.acquiredAt))
  return rows.map(toLease)
}

/** owner 名下仍占键的会话，含 LOST。自愈停浏览器时用。 */
export async function listOwnedLiveSessions(db: Db, workerId: string): Promise<SessionRecord[]> {
  const { browserSessions } = schemaFor(db)
  const rows = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        inArray(browserSessions.status, LIVE_STATUSES),
      ),
    )
  return rows.map(toSession)
}

export async function listOwnedOpenSessions(db: Db, workerId: string): Promise<SessionRecord[]> {
  const { browserSessions } = schemaFor(db)
  const rows = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      ),
    )
  return rows.map(toSession)
}

/** 仅测试 / 排障：把 last_used_at 拨到过去。 */
export async function forceLastUsedAt(db: Db, sessionId: string, at: Date): Promise<void> {
  const { browserSessions } = schemaFor(db)
  await db
    .update(browserSessions)
    .set({ lastUsedAt: at, updatedAt: new Date() })
    .where(eq(browserSessions.id, sessionId))
}

/** 仅测试：把租约 expires_at 拨到过去。 */
export async function forceLeaseExpiresAt(db: Db, leaseId: string, at: Date): Promise<void> {
  const { sessionLeases } = schemaFor(db)
  await db
    .update(sessionLeases)
    .set({ expiresAt: at })
    .where(and(eq(sessionLeases.id, leaseId), eq(sessionLeases.status, 'ACTIVE')))
}

/** 仅测试：强制改 generation（续租换代判定）。 */
export async function forceSessionGeneration(
  db: Db,
  sessionId: string,
  generation: number,
): Promise<void> {
  const { browserSessions } = schemaFor(db)
  await db
    .update(browserSessions)
    .set({ generation, updatedAt: new Date() })
    .where(eq(browserSessions.id, sessionId))
}

/**
 * 本 Worker 名下已过期的认证占用。
 * 超时后清占用、置 auth_state=EXPIRED，会话保持 OPEN（不关浏览器）。
 */
export async function listExpiredAuthHolds(
  db: Db,
  workerId: string,
  limit = 50,
): Promise<SessionRecord[]> {
  const { browserSessions } = schemaFor(db)
  const rows = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        eq(browserSessions.status, 'OPEN'),
        isNotNull(browserSessions.authHoldWorkerId),
        isNotNull(browserSessions.authHoldExpiresAt),
        sql`${browserSessions.authHoldExpiresAt} <= ${databaseNow(db)}`,
      ),
    )
    .orderBy(browserSessions.authHoldExpiresAt, browserSessions.id)
    .limit(limit)
  return rows.map(toSession)
}

export async function expireAuthHold(
  db: Db,
  input: { sessionId: string; workerId: string },
): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  const [row] = await updateRows(
    db,
    browserSessions,
    {
      authHoldWorkerId: null,
      authHoldExpiresAt: null,
      authHoldRunId: null,
      authHoldSessionGeneration: null,
      authHoldWorkerInstanceId: null,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      authState: 'EXPIRED',
      updatedAt: new Date(),
    },
    and(
      eq(browserSessions.id, input.sessionId),
      eq(browserSessions.ownerWorkerId, input.workerId),
      eq(browserSessions.status, 'OPEN'),
    ),
    { id: browserSessions.id },
  )
  return row !== undefined
}

/** 登记一条不绑定 TargetAccount 的独立 Secret，供模型密钥等使用。 */
export async function registerStandaloneSecret(
  db: Db,
  input: { id: string; ciphertext: Buffer },
): Promise<{ id: string }> {
  const now = new Date()
  const { secrets: table } = schemaFor(db)
  await db.insert(table).values({
    id: input.id,
    provider: LOCAL_SECRET_PROVIDER,
    ciphertext: input.ciphertext,
    createdAt: now,
    updatedAt: now,
  })
  return { id: input.id }
}

/** 读取 secrets 密文（不解密）。 */
export async function loadSecretCiphertext(
  db: Db,
  secretId: string,
): Promise<{ id: string; provider: string; ciphertext: Buffer } | null> {
  const { secrets } = schemaFor(db)
  const [row] = await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1)
  if (!row) return null
  return { id: row.id, provider: row.provider, ciphertext: row.ciphertext }
}

/** 占着键的会话：CLOSED 之外的全部状态。控制面列表只给这一批。 */
export async function listSessions(db: Db): Promise<SessionDto[]> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  const rows = await db
    .select()
    .from(browserSessions)
    .where(inArray(browserSessions.status, LIVE_STATUSES))
    .orderBy(desc(browserSessions.createdAt), desc(browserSessions.id))
  if (rows.length === 0) return []

  const leases = await db
    .select()
    .from(sessionLeases)
    .where(
      and(
        inArray(
          sessionLeases.sessionId,
          rows.map((row) => row.id),
        ),
        eq(sessionLeases.status, 'ACTIVE'),
      ),
    )
  const leaseBySession = new Map(leases.map((lease) => [lease.sessionId, lease]))
  return rows.map((row) => toSessionDto(row, leaseBySession.get(row.id) ?? null))
}

/** 行 → 控制面 DTO。只暴露元数据（§12：API 不持有会话）。 */
export function toSessionDto(row: BrowserSessionRow, lease: SessionLeaseRow | null): SessionDto {
  return sessionDtoSchema.parse({
    id: row.id,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    status: row.status,
    health: row.health,
    authState: row.authState,
    ownerWorkerId: row.ownerWorkerId,
    generation: row.generation,
    reusePolicy: row.reusePolicy,
    profileKey: row.profileKey,
    idleTtlSeconds: row.idleTtlSeconds,
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    authHold:
      row.authHoldWorkerId && row.authHoldExpiresAt
        ? {
            workerId: row.authHoldWorkerId,
            expiresAt: row.authHoldExpiresAt.toISOString(),
            runId: row.authHoldRunId,
            bound: Boolean(row.authHoldRunId && row.authHoldSessionGeneration && row.authHoldWorkerInstanceId),
          }
        : null,
    authControl: {
      epoch: row.authControlEpoch,
      actorId: row.authControlActorId,
      expiresAt: row.authControlExpiresAt?.toISOString() ?? null,
    },
    closeReason: row.closeReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    activeLease: lease
      ? {
          id: lease.id,
          runId: lease.runId,
          holderWorkerId: lease.holderWorkerId,
          acquiredAt: lease.acquiredAt.toISOString(),
          expiresAt: lease.expiresAt.toISOString(),
        }
      : null,
    disposable: DISPOSABLE_SESSION_STATUSES.includes(row.status),
  })
}

/** 人工可处置的状态：owner 已不在或已无法推进的那些。`OPEN` 必须走 owner 自己的回收。 */
export const DISPOSABLE_SESSION_STATUSES: readonly SessionStatus[] = ['CREATING', 'CLOSING', 'LOST']

/**
 * 人工处置卡死会话：确认旧浏览器已停或已隔离后，释放 Target + TargetAccount 的键。
 *
 * 控制面只改状态，不碰浏览器——它没有句柄，也无法验证进程是否真的退出，所以
 * 「已停止」由调用方声明并进审计。`OPEN` 一律拒绝：那是活会话，放行等于同账号双开。
 *
 * 撤租约、关会话、写审计在同一事务；对已 CLOSED 幂等返回。
 */
export async function disposeStuckSession(
  db: Db,
  input: { sessionId: string; actor: AuditActor; note?: string },
): Promise<SessionDto> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  return db.transaction(async (tx) => {
    // 行锁：与同一会话的 acquire / owner 回收串行，避免处置与领取交错。
    const found = await locked(
      tx,
      tx
        .select({ id: browserSessions.id })
        .from(browserSessions)
        .where(eq(browserSessions.id, input.sessionId)),
    )
    if (found.length === 0) {
      throw notFound('SESSION_NOT_FOUND', '会话不存在')
    }

    const session = (await getSessionById(tx as unknown as Db, input.sessionId))!
    if (session.status === 'CLOSED') {
      return toSessionDto(await loadSessionRow(tx as unknown as Db, input.sessionId), null)
    }
    if (!DISPOSABLE_SESSION_STATUSES.includes(session.status)) {
      throw conflict(
        'SESSION_NOT_DISPOSABLE',
        `会话处于 ${session.status}，必须由持有它的 Worker 回收`,
      )
    }

    const revoked = await updateRows(
      tx,
      sessionLeases,
      { status: 'REVOKED', releasedAt: new Date(), releaseReason: 'operator_disposed' },
      and(eq(sessionLeases.sessionId, input.sessionId), eq(sessionLeases.status, 'ACTIVE')),
      { id: sessionLeases.id },
    )

    const now = new Date()
    const [closed] = await updateRows(
      tx,
      browserSessions,
      {
        status: 'CLOSED',
        closedAt: now,
        closeReason: 'operator_disposed',
        // 处置就是收回一切占用：认证占用不能留在一个已关闭的会话上。
        authHoldWorkerId: null,
        authHoldExpiresAt: null,
        version: sql`${browserSessions.version} + 1`,
        updatedAt: now,
      },
      eq(browserSessions.id, input.sessionId),
    )

    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'session.dispose',
      'session',
      input.sessionId,
      [
        `处置会话 ${session.status}（${session.profileKey}，owner ${session.ownerWorkerId}）`,
        `撤销租约 ${revoked.length} 条`,
        input.note ? `说明：${input.note}` : null,
      ]
        .filter(Boolean)
        .join('；'),
    )

    return toSessionDto(closed!, null)
  })
}

async function loadSessionRow(db: Db, sessionId: string): Promise<BrowserSessionRow> {
  const { browserSessions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(eq(browserSessions.id, sessionId))
    .limit(1)
  return row!
}
