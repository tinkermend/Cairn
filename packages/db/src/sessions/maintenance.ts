import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  deriveAccountSessionStatus,
  isSessionIdleOnlyKind,
  matchesOverviewFilter,
  platformConfigDocumentSchema,
  retentionQuota,
  type AccountSessionDetail,
  type AccountSessionOverviewItem,
  type AccountSessionStatus,
  type RequestSessionOperationBody,
  type SessionEventDto,
  type SessionEventType,
  type SessionOverviewFilter,
  type SessionOverviewResponse,
  type SessionRetentionBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, databaseNow, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { conflict, notFound } from '../runs/errors.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { SessionOperationRow } from '../records.js'
import {
  assertMaintenanceAuthorized,
  assertSessionAccountActive,
  assertSessionActorPermission,
} from './access.js'
import { findActiveLeaseRow, requestSessionOperation, contentDigestFor } from './occupancy.js'
import { findLiveSession, getSessionById, type SessionKey } from './sessions.js'

async function readRetentionConfig(db: Db) {
  const current = await getOrCreatePlatformConfig(db)
  const document = platformConfigDocumentSchema.parse(current.document)
  return { retention: document.sessionRetention, revision: current.revision }
}

export async function appendSessionEvent(
  db: Db,
  input: {
    key: SessionKey
    type: SessionEventType
    sessionId?: string | null
    generation?: number | null
    operationId?: string | null
    runId?: string | null
    payload?: Record<string, unknown>
  },
): Promise<void> {
  await atomic(db, async (tx) => {
    const { sessionEvents, targetAccounts } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, input.key.targetAccountId)),
    )
    const now = await clockNow(tx)
    const [last] = await locked(
      tx,
      tx
        .select({ seq: sessionEvents.seq })
        .from(sessionEvents)
        .where(
          and(
            eq(sessionEvents.targetId, input.key.targetId),
            eq(sessionEvents.targetAccountId, input.key.targetAccountId),
          ),
        )
        .orderBy(desc(sessionEvents.seq))
        .limit(1),
    )
    await insertRows(tx, sessionEvents, {
      id: newId(),
      seq: (last?.seq ?? 0) + 1,
      targetId: input.key.targetId,
      targetAccountId: input.key.targetAccountId,
      sessionId: input.sessionId ?? null,
      generation: input.generation ?? null,
      operationId: input.operationId ?? null,
      runId: input.runId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: now,
    })
  })
}

export async function listSessionEvents(
  db: Db,
  input: { sessionId?: string; key?: SessionKey; cursor?: string; limit?: number },
): Promise<{ items: SessionEventDto[]; nextCursor?: string }> {
  const { sessionEvents } = schemaFor(db)
  const limit = input.limit ?? 50
  const conditions = []
  if (input.sessionId) conditions.push(eq(sessionEvents.sessionId, input.sessionId))
  if (input.key) {
    conditions.push(eq(sessionEvents.targetId, input.key.targetId))
    conditions.push(eq(sessionEvents.targetAccountId, input.key.targetAccountId))
  }
  if (input.cursor) {
    const seq = Number(input.cursor)
    if (Number.isFinite(seq)) conditions.push(sql`${sessionEvents.seq} < ${seq}`)
  }
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sessionEvents.seq))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      targetId: row.targetId,
      targetAccountId: row.targetAccountId,
      sessionId: row.sessionId,
      generation: row.generation,
      operationId: row.operationId,
      runId: row.runId,
      type: row.type as SessionEventType,
      payload: row.payload ?? {},
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]?.seq) : undefined,
  }
}

export async function listSessionEventsAfter(
  db: Db,
  input: { key?: SessionKey; afterSeq?: number; watermarks?: Record<string, number>; limit?: number },
): Promise<SessionEventDto[]> {
  const { sessionEvents } = schemaFor(db)
  const watermarks = input.watermarks ?? {}
  const conditions = [
    input.key
      ? sql`${sessionEvents.seq} > ${input.afterSeq ?? watermarks[input.key.targetAccountId] ?? 0}`
      : and(
          ...Object.entries(watermarks).map(([id, seq]) =>
            or(sql`${sessionEvents.targetAccountId} <> ${id}`, sql`${sessionEvents.seq} > ${seq}`),
          ),
        ),
  ]
  if (input.key) {
    conditions.push(eq(sessionEvents.targetId, input.key.targetId))
    conditions.push(eq(sessionEvents.targetAccountId, input.key.targetAccountId))
  }
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(and(...conditions))
    // SSE cursors advance independently for each target account. Concurrent commits
    // can give a higher sequence an earlier createdAt, so timestamp order could make
    // a reconnecting client advance its watermark past an older event.
    .orderBy(asc(sessionEvents.targetAccountId), asc(sessionEvents.seq), asc(sessionEvents.createdAt))
    .limit(input.limit ?? 100)
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    sessionId: row.sessionId,
    generation: row.generation,
    operationId: row.operationId,
    runId: row.runId,
    type: row.type as SessionEventType,
    payload: row.payload ?? {},
    createdAt: row.createdAt.toISOString(),
  }))
}

