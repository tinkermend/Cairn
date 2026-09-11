import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import {
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
import { newId } from '../id.js'
import { constraintName, pgCode, conflict, notFound } from '../runs/errors.js'
import {
  browserSessions,
  sessionLeases,
  type BrowserSessionRow,
  type SessionLeaseRow,
} from '../schema/session.js'
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
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(eq(browserSessions.id, sessionId))
    .limit(1)
  return row ? toSession(row) : null
}

export async function getLeaseById(db: Db, leaseId: string): Promise<LeaseRecord | null> {
  const [row] = await db.select().from(sessionLeases).where(eq(sessionLeases.id, leaseId)).limit(1)
  return row ? toLease(row) : null
}

export async function countOpenSessionsForWorker(db: Db, workerId: string): Promise<number> {
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

export async function createSession(db: Db, input: CreateSessionInput): Promise<CreateSessionResult> {
  if (input.maxLifetimeSeconds <= input.idleTtlSeconds) {
    return {
      ok: false,
      code: 'SESSION_POLICY_INVALID',
      message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
    }
  }
  const generation = await nextGenerationForKey(db, input.key)
  const id = input.id ?? newId()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + input.maxLifetimeSeconds * 1000)
  try {
    const [row] = await db
      .insert(browserSessions)
      .values({
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
      .returning()
    return { ok: true, session: toSession(row!) }
  } catch (error) {
    if (pgCode(error) === '23505') {
      const name = constraintName(error) ?? ''
      if (name.includes('browser_sessions_key_live')) {
        throw new SessionDomainError('SESSION_BUSY', '同键已有活会话')
      }
    }
    throw error
  }
}

export async function requireCreatedSession(db: Db, input: CreateSessionInput): Promise<SessionRecord> {
  const created = await createSession(db, input)
  if (!created.ok) throw new SessionDomainError(created.code, created.message)
  return created.session
}

/** D3b：本进程可提前回收的空闲会话。带租约或认证占用的不能腾。 */
export async function findEvictableSession(db: Db, workerId: string): Promise<SessionRecord | null> {
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
  const now = new Date()
  const closed = input.status === 'CLOSED'
  const conditions = [
    eq(browserSessions.id, input.sessionId),
    eq(browserSessions.version, input.expectedVersion),
  ]
  if (input.ownerWorkerId) {
    conditions.push(eq(browserSessions.ownerWorkerId, input.ownerWorkerId))
  }
  const [row] = await db
    .update(browserSessions)
    .set({
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
    })
    .where(and(...conditions))
    .returning({ id: browserSessions.id })
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
  if (input.health === undefined && input.authState === undefined) return false
  const [row] = await db
    .update(browserSessions)
    .set({
      ...(input.health !== undefined ? { health: input.health } : {}),
      ...(input.authState !== undefined ? { authState: input.authState } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.ownerWorkerId, input.ownerWorkerId),
        ne(browserSessions.status, 'CLOSED'),
      ),
    )
    .returning({ id: browserSessions.id })
  return row !== undefined
}

export async function touchSessionUsed(
  db: Db,
  input: { sessionId: string; ownerWorkerId: string },
): Promise<boolean> {
  const [row] = await db
    .update(browserSessions)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.ownerWorkerId, input.ownerWorkerId),
        eq(browserSessions.status, 'OPEN'),
      ),
    )
    .returning({ id: browserSessions.id })
  return row !== undefined
}

export async function claimAuthHold(
  db: Db,
  input: { sessionId: string; workerId: string; holdSeconds: number },
): Promise<boolean> {
  const now = new Date()
  const expires = new Date(now.getTime() + input.holdSeconds * 1000)
  const [row] = await db
    .update(browserSessions)
    .set({
      authHoldWorkerId: input.workerId,
      authHoldExpiresAt: expires,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.status, 'OPEN'),
        isNull(browserSessions.authHoldWorkerId),
      ),
    )
    .returning({ id: browserSessions.id })
  return row !== undefined
}

