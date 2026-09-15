import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { AUTH_CONTROL_TTL_SECONDS, type RunGrant } from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { lockRunRow, releaseRunLeaseTx, verifyRunLeaseForWrite } from '../leases/leases.js'
import { clockNow, locked, schemaFor, updateRows } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import { conflict, notFound } from '../runs/errors.js'
import type { BrowserSessionRow } from '../records.js'
import type { SessionRecord } from './sessions.js'

export function hashAuthControlToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newAuthControlToken(): string {
  return randomBytes(32).toString('hex')
}

export async function lockSessionRow(tx: Db, sessionId: string): Promise<BrowserSessionRow | null> {
  const { browserSessions } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(browserSessions).where(eq(browserSessions.id, sessionId)))
  return row ?? null
}

export function isBoundAuthHold(
  session: Pick<
    SessionRecord,
    'authHoldWorkerId' | 'authHoldExpiresAt' | 'authHoldRunId' | 'authHoldSessionGeneration' | 'authHoldWorkerInstanceId'
  >,
): boolean {
  return Boolean(
    session.authHoldWorkerId &&
      session.authHoldExpiresAt &&
      session.authHoldRunId &&
      session.authHoldSessionGeneration &&
      session.authHoldWorkerInstanceId,
  )
}

export async function enterRunWaitingForAuth(
  db: Db,
  input: {
    grant: RunGrant
    sessionId: string
    workerId: string
    workerInstanceId: string
    holdSeconds: number
  },
): Promise<boolean> {
  const { browserSessions, runs } = schemaFor(db)
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, input.sessionId)
    const run = await lockRunRow(tx as unknown as Db, input.grant.runId)
    if (!session || session.status !== 'OPEN' || session.ownerWorkerId !== input.workerId) return false
    if (!run || run.status !== 'RUNNING') return false
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) return false
    if (session.authHoldWorkerId && session.authHoldRunId !== input.grant.runId) return false
    const now = await clockNow(tx as unknown as Db)
    const expires = new Date(now.getTime() + input.holdSeconds * 1000)
    const [held] = await updateRows(
      tx,
      browserSessions,
      {
        authHoldWorkerId: input.workerId,
        authHoldExpiresAt: expires,
        authHoldRunId: input.grant.runId,
        authHoldSessionGeneration: session.generation,
        authHoldWorkerInstanceId: input.workerInstanceId,
        authState: 'EXPIRED',
        authControlActorId: null,
        authControlTokenHash: null,
        authControlExpiresAt: null,
        authControlPageId: null,
        updatedAt: now,
      },
      and(eq(browserSessions.id, input.sessionId), eq(browserSessions.status, 'OPEN')),
      { id: browserSessions.id },
    )
    if (!held) return false
    const [moved] = await updateRows(
      tx,
      runs,
      { status: 'WAITING_FOR_AUTH', updatedAt: now },
      and(eq(runs.id, input.grant.runId), eq(runs.status, 'RUNNING')),
      { id: runs.id },
    )
    if (!moved) return false
    await releaseRunLeaseTx(tx as unknown as Db, input.grant, 'waiting_for_auth')
    await appendRunEvents(tx as unknown as Db, input.grant.runId, [
      { type: 'run.auth_wait', payload: { status: 'WAITING_FOR_AUTH' } },
    ])
    return true
  })
}

export async function acquireAuthControl(
  db: Db,
  input: {
    sessionId: string
    runId: string
    actor: AuditActor
    workerId: string
    workerInstanceId: string
    sessionGeneration: number
    pageId?: string
    ttlSeconds?: number
  },
): Promise<{ token: string; epoch: number; expiresAt: Date }> {
  const { browserSessions, runs } = schemaFor(db)
  const token = newAuthControlToken()
  const tokenHash = hashAuthControlToken(token)
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, input.sessionId)
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run || run.status !== 'WAITING_FOR_AUTH') {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以授予输入权')
    }
    if (!session || session.status !== 'OPEN' || session.ownerWorkerId !== input.workerId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker')
    }
    if (session.generation !== input.sessionGeneration) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话代次已变化')
    }
    if (!isBoundAuthHold(session) || session.authHoldRunId !== input.runId) {
      throw forbiddenHold()
    }
    if (session.authHoldWorkerInstanceId !== input.workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
    }
    const now = await clockNow(tx as unknown as Db)
    if (session.authHoldExpiresAt && session.authHoldExpiresAt.getTime() <= now.getTime()) {
      throw conflict('AUTH_HOLD_UNBOUND', '认证占用已过期')
    }
    if (
      session.authControlActorId &&
      session.authControlExpiresAt &&
      session.authControlExpiresAt.getTime() > now.getTime() &&
      session.authControlActorId !== input.actor.id
    ) {
      throw conflict('AUTH_CONTROL_HELD', '由其他用户处理登录')
    }
    const ttl = input.ttlSeconds ?? AUTH_CONTROL_TTL_SECONDS
    const expires = new Date(now.getTime() + ttl * 1000)
    if (session.authHoldExpiresAt && expires.getTime() > session.authHoldExpiresAt.getTime()) {
      expires.setTime(session.authHoldExpiresAt.getTime())
    }
    const nextEpoch = session.authControlEpoch + 1
    const [row] = await updateRows(
      tx,
      browserSessions,
      {
        authControlEpoch: nextEpoch,
        authControlActorId: input.actor.id,
        authControlTokenHash: tokenHash,
        authControlExpiresAt: expires,
        authControlPageId: input.pageId ?? session.authControlPageId,
        updatedAt: now,
      },
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.authHoldRunId, input.runId),
        eq(browserSessions.generation, input.sessionGeneration),
      ),
      { id: browserSessions.id },
    )
    if (!row) throw conflict('AUTH_CONTROL_HELD', '未能取得认证输入权')
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'session.auth_control_acquire',
      'run',
      input.runId,
      '取得目标系统登录输入权',
    )
    await appendRunEvents(tx as unknown as Db, input.runId, [
      {
        type: 'run.auth_control_changed',
        payload: { phase: 'acquired', epoch: nextEpoch, actorId: input.actor.id },
      },
    ])
    return { token, epoch: nextEpoch, expiresAt: expires }
  })
}