async function loadOccupancyFacts(db: Db, key: SessionKey) {
  const live = await findLiveSession(db, key)
  const lease = live ? await findActiveLeaseRow(db, live.id) : null
  const { runs, sessionOperations } = schemaFor(db)
  const [holding] = live
    ? await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.targetId, key.targetId),
            eq(runs.targetAccountId, key.targetAccountId),
            eq(runs.status, 'HOLDING'),
            isNull(runs.deletedAt),
          ),
        )
        .limit(1)
    : []
  const [activeOp] = await db
    .select()
    .from(sessionOperations)
    .where(
      and(
        eq(sessionOperations.targetId, key.targetId),
        eq(sessionOperations.targetAccountId, key.targetAccountId),
        inArray(sessionOperations.status, ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH']),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${sessionOperations.status} = 'WAITING_FOR_AUTH' THEN 0 ELSE 1 END`,
      desc(sessionOperations.createdAt),
    )
    .limit(1)
  return { live, lease, holding: Boolean(holding), activeOp: activeOp ?? null }
}

function statusFromFacts(input: Awaited<ReturnType<typeof loadOccupancyFacts>>): AccountSessionStatus {
  return deriveAccountSessionStatus({
    liveStatus: input.live?.status ?? null,
    authState: input.live?.authState ?? null,
    identityState: input.live?.identityState ?? null,
    leasePurpose: input.lease?.purpose ?? null,
    occupyingRunId: input.lease?.runId ?? null,
    occupyingOperationId: input.lease?.operationId ?? input.activeOp?.id ?? null,
    holding: input.holding,
  })
}

export async function requestMaintenanceOperation(
  db: Db,
  input: {
    key: SessionKey
    body: RequestSessionOperationBody
    origin?: 'USER' | 'BACKGROUND'
    actor?: AuditActor
  },
): Promise<{ operation: SessionOperationRow | null; created: boolean; reusedRunId: string | null }> {
  return atomic(db, async (tx) => {
    const origin = input.origin ?? 'USER'
    const { targetAccounts, sessionOperations } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, input.key.targetAccountId)),
    )
    await assertMaintenanceAuthorized(tx, {
      ...input.key,
      kind: input.body.kind,
      origin,
      kindParams: { requestedBy: input.actor?.id },
    })
    const requestDigest = contentDigestFor({ ...input.body, origin, requestedBy: input.actor?.id ?? null })
    const [existing] = await tx
      .select()
      .from(sessionOperations)
      .where(
        and(
          eq(sessionOperations.targetId, input.key.targetId),
          eq(sessionOperations.targetAccountId, input.key.targetAccountId),
          eq(sessionOperations.idempotencyKey, input.body.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.kindParams?.requestDigest !== requestDigest)
        throw conflict('OPERATION_IDEMPOTENCY_CONFLICT', '同幂等键内容不一致')
      return {
        operation: existing,
        created: false,
        reusedRunId:
          typeof existing.kindParams?.reusedRunId === 'string' ? existing.kindParams.reusedRunId : null,
      }
    }
    if (input.body.kind === 'RESET_PROFILE' && input.body.confirmAccountId !== input.key.targetAccountId) {
      throw conflict('SESSION_POLICY_INVALID', '清除登录数据必须确认当前账号')
    }
    const facts = await loadOccupancyFacts(tx, input.key)
    if (origin === 'BACKGROUND') {
      const { runs } = schemaFor(tx)
      const [queued] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.targetId, input.key.targetId),
            eq(runs.targetAccountId, input.key.targetAccountId),
            inArray(runs.status, ['QUEUED', 'RECOVERING']),
            isNull(runs.deletedAt),
          ),
        )
        .limit(1)
      if (queued || facts.lease || facts.holding)
        return { operation: facts.activeOp, created: false, reusedRunId: null }
    }
    if (origin === 'BACKGROUND' && facts.activeOp)
      return { operation: facts.activeOp, created: false, reusedRunId: null }
    if (facts.activeOp && input.body.kind !== 'REFRESH_LOGIN_PAGE')
      throw conflict('SESSION_OPERATION_CONFLICT', '已有会话操作尚未完成', {
        occupyingOperationId: facts.activeOp.id,
      })
    if (facts.live && (!input.body.expectedSessionId || input.body.expectedGeneration == null)) {
      throw conflict('SESSION_GENERATION_CHANGED', '操作已有实例必须提供实例与代次，请刷新后重试')
    }
    if (input.body.expectedSessionId) {
      if (
        !facts.live ||
        facts.live.id !== input.body.expectedSessionId ||
        (input.body.expectedGeneration != null && facts.live.generation !== input.body.expectedGeneration)
      ) {
        throw conflict('SESSION_GENERATION_CHANGED', '会话实例已重建，请刷新后重试')
      }
    }
    if (facts.holding || facts.lease?.purpose === 'EXECUTION') {
      throw conflict('SESSION_OPERATION_CONFLICT', '该账号正在执行运行', {
        occupyingRunId: facts.lease?.runId ?? null,
      })
    }
    if (facts.lease?.purpose === 'AUTH_WAIT' && facts.lease.ownerKind === 'RUN' && facts.lease.runId) {
      if (input.body.kind === 'LOGIN') {
        // 下方入账；领取时复用 Run 的 AUTH_WAIT。
      }
      if (input.body.kind !== 'LOGIN' && input.body.kind !== 'REFRESH_LOGIN_PAGE')
        throw conflict('SESSION_OPERATION_CONFLICT', '该账号正在等待运行认证', {
          occupyingRunId: facts.lease.runId,
        })
    }
    if (
      facts.lease?.purpose === 'AUTH_WAIT' &&
      facts.lease.operationId &&
      input.body.kind !== 'REFRESH_LOGIN_PAGE'
    ) {
      throw conflict('SESSION_OPERATION_CONFLICT', '该账号已有认证等待', {
        occupyingOperationId: facts.lease.operationId,
      })
    }
    if (
      input.body.kind === 'REFRESH_LOGIN_PAGE' &&
      facts.lease?.purpose === 'AUTH_WAIT' &&
      (facts.live?.authControlActorId !== input.actor?.id ||
        !facts.live?.authControlExpiresAt ||
        facts.live.authControlExpiresAt.getTime() <= Date.now())
    )
      throw conflict('AUTH_CONTROL_INVALID', '刷新认证页须持有当前输入权')
    if (facts.lease?.purpose === 'MAINTENANCE' && facts.lease.operationId) {
      throw conflict('SESSION_OPERATION_CONFLICT', '该账号正在维护', {
        occupyingOperationId: facts.lease.operationId,
      })
    }
    if (input.body.kind === 'CLOSE' || input.body.kind === 'RESTART') {
      if (!facts.live || facts.live.status !== 'OPEN' || facts.lease) {
        throw conflict('SESSION_NOT_CLAIMABLE', '关闭或重启只能在空闲活实例上执行')
      }
    }
    if (input.body.kind === 'RESET_PROFILE' && facts.lease) {
      throw conflict('SESSION_OPERATION_CONFLICT', '该账号正在被占用，不能清除登录数据')
    }
    const requested = await requestSessionOperation(tx, {
      key: input.key,
      kind: input.body.kind,
      kindParams: {
        requestedBy: input.actor?.id ?? null,
        requestDigest,
        ...(input.body.kind === 'REFRESH_LOGIN_PAGE' ? { pageRef: input.body.pageRef } : {}),
        ...(input.body.kind === 'RESET_PROFILE' ? { confirmAccountId: input.body.confirmAccountId } : {}),
        ...(facts.lease?.purpose === 'AUTH_WAIT'
          ? { reusedRunId: facts.lease.runId, reusedOperationId: facts.lease.operationId }
          : {}),
      },
      origin,
      idempotencyKey: input.body.idempotencyKey,
      expectedSessionId: input.body.expectedSessionId ?? facts.live?.id ?? null,
      expectedGeneration: input.body.expectedGeneration ?? facts.live?.generation ?? null,
    })
    if (requested.created) {
      await appendSessionEvent(tx, {
        key: input.key,
        type: 'operation.requested',
        sessionId: facts.live?.id ?? null,
        generation: facts.live?.generation ?? null,
        operationId: requested.operation.id,
        payload: { kind: input.body.kind, origin },
      })
      if (input.actor) {
        await recordAudit(
          tx,
          input.actor,
          'session.operation',
          'session',
          requested.operation.id,
          `发起会话操作 ${input.body.kind}`,
        )
      }
    }
    return {
      operation: requested.operation,
      created: requested.created,
      reusedRunId: facts.lease?.purpose === 'AUTH_WAIT' ? facts.lease.runId : null,
    }
  })
}