export async function releaseAuthHold(
  db: Db,
  input: { sessionId: string; workerId: string },
): Promise<boolean> {
  const [row] = await db
    .update(browserSessions)
    .set({
      authHoldWorkerId: null,
      authHoldExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.authHoldWorkerId, input.workerId),
      ),
    )
    .returning({ id: browserSessions.id })
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
    const locked = await tx.execute(sql`
      SELECT id, status, health, generation, fencing_token
        FROM ${browserSessions}
       WHERE id = ${input.sessionId}
       FOR UPDATE
    `)
    const sessionRow = locked.rows[0] as
      | {
          id: string
          status: string
          health: string
          generation: number
          fencing_token: number
        }
      | undefined
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

    const [bumped] = await tx
      .update(browserSessions)
      .set({
        fencingToken: sql`${browserSessions.fencingToken} + 1`,
        lastUsedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(browserSessions.id, input.sessionId),
          eq(browserSessions.status, 'OPEN'),
          ne(browserSessions.health, 'UNHEALTHY'),
        ),
      )
      .returning({
        id: browserSessions.id,
        generation: browserSessions.generation,
        fencingToken: browserSessions.fencingToken,
      })
    if (!bumped) {
      return { ok: false as const, code: 'SESSION_NOT_CLAIMABLE' as const }
    }

    const leaseId = input.leaseId ?? newId()
    try {
      const [lease] = await tx
        .insert(sessionLeases)
        .values({
          id: leaseId,
          sessionId: bumped.id,
          sessionGeneration: bumped.generation,
          sessionFencingToken: bumped.fencingToken,
          runId: input.runId,
          runFencingToken: input.runFencingToken,
          holderWorkerId: input.holderWorkerId,
          status: 'ACTIVE',
          expiresAt: sql`now() + make_interval(secs => ${input.leaseTtlSeconds})`,
        })
        .returning()
      return { ok: true as const, lease: toLease(lease!), created: true }
    } catch (error) {
      if (pgCode(error) === '23505') {
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
  const result = await db.execute(sql`
    UPDATE session_leases AS l
       SET expires_at = now() + make_interval(secs => ${input.leaseTtlSeconds}),
           heartbeat_at = now()
     WHERE l.id = ${input.leaseId}
       AND l.holder_worker_id = ${input.holderWorkerId}
       AND l.status = 'ACTIVE'
       AND l.expires_at > now()
       AND EXISTS (
         SELECT 1 FROM browser_sessions s
          WHERE s.id = l.session_id
            AND s.status = 'OPEN'
            AND s.generation = l.session_generation
       )
    RETURNING l.id, l.session_id, l.session_generation, l.session_fencing_token, l.run_id,
              l.run_fencing_token, l.holder_worker_id, l.status, l.acquired_at, l.heartbeat_at,
              l.expires_at, l.released_at, l.release_reason
  `)
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return mapLeaseRow(row)
}

function mapLeaseRow(row: Record<string, unknown>): LeaseRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sessionGeneration: Number(row.session_generation),
    sessionFencingToken: Number(row.session_fencing_token),
    runId: String(row.run_id),
    runFencingToken: row.run_fencing_token === null || row.run_fencing_token === undefined
      ? null
      : Number(row.run_fencing_token),
    holderWorkerId: String(row.holder_worker_id),
    status: row.status as SessionLeaseRow['status'],
    acquiredAt: new Date(String(row.acquired_at)),
    heartbeatAt: new Date(String(row.heartbeat_at)),
    expiresAt: new Date(String(row.expires_at)),
    releasedAt: row.released_at ? new Date(String(row.released_at)) : null,
    releaseReason: row.release_reason === null || row.release_reason === undefined
      ? null
      : String(row.release_reason),
  }
}

export async function releaseSessionLease(
  db: Db,
  input: { leaseId: string; holderWorkerId: string; reason: string },
): Promise<'released' | 'already' | 'unknown'> {
  const [updated] = await db
    .update(sessionLeases)
    .set({
      status: 'RELEASED',
      releasedAt: new Date(),
      releaseReason: input.reason,
    })
    .where(
      and(
        eq(sessionLeases.id, input.leaseId),
        eq(sessionLeases.holderWorkerId, input.holderWorkerId),
        eq(sessionLeases.status, 'ACTIVE'),
      ),
    )
    .returning({ id: sessionLeases.id })
  if (updated) return 'released'

  const [row] = await db.select().from(sessionLeases).where(eq(sessionLeases.id, input.leaseId)).limit(1)
  if (!row) return 'unknown'
  if (row.status !== 'ACTIVE') return 'already'
  return 'unknown'
}

export async function expireStaleLeases(db: Db, limit = 100): Promise<number> {
  const result = await db.execute(sql`
    UPDATE session_leases
       SET status = 'EXPIRED',
           released_at = now(),
           release_reason = 'lease_expired'
     WHERE id IN (
       SELECT id FROM session_leases
        WHERE status = 'ACTIVE' AND expires_at <= now()
        ORDER BY expires_at
        LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  `)
  return result.rows.length
}