export async function heartbeatAuthControl(
  db: Db,
  input: {
    sessionId: string
    runId: string
    actorId: string
    token: string
    workerInstanceId: string
    ttlSeconds?: number
  },
): Promise<{ expiresAt: Date; epoch: number }> {
  const { browserSessions } = schemaFor(db)
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, input.sessionId)
    const now = await clockNow(tx as unknown as Db)
    assertLiveControl(session, input, now)
    const ttl = input.ttlSeconds ?? AUTH_CONTROL_TTL_SECONDS
    let expires = new Date(now.getTime() + ttl * 1000)
    if (session!.authHoldExpiresAt && expires.getTime() > session!.authHoldExpiresAt.getTime()) {
      expires = session!.authHoldExpiresAt
    }
    const [row] = await updateRows(
      tx,
      browserSessions,
      { authControlExpiresAt: expires, updatedAt: now },
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.authControlTokenHash, hashAuthControlToken(input.token)),
        eq(browserSessions.authControlActorId, input.actorId),
      ),
      { id: browserSessions.id, authControlEpoch: browserSessions.authControlEpoch },
    )
    if (!row) throw conflict('AUTH_CONTROL_INVALID', '认证输入权已失效')
    return { expiresAt: expires, epoch: row.authControlEpoch }
  })
}

export async function releaseAuthControl(
  db: Db,
  input: {
    sessionId: string
    runId: string
    actor: AuditActor
    token: string
    reason?: string
  },
): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, input.sessionId)
    if (!session || session.authHoldRunId !== input.runId) return false
    if (session.authControlTokenHash !== hashAuthControlToken(input.token)) {
      throw conflict('AUTH_CONTROL_INVALID', '认证输入权已失效')
    }
    const now = await clockNow(tx as unknown as Db)
    const epoch = session.authControlEpoch
    const [row] = await updateRows(
      tx,
      browserSessions,
      {
        authControlActorId: null,
        authControlTokenHash: null,
        authControlExpiresAt: null,
        authControlPageId: null,
        updatedAt: now,
      },
      and(
        eq(browserSessions.id, input.sessionId),
        eq(browserSessions.authControlTokenHash, hashAuthControlToken(input.token)),
      ),
      { id: browserSessions.id },
    )
    if (!row) return false
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'session.auth_control_release',
      'run',
      input.runId,
      input.reason ?? '释放目标系统登录输入权',
    )
    await appendRunEvents(tx as unknown as Db, input.runId, [
      { type: 'run.auth_control_changed', payload: { phase: 'released', epoch } },
    ])
    return true
  })
}

export async function expireStaleAuthControl(db: Db, sessionId: string, runId: string): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, sessionId)
    if (!session || session.authHoldRunId !== runId || !session.authControlTokenHash) return false
    const now = await clockNow(tx as unknown as Db)
    if (session.authControlExpiresAt && session.authControlExpiresAt.getTime() > now.getTime()) return false
    const epoch = session.authControlEpoch
    const [row] = await updateRows(
      tx,
      browserSessions,
      {
        authControlActorId: null,
        authControlTokenHash: null,
        authControlExpiresAt: null,
        authControlPageId: null,
        updatedAt: now,
      },
      and(eq(browserSessions.id, sessionId), eq(browserSessions.authHoldRunId, runId)),
      { id: browserSessions.id },
    )
    if (!row) return false
    await appendRunEvents(tx as unknown as Db, runId, [
      { type: 'run.auth_control_changed', payload: { phase: 'expired', epoch } },
    ])
    return true
  })
}