export async function cancelSessionOperation(
  db: Db,
  input: { operationId: string; actor?: AuditActor },
): Promise<SessionOperationRow> {
  return atomic(db, async (tx) => {
    const { sessionOperations, sessionLeases, targetAccounts } = schemaFor(tx)
    const [row] = await tx
      .select()
      .from(sessionOperations)
      .where(eq(sessionOperations.id, input.operationId))
      .limit(1)
    if (!row) throw notFound('OPERATION_NOT_FOUND', '会话操作不存在')
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, row.targetAccountId)),
    )
    if (input.actor) await assertSessionActorPermission(tx, input.actor.id, 'session:control')
    if (row.status === 'SUCCEEDED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
      throw conflict('OPERATION_ALREADY_FINISHED', '操作已结束')
    }
    if (row.status !== 'QUEUED' && row.status !== 'WAITING_FOR_AUTH') {
      throw conflict('OPERATION_NOT_CANCELLABLE', '当前阶段不能取消')
    }
    const now = await clockNow(tx)
    const [moved] = await updateRows(
      tx,
      sessionOperations,
      { status: 'CANCELLED', finishedAt: now, updatedAt: now, errorCode: null },
      and(
        eq(sessionOperations.id, input.operationId),
        inArray(sessionOperations.status, ['QUEUED', 'WAITING_FOR_AUTH']),
      ),
    )
    if (!moved) throw conflict('OPERATION_NOT_CANCELLABLE', '取消未生效')
    const [lease] = await tx
      .select()
      .from(sessionLeases)
      .where(and(eq(sessionLeases.operationId, input.operationId), eq(sessionLeases.status, 'ACTIVE')))
      .limit(1)
    if (lease) {
      await updateRows(
        tx,
        sessionLeases,
        { status: 'RELEASED', releasedAt: now, releaseReason: 'operation_cancelled' },
        eq(sessionLeases.id, lease.id),
      )
    }
    await appendSessionEvent(tx, {
      key: { targetId: row.targetId, targetAccountId: row.targetAccountId },
      type: 'operation.cancelled',
      operationId: row.id,
      sessionId: row.expectedSessionId,
      generation: row.expectedGeneration,
    })
    if (input.actor) {
      await recordAudit(tx, input.actor, 'session.operation', 'session', row.id, '取消会话操作')
    }
    return moved
  })
}

