import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { AUTH_CONTROL_TTL_SECONDS, authCheckpointSchema, computeContextVersion, canonicalJson, type AuthCheckpoint, type RunGrant } from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { assertSessionAccountActive, assertSessionActorPermission } from './access.js'
import { appendSessionEvent } from './maintenance.js'
import type { Db } from '../client.js'
import { lockRunRow } from '../leases/leases.js'
import { clockNow, locked, schemaFor, updateRows } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import { conflict, notFound } from '../runs/errors.js'
import type { BrowserSessionRow } from '../records.js'
import { findAuthWaitLeaseForOperation, findAuthWaitLeaseForRun, getSessionOperation, transitionSessionUse, lockWorkerRow } from './occupancy.js'
import type { SessionRecord } from './sessions.js'

export function hashAuthControlToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newAuthControlToken(): string {
  return randomBytes(32).toString('hex')
}

export async function lockSessionRow(tx: Db, sessionId: string): Promise<BrowserSessionRow | null> {
  const { browserSessions, targetAccounts } = schemaFor(tx)
  const [initial] = await tx.select({ accountId: browserSessions.targetAccountId }).from(browserSessions).where(eq(browserSessions.id, sessionId)).limit(1)
  if (initial) await locked(tx, tx.select({ id: targetAccounts.id }).from(targetAccounts).where(eq(targetAccounts.id, initial.accountId)))
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

async function findOwnerWait(db: Db, ownerId: string) {
  return (await findAuthWaitLeaseForOperation(db, ownerId)) ?? (await findAuthWaitLeaseForRun(db, ownerId))
}

async function authControlEvent(db: Db, ownerId: string, payload: { phase: 'acquired' | 'released' | 'expired'; epoch: number; actorId?: string }) {
  const operation = await getSessionOperation(db, ownerId)
  if (operation) {
    await appendSessionEvent(db, { key: operation, operationId: operation.id, sessionId: operation.expectedSessionId, type: 'auth.control_changed', payload })
  } else {
    await appendRunEvents(db, ownerId, [{ type: 'run.auth_control_changed', payload }])
  }
}

async function assertOwnerControl(db: Db, ownerId: string, actorId: string) {
  const operation = await getSessionOperation(db, ownerId)
  if (operation) {
    if (operation.status !== 'WAITING_FOR_AUTH') throw conflict('AUTH_INPUT_REJECTED', '操作不在认证等待阶段')
    await assertSessionAccountActive(db, operation)
    await assertSessionActorPermission(db, actorId, 'session:control')
  } else {
    const { runs } = schemaFor(db)
    const [run] = await db.select().from(runs).where(eq(runs.id, ownerId)).limit(1)
    if (run?.targetAccountId) await assertSessionAccountActive(db, { targetId: run.targetId, targetAccountId: run.targetAccountId })
    if (run?.authCheckpoint) {
      await assertSessionActorPermission(db, actorId, 'session:control')
    }
  }
}

async function lockAuthScope(tx: Db, sessionId: string, workerId: string, workerInstanceId: string) {
  const worker = await lockWorkerRow(tx, workerId)
  if (!worker || worker.instanceId !== workerInstanceId) throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
  const { browserSessions, targetAccounts } = schemaFor(tx)
  const [initial] = await tx.select({ accountId: browserSessions.targetAccountId }).from(browserSessions).where(eq(browserSessions.id, sessionId))
  if (initial) await locked(tx, tx.select({ id: targetAccounts.id }).from(targetAccounts).where(eq(targetAccounts.id, initial.accountId)))
}

async function requireAuthWaitLease(
  db: Db,
  input: { sessionId: string; runId: string; workerInstanceId?: string },
) {
  const lease =
    (await findAuthWaitLeaseForRun(db, input.runId)) ?? (await findAuthWaitLeaseForOperation(db, input.runId))
  const now = (await clockNow(db)).getTime()
  if (!lease || lease.sessionId !== input.sessionId || lease.status !== 'ACTIVE' || lease.expiresAt.getTime() <= now || (lease.waitDeadlineAt && lease.waitDeadlineAt.getTime() <= now)) {
    console.log('requireAuthWaitLease failed in resume:', { lease, sessionId: input.sessionId, now, expiresAt: lease?.expiresAt?.getTime(), waitDeadlineAt: lease?.waitDeadlineAt?.getTime() })
    throw forbiddenHold()
  }
  return lease
}

export async function enterRunWaitingForAuth(
  db: Db,
  input: {
    grant: RunGrant
    sessionId: string
    workerId: string
    workerInstanceId: string
    holdSeconds: number
    leaseTtlSeconds?: number
  },
): Promise<import('@cairn/shared').SessionGrant | null> {
  const next = await transitionSessionUse(db, {
    sessionId: input.sessionId,
    fromPurpose: 'EXECUTION',
    toPurpose: 'AUTH_WAIT',
    owner: { kind: 'RUN', runId: input.grant.runId, runFencingToken: input.grant.fencingToken },
    holderWorkerId: input.workerId,
    holderInstanceId: input.workerInstanceId,
    leaseTtlSeconds: input.leaseTtlSeconds ?? 30,
    waitSeconds: input.holdSeconds,
    runGrant: input.grant,
    reason: 'waiting_for_auth',
  })
  return next
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
    await lockAuthScope(tx as unknown as Db, input.sessionId, input.workerId, input.workerInstanceId)
    const operation = await getSessionOperation(tx, input.runId)
    const run = operation ?? await lockRunRow(tx as unknown as Db, input.runId)
    const session = await lockSessionRow(tx as unknown as Db, input.sessionId)
    await assertOwnerControl(tx, input.runId, input.actor.id)
    if (!run || run.status !== 'WAITING_FOR_AUTH') {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以授予输入权')
    }
    if (!session || session.status !== 'OPEN' || session.ownerWorkerId !== input.workerId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker')
    }
    if (session.generation !== input.sessionGeneration) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话代次已变化')
    }
    const waitLease = await requireAuthWaitLease(tx as unknown as Db, {
      sessionId: input.sessionId,
      runId: input.runId,
      workerInstanceId: input.workerInstanceId,
    })
    if (session.ownerWorkerInstanceId !== input.workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
    }
    const now = await clockNow(tx as unknown as Db)
    if (waitLease.waitDeadlineAt && waitLease.waitDeadlineAt.getTime() <= now.getTime()) {
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
    if (waitLease.waitDeadlineAt && expires.getTime() > waitLease.waitDeadlineAt.getTime()) {
      expires.setTime(waitLease.waitDeadlineAt.getTime())
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
    await authControlEvent(tx, input.runId, { phase: 'acquired', epoch: nextEpoch, actorId: input.actor.id })
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
    await assertOwnerControl(tx, input.runId, input.actorId)
    await requireAuthWaitLease(tx, input)
    assertLiveControl(session, input, now)
    const ttl = input.ttlSeconds ?? AUTH_CONTROL_TTL_SECONDS
    let expires = new Date(now.getTime() + ttl * 1000)
    const waitLease = await findOwnerWait(tx as unknown as Db, input.runId)
    if (waitLease?.waitDeadlineAt && expires.getTime() > waitLease.waitDeadlineAt.getTime()) {
      expires = waitLease.waitDeadlineAt
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
    const waitLease = await findOwnerWait(tx as unknown as Db, input.runId)
    if (!session || !waitLease || waitLease.sessionId !== input.sessionId) return false
    if (session.authControlActorId !== input.actor.id || session.authControlTokenHash !== hashAuthControlToken(input.token)) {
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
    await authControlEvent(tx, input.runId, { phase: 'released', epoch })
    return true
  })
}

export async function expireStaleAuthControl(db: Db, sessionId: string, runId: string): Promise<boolean> {
  const { browserSessions } = schemaFor(db)
  return db.transaction(async (tx) => {
    const session = await lockSessionRow(tx as unknown as Db, sessionId)
    const waitLease = await findOwnerWait(tx as unknown as Db, runId)
    if (!session || !waitLease || waitLease.sessionId !== sessionId || !session.authControlTokenHash) return false
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
      and(eq(browserSessions.id, sessionId)),
      { id: browserSessions.id },
    )
    if (!row) return false
    await authControlEvent(tx, runId, { phase: 'expired', epoch })
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
    recoveredAuthCheckpoint?: AuthCheckpoint
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
    await lockAuthScope(tx as unknown as Db, sessionId, workerId, workerInstanceId)
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    const session = await lockSessionRow(tx as unknown as Db, sessionId)
    if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (run.status !== 'WAITING_FOR_AUTH') {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以恢复领取')
    }
    if (!session || session.status !== 'OPEN' || session.ownerWorkerId !== workerId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker')
    }
    await assertSessionAccountActive(tx as unknown as Db, session)
    const waitLease = await requireAuthWaitLease(tx as unknown as Db, {
      sessionId,
      runId: input.runId,
      workerInstanceId,
    })
    if (session.ownerWorkerInstanceId !== workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
    }
    const now = await clockNow(tx as unknown as Db)
    if (waitLease.waitDeadlineAt && waitLease.waitDeadlineAt.getTime() <= now.getTime()) {
      throw conflict('AUTH_HOLD_UNBOUND', '认证占用已过期')
    }
    if (session.authControlEpoch !== controlEpoch) {
      throw conflict('AUTH_CONTROL_INVALID', '控制代次不匹配')
    }
    const checkpoint = run.authCheckpoint == null ? null : authCheckpointSchema.parse(run.authCheckpoint)
    if (checkpoint?.status === 'recovering') {
      await assertSessionActorPermission(tx as unknown as Db, input.actor.id, 'session:control')
      await assertSessionActorPermission(tx as unknown as Db, input.actor.id, 'run:execute')
      if (!input.token || session.authControlActorId !== input.actor.id ||
          session.authControlTokenHash !== hashAuthControlToken(input.token) ||
          !session.authControlExpiresAt || session.authControlExpiresAt <= now) {
        throw conflict('AUTH_CONTROL_INVALID', '完成认证需要当前有效的控制令牌')
      }
      if (run.cancelRequestedAt || (run.deadlineAt && run.deadlineAt <= now) ||
          checkpoint.recoveryKind !== 'manual' || checkpoint.sessionGeneration !== session.generation ||
          (checkpoint.pageRef && checkpoint.pageRef.sessionId !== sessionId) ||
          checkpoint.contextVersion !== await computeContextVersion(run.context) ||
          !input.recoveredAuthCheckpoint ||
          canonicalJson(authCheckpointSchema.parse(input.recoveredAuthCheckpoint)) !== canonicalJson({ ...checkpoint, status: 'recovered' })) {
        throw conflict('AUTH_CONTEXT_NOT_RECOVERABLE', '认证恢复现场或检查点已变化')
      }
    }
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
      and(eq(browserSessions.id, sessionId), eq(browserSessions.authControlEpoch, controlEpoch)),
      { id: browserSessions.id },
    )
    if (!held) throw conflict('AUTH_CONTROL_INVALID', '认证占用已变化')
    const moved = await updateRows(
      tx,
      runs,
      { status: 'RECOVERING', ...(checkpoint?.status === 'recovering' ? { authCheckpoint: { ...checkpoint, status: 'recovered' as const } } : {}), updatedAt: now },
      and(eq(runs.id, input.runId), eq(runs.status, 'WAITING_FOR_AUTH')),
      { id: runs.id },
    )
    if (moved.length === 0) {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以恢复领取')
    }
    if (checkpoint?.status === 'recovering') {
      await appendRunEvents(tx as unknown as Db, input.runId, [{ type: 'run.auth_recovered', payload: { ...checkpoint, status: 'recovered' } }])
    }
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'run.resume_auth',
      'run',
      input.runId,
      `确认目标系统已登录${input.note ? `：${input.note}` : ''}`,
    )
    await transitionSessionUse(tx as unknown as Db, {
      sessionId,
      fromPurpose: 'AUTH_WAIT',
      toPurpose: 'RELEASE',
      owner: { kind: 'RUN', runId: input.runId, runFencingToken: 1 },
      holderWorkerId: workerId,
      holderInstanceId: workerInstanceId,
      leaseTtlSeconds: 30,
      reason: 'auth_resumed',
    })
  })
}