export async function listReapableSessions(
  db: Db,
  workerId: string,
  limit = 50,
): Promise<SessionRecord[]> {
  const result = await db.execute(sql`
    SELECT s.id
      FROM browser_sessions s
     WHERE s.owner_worker_id = ${workerId}
       AND s.status = 'OPEN'
       AND s.auth_hold_worker_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM session_leases l
          WHERE l.session_id = s.id AND l.status = 'ACTIVE'
       )
       AND (
         s.last_used_at + make_interval(secs => s.idle_ttl_seconds) <= now()
         OR s.expires_at <= now()
       )
     ORDER BY s.last_used_at
     LIMIT ${limit}
  `)
  const ids = result.rows.map((r) => String((r as { id: string }).id))
  if (ids.length === 0) return []
  const rows = await db.select().from(browserSessions).where(inArray(browserSessions.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => toSession(byId.get(id)!)).filter(Boolean)
}

export async function markSessionsClosing(
  db: Db,
  input: { workerId: string; sessionIds: string[]; reason: string },
): Promise<string[]> {
  if (input.sessionIds.length === 0) return []
  const updated: string[] = []
  for (const sessionId of input.sessionIds) {
    const [row] = await db
      .update(browserSessions)
      .set({
        status: 'CLOSING',
        version: sql`${browserSessions.version} + 1`,
        updatedAt: new Date(),
        closeReason: input.reason,
      })
      .where(
        and(
          eq(browserSessions.id, sessionId),
          eq(browserSessions.ownerWorkerId, input.workerId),
          eq(browserSessions.status, 'OPEN'),
        ),
      )
      .returning({ id: browserSessions.id })
    if (row) updated.push(row.id)
  }
  return updated
}

export async function revokeWorkerLeases(db: Db, workerId: string): Promise<number> {
  const rows = await db
    .update(sessionLeases)
    .set({
      status: 'REVOKED',
      releasedAt: new Date(),
      releaseReason: 'worker_restart',
    })
    .where(and(eq(sessionLeases.status, 'ACTIVE'), eq(sessionLeases.holderWorkerId, workerId)))
    .returning({ id: sessionLeases.id })
  return rows.length
}

/**
 * 失联 Worker 名下未关闭的浏览器会话标 LOST。
 * 只动 browser_sessions，不碰控制台账号，也不碰目标账号。
 */
export async function markSessionsLostForWorkers(db: Db, workerIds: string[]): Promise<number> {
  if (workerIds.length === 0) return 0
  const now = new Date()
  const rows = await db
    .update(browserSessions)
    .set({
      status: 'LOST',
      updatedAt: now,
      version: sql`${browserSessions.version} + 1`,
    })
    .where(
      and(
        inArray(browserSessions.ownerWorkerId, workerIds),
        inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      ),
    )
    .returning({ id: browserSessions.id })
  return rows.length
}

export async function closeWorkerSessions(db: Db, workerId: string): Promise<number> {
  const rows = await db
    .update(browserSessions)
    .set({
      status: 'CLOSED',
      closedAt: new Date(),
      closeReason: 'worker_restart',
      version: sql`${browserSessions.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING']),
      ),
    )
    .returning({ id: browserSessions.id })
  return rows.length
}

/**
 * 提交边界：Attempt 写成功结果前校验租约仍 ACTIVE、holder 与 token 匹配、会话 OPEN 且未换代。
 */
export async function verifySessionLeaseForCommit(
  db: Db,
  grant: SessionGrant & { holderWorkerId: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
      FROM session_leases l
      JOIN browser_sessions s ON s.id = l.session_id
     WHERE l.id = ${grant.leaseId}
       AND l.holder_worker_id = ${grant.holderWorkerId}
       AND l.status = 'ACTIVE'
       AND l.expires_at > now()
       AND l.session_fencing_token = ${grant.sessionFencingToken}
       AND l.session_generation = ${grant.generation}
       AND s.id = ${grant.sessionId}
       AND s.status = 'OPEN'
       AND s.generation = ${grant.generation}
     LIMIT 1
  `)
  return result.rows.length > 0
}

export async function findActiveLeaseForSession(
  db: Db,
  sessionId: string,
): Promise<LeaseRecord | null> {
  const [row] = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.sessionId, sessionId), eq(sessionLeases.status, 'ACTIVE')))
    .limit(1)
  return row ? toLease(row) : null
}