export async function setSessionRetention(
  db: Db,
  input: { key: SessionKey; body: SessionRetentionBody; actor: AuditActor },
) {
  return atomic(db, async (tx) => {
    await assertSessionAccountActive(tx, input.key)
    await assertSessionActorPermission(tx, input.actor.id, 'session:control')
    const { retention, revision } = await readRetentionConfig(tx)
    const { sessionRetentionIntents, browserSessions, workers, targetAccounts } = schemaFor(tx)
    const initial = await findLiveSession(tx, input.key)
    if (initial)
      await locked(
        tx,
        tx.select({ id: workers.id }).from(workers).where(eq(workers.id, initial.ownerWorkerId)),
      )
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, input.key.targetAccountId)),
    )
    const now = await clockNow(tx)
    const live = await findLiveSession(tx, input.key)
    if (live && (live.id !== initial?.id || live.ownerWorkerId !== initial.ownerWorkerId))
      throw conflict('SESSION_GENERATION_CHANGED', '会话已重建')
    const [existing] = await tx
      .select()
      .from(sessionRetentionIntents)
      .where(
        and(
          eq(sessionRetentionIntents.targetId, input.key.targetId),
          eq(sessionRetentionIntents.targetAccountId, input.key.targetAccountId),
        ),
      )
      .limit(1)

    if (input.body.action === 'clear') {
      if (existing) {
        await tx.delete(sessionRetentionIntents).where(eq(sessionRetentionIntents.id, existing.id))
      }
      if (live) {
        await updateRows(
          tx,
          browserSessions,
          { retainUntil: null, nextAuthCheckAt: null, updatedAt: now },
          eq(browserSessions.id, live.id),
        )
      }
      await appendSessionEvent(tx, {
        key: input.key,
        type: 'retention.cleared',
        sessionId: live?.id,
        generation: live?.generation,
        payload: { platformConfigRevision: revision },
      })
      await recordAudit(
        tx,
        input.actor,
        'session.retention',
        'session',
        input.key.targetAccountId,
        '取消会话保留',
      )
      return { retainUntil: null, revision }
    }

    if (!live || live.status !== 'OPEN') {
      throw conflict('SESSION_NOT_CLAIMABLE', '设置保留需要该账号已有打开的会话实例')
    }
    const seconds = input.body.retainSeconds
    if (seconds > retention.maxRetainSeconds) {
      throw conflict('SESSION_POLICY_INVALID', `单次保留不能超过 ${retention.maxRetainSeconds} 秒`)
    }
    const nextUntil = new Date(now.getTime() + seconds * 1000)
    if (existing && input.body.action === 'extend' && existing.retainUntil.getTime() >= nextUntil.getTime()) {
      return { retainUntil: existing.retainUntil.toISOString(), revision }
    }
    const [worker] = await locked(tx, tx.select().from(workers).where(eq(workers.id, live.ownerWorkerId)))
    const limit = retentionQuota(worker?.maxSessions ?? 0, retention.reservedFreeSlotsPerWorker)
    if (limit <= 0) throw conflict('RETENTION_QUOTA_EXCEEDED', '该执行节点不接受保留')
    const retained = await tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, live.ownerWorkerId),
          inArray(browserSessions.status, ['CREATING', 'OPEN']),
          sql`${browserSessions.retainUntil} > ${databaseNow(tx)}`,
        ),
      )
    const already = retained.some((row) => row.id === live.id)
    if (retained.length - (already ? 1 : 0) >= limit) {
      throw conflict('RETENTION_QUOTA_EXCEEDED', '该执行节点保留配额已满', {
        quotaUsed: retained.length,
        quotaLimit: limit,
      })
    }
    if (existing) {
      await updateRows(
        tx,
        sessionRetentionIntents,
        {
          retainUntil: nextUntil,
          reason: input.body.reason ?? existing.reason,
          platformConfigRevision: revision,
          updatedAt: now,
        },
        eq(sessionRetentionIntents.id, existing.id),
      )
    } else {
      await insertRows(tx, sessionRetentionIntents, {
        id: newId(),
        targetId: input.key.targetId,
        targetAccountId: input.key.targetAccountId,
        retainUntil: nextUntil,
        reason: input.body.reason ?? null,
        createdBy: input.actor.id,
        platformConfigRevision: revision,
        createdAt: now,
        updatedAt: now,
      })
    }
    await updateRows(
      tx,
      browserSessions,
      {
        retainUntil: nextUntil,
        nextAuthCheckAt: new Date(now.getTime() + retention.maintenanceIntervalSeconds * 1000),
        updatedAt: now,
      },
      eq(browserSessions.id, live.id),
    )
    await appendSessionEvent(tx, {
      key: input.key,
      type: input.body.action === 'extend' ? 'retention.extended' : 'retention.set',
      sessionId: live.id,
      generation: live.generation,
      payload: { retainUntil: nextUntil.toISOString(), platformConfigRevision: revision },
    })
    await recordAudit(
      tx,
      input.actor,
      'session.retention',
      'session',
      live.id,
      input.body.action === 'extend' ? '延长会话保留' : '设置会话保留',
    )
    return { retainUntil: nextUntil.toISOString(), revision }
  })
}