export async function findSessionByAuthHoldRun(db: Db, runId: string): Promise<SessionRecord | null> {
  const lease = await findAuthWaitLeaseForRun(db, runId)
  if (!lease) return null
  const { browserSessions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(and(eq(browserSessions.id, lease.sessionId), eq(browserSessions.status, 'OPEN')))
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
        lastAuthCheckedAt: row.lastAuthCheckedAt,
        lastAuthSuccessAt: row.lastAuthSuccessAt,
        lastAuthGeneration: row.lastAuthGeneration,
        lastExpectedIdentity: row.lastExpectedIdentity,
        authValidUntil: row.authValidUntil,
        authExpirySource: row.authExpirySource,
        lastAuthError: row.lastAuthError,
        authProfileRevision: row.authProfileRevision,
        identityState: row.identityState,
        identityVerifiedAt: row.identityVerifiedAt,
        observedTier: row.observedTier,
        closeReason: row.closeReason,
        closedAt: row.closedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        retainUntil: row.retainUntil ?? null,
        nextAuthCheckAt: row.nextAuthCheckAt ?? null,
        predecessorSessionId: row.predecessorSessionId ?? null,
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
  if (!session) {
    throw conflict('AUTH_HOLD_UNBOUND', '缺少绑定的认证占用')
  }
  if (session.ownerWorkerInstanceId !== input.workerInstanceId) {
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