export async function listActiveSessionLeasesForWorker(db: Db, workerId: string): Promise<LeaseRecord[]> {
  const rows = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.holderWorkerId, workerId), eq(sessionLeases.status, 'ACTIVE')))
    .orderBy(asc(sessionLeases.acquiredAt))
  return rows.map(toLease)
}

/** owner 名下仍占键的会话，含 LOST。自愈停浏览器时用。 */
export async function listOwnedLiveSessions(db: Db, workerId: string): Promise<SessionRecord[]> {
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
  await db
    .update(browserSessions)
    .set({ lastUsedAt: at, updatedAt: new Date() })
    .where(eq(browserSessions.id, sessionId))
}

/** 仅测试：把租约 expires_at 拨到过去。 */
export async function forceLeaseExpiresAt(db: Db, leaseId: string, at: Date): Promise<void> {
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
  const result = await db.execute(sql`
    SELECT id FROM browser_sessions
     WHERE owner_worker_id = ${workerId}
       AND status = 'OPEN'
       AND auth_hold_worker_id IS NOT NULL
       AND auth_hold_expires_at IS NOT NULL
       AND auth_hold_expires_at <= now()
     ORDER BY auth_hold_expires_at
     LIMIT ${limit}
  `)
  const ids = result.rows.map((r) => String((r as { id: string }).id))
  if (ids.length === 0) return []
  const rows = await db.select().from(browserSessions).where(inArray(browserSessions.id, ids))
  return rows.map(toSession)
}

export async function expireAuthHold(
  db: Db,
  input: { sessionId: string; workerId: string },
): Promise<boolean> {
  const [row] = await db
    .update(browserSessions)
    .set({
      authHoldWorkerId: null,
      authHoldExpiresAt: null,
      authState: 'EXPIRED',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.ownerWorkerId, input.workerId),
        eq(browserSessions.status, 'OPEN'),
      ),
    )
    .returning({ id: browserSessions.id })
  return row !== undefined
}

/** 读取 secrets 密文（不解密）。 */
export async function loadSecretCiphertext(
  db: Db,
  secretId: string,
): Promise<{ id: string; provider: string; ciphertext: Buffer } | null> {
  const [row] = await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1)
  if (!row) return null
  return { id: row.id, provider: row.provider, ciphertext: row.ciphertext }
}

/** 占着键的会话：CLOSED 之外的全部状态。控制面列表只给这一批。 */
export async function listSessions(db: Db): Promise<SessionDto[]> {
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
        ? { workerId: row.authHoldWorkerId, expiresAt: row.authHoldExpiresAt.toISOString() }
        : null,
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
export const DISPOSABLE_SESSION_STATUSES: readonly SessionStatus[] = [
  'CREATING',
  'CLOSING',
  'LOST',
]

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
  return db.transaction(async (tx) => {
    // 行锁：与同一会话的 acquire / owner 回收串行，避免处置与领取交错。
    const locked = await tx.execute(sql`
      SELECT id FROM ${browserSessions} WHERE id = ${input.sessionId} FOR UPDATE
    `)
    if (locked.rows.length === 0) {
      throw notFound('SESSION_NOT_FOUND', '会话不存在')
    }

    const session = (await getSessionById(tx as unknown as Db, input.sessionId))!
    if (session.status === 'CLOSED') {
      return toSessionDto(
        await loadSessionRow(tx as unknown as Db, input.sessionId),
        null,
      )
    }
    if (!DISPOSABLE_SESSION_STATUSES.includes(session.status)) {
      throw conflict(
        'SESSION_NOT_DISPOSABLE',
        `会话处于 ${session.status}，必须由持有它的 Worker 回收`,
      )
    }

    const revoked = await tx
      .update(sessionLeases)
      .set({ status: 'REVOKED', releasedAt: new Date(), releaseReason: 'operator_disposed' })
      .where(and(eq(sessionLeases.sessionId, input.sessionId), eq(sessionLeases.status, 'ACTIVE')))
      .returning({ id: sessionLeases.id })

    const now = new Date()
    const [closed] = await tx
      .update(browserSessions)
      .set({
        status: 'CLOSED',
        closedAt: now,
        closeReason: 'operator_disposed',
        // 处置就是收回一切占用：认证占用不能留在一个已关闭的会话上。
        authHoldWorkerId: null,
        authHoldExpiresAt: null,
        version: sql`${browserSessions.version} + 1`,
        updatedAt: now,
      })
      .where(eq(browserSessions.id, input.sessionId))
      .returning()

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
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(eq(browserSessions.id, sessionId))
    .limit(1)
  return row!
}