export async function adoptSessionRetention(
  db: Db,
  input: { fromSessionId: string; toSessionId: string },
): Promise<void> {
  await atomic(db, async (tx) => {
    const { browserSessions, sessionRetentionIntents, targetAccounts } = schemaFor(tx)
    const from = await getSessionById(tx, input.fromSessionId)
    if (!from?.retainUntil || from.retainUntil.getTime() <= Date.now()) return
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, from.targetAccountId)),
    )
    const [intent] = await locked(
      tx,
      tx
        .select()
        .from(sessionRetentionIntents)
        .where(
          and(
            eq(sessionRetentionIntents.targetId, from.targetId),
            eq(sessionRetentionIntents.targetAccountId, from.targetAccountId),
          ),
        ),
    )
    if (!intent || intent.retainUntil.getTime() <= Date.now()) return
    await updateRows(
      tx,
      browserSessions,
      {
        retainUntil: intent.retainUntil,
        predecessorSessionId: from.id,
        nextAuthCheckAt: new Date(),
        updatedAt: new Date(),
      },
      and(
        eq(browserSessions.id, input.toSessionId),
        eq(browserSessions.targetId, from.targetId),
        eq(browserSessions.targetAccountId, from.targetAccountId),
      ),
    )
  })
}

export async function scheduleNextAuthCheck(db: Db, sessionId: string): Promise<void> {
  const { retention } = await readRetentionConfig(db)
  const { browserSessions } = schemaFor(db)
  const now = await clockNow(db)
  await updateRows(
    db,
    browserSessions,
    {
      nextAuthCheckAt: new Date(now.getTime() + retention.maintenanceIntervalSeconds * 1000),
      updatedAt: now,
    },
    eq(browserSessions.id, sessionId),
  )
}