/**
 * Worker 在登录检查通过后调用。必须匹配 hold / control epoch。
 * 无有效控制者时允许恢复；他人未过期控制则拒绝。
 */
export async function resumeRunAfterAuth(
  db: Db,
  input: {
    runId: string
    actor: AuditActor
    note?: string
    sessionId?: string
    workerId?: string
    workerInstanceId?: string
    controlEpoch?: number
    token?: string
  },
): Promise<void> {
  const { browserSessions, runs } = schemaFor(db)
  const sessionId = input.sessionId
  const workerId = input.workerId
  const workerInstanceId = input.workerInstanceId
  const controlEpoch = input.controlEpoch
  if (sessionId == null || workerId == null || workerInstanceId == null || controlEpoch == null) {
    throw conflict('AUTH_HOLD_UNBOUND', '恢复必须由持有会话的 Worker 携带绑定占用')
  }
  await db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, sessionId)
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (run.status !== 'WAITING_FOR_AUTH') {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以恢复领取')
    }
    if (!session || session.status !== 'OPEN' || session.ownerWorkerId !== workerId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker')
    }
    if (!isBoundAuthHold(session) || session.authHoldRunId !== input.runId) {
      throw forbiddenHold()
    }
    if (session.authHoldWorkerInstanceId !== workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
    }
    if (session.authControlEpoch !== controlEpoch) {
      throw conflict('AUTH_CONTROL_INVALID', '控制代次不匹配')
    }
    const now = await clockNow(tx as unknown as Db)
    if (
      session.authControlActorId &&
      session.authControlExpiresAt &&
      session.authControlExpiresAt.getTime() > now.getTime()
    ) {
      if (!input.token || session.authControlTokenHash !== hashAuthControlToken(input.token)) {
        throw conflict('AUTH_CONTROL_HELD', '由其他用户处理登录')
      }
      if (session.authControlActorId !== input.actor.id) {
        throw conflict('AUTH_CONTROL_HELD', '由其他用户处理登录')
      }
    }
    const [held] = await updateRows(
      tx,
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
        authState: 'AUTHENTICATED',
        updatedAt: now,
      },
      and(
        eq(browserSessions.id, sessionId),
        eq(browserSessions.authHoldRunId, input.runId),
        eq(browserSessions.authControlEpoch, controlEpoch),
      ),
      { id: browserSessions.id },
    )
    if (!held) throw conflict('AUTH_CONTROL_INVALID', '认证占用已变化')
    const moved = await updateRows(
      tx,
      runs,
      { status: 'RECOVERING', updatedAt: now },
      and(eq(runs.id, input.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      { id: runs.id },
    )
    if (moved.length === 0) {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以恢复领取')
    }
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'run.resume_auth',
      'run',
      input.runId,
      `确认目标系统已登录${input.note ? `：${input.note}` : ''}`,
    )
    await appendRunEvents(tx as unknown as Db, input.runId, [
      { type: 'run.auth_resumed', payload: { status: 'RECOVERING' } },
    ])
  })
}

export async function findSessionByAuthHoldRun(db: Db, runId: string): Promise<SessionRecord | null> {
  const { browserSessions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(and(eq(browserSessions.authHoldRunId, runId), eq(browserSessions.status, 'OPEN')))
    .limit(1)
  return row
    ? {
        id: row.id,
        targetId: row.targetId,
        targetAccountId: row.targetAccountId,
        status: row.status,
        health: row.health,
        authState: row.authState,
        ownerWorkerId: row.ownerWorkerId,
        ownerWorkerInstanceId: row.ownerWorkerInstanceId,
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
    : null
}

function forbiddenHold(): never {
  throw conflict('AUTH_HOLD_UNBOUND', '缺少绑定的认证占用，不能授予输入权')
}

function assertLiveControl(
  session: BrowserSessionRow | null,
  input: { runId: string; actorId: string; token: string; workerInstanceId: string },
  now: Date,
): asserts session is BrowserSessionRow {
  if (!session || session.authHoldRunId !== input.runId || !isBoundAuthHold(session)) {
    throw conflict('AUTH_HOLD_UNBOUND', '缺少绑定的认证占用')
  }
  if (session.authHoldWorkerInstanceId !== input.workerInstanceId) {
    throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
  }
  if (!session.authControlTokenHash || session.authControlActorId !== input.actorId) {
    throw conflict('AUTH_CONTROL_INVALID', '认证输入权已失效')
  }
  if (session.authControlTokenHash !== hashAuthControlToken(input.token)) {
    throw conflict('AUTH_CONTROL_INVALID', '认证输入权已失效')
  }
  if (!session.authControlExpiresAt || session.authControlExpiresAt.getTime() <= now.getTime()) {
    throw conflict('AUTH_CONTROL_INVALID', '认证输入权已过期')
  }
}
