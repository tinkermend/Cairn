import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { RequestSessionOperationBody } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor, updateRows } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { SessionOperationRow } from '../records.js'
import {
  assertMaintenanceAuthorized,
  assertSessionActorPermission,
} from './access.js'
import { requestSessionOperation, contentDigestFor } from './occupancy.js'
import { appendSessionEvent } from './session-events.js'
import type { SessionKey } from './sessions.js'
import { loadOccupancyFacts } from './session-overview.js'

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