export async function listDueRetainedSessions(db: Db, workerId: string) {
  const { browserSessions, targetAccounts, targets, targetAccountAuthBudget } = schemaFor(db)
  return db
    .select({ session: browserSessions })
    .from(browserSessions)
    .innerJoin(targetAccounts, eq(targetAccounts.id, browserSessions.targetAccountId))
    .innerJoin(targets, eq(targets.id, browserSessions.targetId))
    .leftJoin(targetAccountAuthBudget, eq(targetAccountAuthBudget.targetAccountId, targetAccounts.id))
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        eq(browserSessions.status, 'OPEN'),
        sql`${browserSessions.retainUntil} > ${databaseNow(db)}`,
        sql`${browserSessions.nextAuthCheckAt} <= ${databaseNow(db)}`,
        isNull(targetAccountAuthBudget.pausedReason),
        isNull(targetAccounts.deletedAt),
        isNull(targets.deletedAt),
        eq(targetAccounts.status, 'active'),
        eq(targets.status, 'active'),
      ),
    )
}

function primaryAction(status: AccountSessionStatus): string {
  if (status === 'unprepared') return 'PREPARE'
  if (status === 'needs_check') return 'VERIFY_AUTH'
  if (status === 'needs_login' || status === 'identity_mismatch') return 'LOGIN'
  if (status === 'lost') return 'dispose'
  if (status === 'maintenance' || status === 'executing') return 'view'
  return 'VERIFY_AUTH'
}

function actionsFor(status: AccountSessionStatus, retained: boolean) {
  const idle =
    status === 'ready' ||
    status === 'needs_check' ||
    status === 'needs_login' ||
    status === 'identity_mismatch'
  return [
    {
      kind: 'PREPARE',
      enabled: status === 'unprepared',
      disabledReason: status === 'unprepared' ? null : '已有会话或不适用',
    },
    { kind: 'VERIFY_AUTH', enabled: idle, disabledReason: idle ? null : '当前不能检查登录' },
    {
      kind: 'LOGIN',
      enabled: idle || status === 'unprepared',
      disabledReason: idle || status === 'unprepared' ? null : '当前不能登录',
    },
    {
      kind: 'RENEW_AUTH',
      enabled: status === 'ready',
      disabledReason: status === 'ready' ? null : '仅就绪会话可续登',
    },
    {
      kind: 'retention',
      enabled: idle && !retained,
      disabledReason: idle ? (retained ? '已在保留中' : null) : '需要空闲实例',
    },
    { kind: 'CLOSE', enabled: idle, disabledReason: idle ? null : '仅空闲实例可关闭' },
    { kind: 'RESTART', enabled: idle, disabledReason: idle ? null : '仅空闲实例可重启' },
    {
      kind: 'RESET_PROFILE',
      enabled: idle || status === 'unprepared' || status === 'lost',
      disabledReason: null,
    },
  ]
}

export async function listAccountSessionOverview(
  db: Db,
  input: { search?: string; filter?: SessionOverviewFilter; cursor?: string; limit?: number },
): Promise<SessionOverviewResponse> {
  const { targets, targetAccounts } = schemaFor(db)
  const limit = input.limit ?? 20
  const accounts = await db
    .select({
      targetId: targets.id,
      targetName: targets.name,
      targetAccountId: targetAccounts.id,
      accountDisplayName: targetAccounts.displayName,
      accountUsername: targetAccounts.username,
      accountStatus: targetAccounts.status,
    })
    .from(targetAccounts)
    .innerJoin(targets, eq(targets.id, targetAccounts.targetId))
    .where(
      and(
        isNull(targets.deletedAt),
        isNull(targetAccounts.deletedAt),
        input.search
          ? or(
              sql`${targets.name} LIKE ${`%${input.search}%`}`,
              sql`${targetAccounts.displayName} LIKE ${`%${input.search}%`}`,
              sql`${targetAccounts.username} LIKE ${`%${input.search}%`}`,
            )
          : undefined,
      ),
    )
    .orderBy(asc(targets.name), asc(targetAccounts.displayName), asc(targetAccounts.id))

  const items: AccountSessionOverviewItem[] = []
  const summary = {
    total: 0,
    available: 0,
    needsCheck: 0,
    needsLogin: 0,
    identityMismatch: 0,
    maintenance: 0,
    executing: 0,
    lost: 0,
    unprepared: 0,
    retained: 0,
  }
  const now = await clockNow(db)
  for (const account of accounts) {
    const key = { targetId: account.targetId, targetAccountId: account.targetAccountId }
    const facts = await loadOccupancyFacts(db, key)
    const status = statusFromFacts(facts)
    const retained = Boolean(facts.live?.retainUntil && facts.live.retainUntil.getTime() > now.getTime())
    summary.total += 1
    if (status === 'ready') summary.available += 1
    if (status === 'needs_check') summary.needsCheck += 1
    if (status === 'needs_login') summary.needsLogin += 1
    if (status === 'identity_mismatch') summary.identityMismatch += 1
    if (status === 'maintenance') summary.maintenance += 1
    if (status === 'executing') summary.executing += 1
    if (status === 'lost') summary.lost += 1
    if (status === 'unprepared') summary.unprepared += 1
    if (retained) summary.retained += 1
    if (!matchesOverviewFilter(status, retained, input.filter)) continue
    items.push({
      targetId: account.targetId,
      targetName: account.targetName,
      targetAccountId: account.targetAccountId,
      accountDisplayName: account.accountDisplayName,
      accountUsername: account.accountUsername,
      accountStatus: account.accountStatus,
      status,
      retained,
      sessionId: facts.live?.id ?? null,
      generation: facts.live?.generation ?? null,
      instanceStatus: facts.live?.status ?? null,
      authState: facts.live?.authState ?? null,
      identityState: facts.live?.identityState ?? null,
      observedTier: facts.live?.observedTier ?? null,
      occupyingRunId: facts.lease?.runId ?? null,
      occupyingOperationId: facts.lease?.operationId ?? facts.activeOp?.id ?? null,
      retainUntil: facts.live?.retainUntil?.toISOString() ?? null,
      lastAuthCheckedAt: facts.live?.lastAuthCheckedAt?.toISOString() ?? null,
      lastAuthSuccessAt: facts.live?.lastAuthSuccessAt?.toISOString() ?? null,
      ownerWorkerId: facts.live?.ownerWorkerId ?? null,
      primaryAction: primaryAction(status),
    })
  }
  const offset = input.cursor ? Number(input.cursor) || 0 : 0
  const page = items.slice(offset, offset + limit)
  return {
    items: page,
    nextCursor: offset + limit < items.length ? String(offset + limit) : undefined,
    summary,
    asOf: now.toISOString(),
  }
}

export async function getAccountSessionDetail(db: Db, key: SessionKey): Promise<AccountSessionDetail> {
  const { targets, targetAccounts, sessionRetentionIntents, workers } = schemaFor(db)
  const [account] = await db
    .select({
      targetId: targets.id,
      targetName: targets.name,
      targetAccountId: targetAccounts.id,
      accountDisplayName: targetAccounts.displayName,
      accountUsername: targetAccounts.username,
      accountStatus: targetAccounts.status,
      hasPassword: targetAccounts.secretId,
      expectedIdentity: targetAccounts.expectedIdentity,
    })
    .from(targetAccounts)
    .innerJoin(targets, eq(targets.id, targetAccounts.targetId))
    .where(and(eq(targetAccounts.id, key.targetAccountId), eq(targetAccounts.targetId, key.targetId)))
    .limit(1)
  if (!account) throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在')
  const facts = await loadOccupancyFacts(db, key)
  const now = await clockNow(db)
  const retained = Boolean(facts.live?.retainUntil && facts.live.retainUntil.getTime() > now.getTime())
  const status = statusFromFacts(facts)
  const [intent] = await db
    .select()
    .from(sessionRetentionIntents)
    .where(
      and(
        eq(sessionRetentionIntents.targetId, key.targetId),
        eq(sessionRetentionIntents.targetAccountId, key.targetAccountId),
      ),
    )
    .limit(1)
  let quotaUsed = 0
  let quotaLimit = 0
  if (facts.live) {
    const [worker] = await db.select().from(workers).where(eq(workers.id, facts.live.ownerWorkerId)).limit(1)
    const { retention } = await readRetentionConfig(db)
    quotaLimit = retentionQuota(worker?.maxSessions ?? 0, retention.reservedFreeSlotsPerWorker)
    const { browserSessions } = schemaFor(db)
    const rows = await db
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, facts.live.ownerWorkerId),
          inArray(browserSessions.status, ['CREATING', 'OPEN']),
          sql`${browserSessions.retainUntil} > ${databaseNow(db)}`,
        ),
      )
    quotaUsed = rows.length
  }
  return {
    targetId: account.targetId,
    targetName: account.targetName,
    targetAccountId: account.targetAccountId,
    accountDisplayName: account.accountDisplayName,
    accountUsername: account.accountUsername,
    accountStatus: account.accountStatus,
    hasPassword: Boolean(account.hasPassword),
    expectedIdentity: account.expectedIdentity,
    authCapability: facts.live?.observedTier ?? 'LEGACY',
    status,
    retained,
    session: facts.live
      ? {
          id: facts.live.id,
          status: facts.live.status,
          generation: facts.live.generation,
          ownerWorkerId: facts.live.ownerWorkerId,
          authState: facts.live.authState,
          identityState: facts.live.identityState,
          observedTier: facts.live.observedTier,
          lastAuthCheckedAt: facts.live.lastAuthCheckedAt?.toISOString() ?? null,
          lastAuthSuccessAt: facts.live.lastAuthSuccessAt?.toISOString() ?? null,
          authValidUntil: facts.live.authValidUntil?.toISOString() ?? null,
          lastExpectedIdentity: facts.live.lastExpectedIdentity,
          retainUntil: facts.live.retainUntil?.toISOString() ?? null,
        }
      : null,
    occupancy: facts.lease
      ? {
          purpose: facts.lease.purpose,
          occupyingRunId: facts.lease.runId,
          occupyingOperationId: facts.lease.operationId,
        }
      : null,
    retention: intent
      ? {
          retainUntil: intent.retainUntil.toISOString(),
          reason: intent.reason,
          quotaUsed,
          quotaLimit,
          workerId: facts.live?.ownerWorkerId ?? null,
          platformConfigRevision: intent.platformConfigRevision,
        }
      : null,
    currentOperation: facts.activeOp
      ? {
          id: facts.activeOp.id,
          kind: facts.activeOp.kind,
          status: facts.activeOp.status,
          reusedRunId:
            typeof facts.activeOp.kindParams?.reusedRunId === 'string'
              ? facts.activeOp.kindParams.reusedRunId
              : null,
        }
      : null,
    actions: actionsFor(status, retained),
    asOf: now.toISOString(),
  }
}

export async function countSessionEventWatermark(db: Db, key?: SessionKey): Promise<number> {
  const { sessionEvents } = schemaFor(db)
  const [row] = await db
    .select({ seq: sql<number>`coalesce(max(${sessionEvents.seq}), 0)` })
    .from(sessionEvents)
    .where(
      key
        ? and(
            eq(sessionEvents.targetId, key.targetId),
            eq(sessionEvents.targetAccountId, key.targetAccountId),
          )
        : undefined,
    )
  return Number(row?.seq ?? 0)
}

void databaseNow
