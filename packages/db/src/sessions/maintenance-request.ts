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
import { readAccountSessionCap } from './account-session-concurrency.js'
import { lockConsoleAuthorization, assertTargetPermission } from '../console/target-authorization.js'
import {
  availabilityWaitReason,
  countEligibleMaintenanceWorkers,
  expireQueuedSessionOperations,
  recordOperationWait,
} from './operation-queue.js'
import { lockOperationRow } from './occupancy-tx.js'

export async function requestMaintenanceOperation(
  db: Db,
  input: {
    key: SessionKey
    body: RequestSessionOperationBody
    origin?: 'USER' | 'BACKGROUND'
    actor?: AuditActor
  },
): Promise<{
  operation: SessionOperationRow | null
  created: boolean
  reusedRunId: string | null
  /** 受理时可领取该操作的在线节点数；未新建操作时为 null。 */
  eligibleWorkers: number | null
}> {
  return atomic(db, async (tx) => {
    if (input.actor && input.origin !== 'BACKGROUND') await lockConsoleAuthorization(tx, input.actor.id)
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
    // 截止已过的排队不能靠 Worker 清理（Worker 可能正停着），受理时先在账号锁内收掉，免得挡住重新发起。
    await expireQueuedSessionOperations(tx, { now: await clockNow(tx), key: input.key })
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
        eligibleWorkers: null,
      }
    }
    if (input.body.kind === 'RESET_PROFILE' && input.body.confirmAccountId !== input.key.targetAccountId) {
      throw conflict('SESSION_POLICY_INVALID', '清除登录数据必须确认当前账号')
    }
    const facts = await loadOccupancyFacts(tx, input.key)
    const instances = facts.instances ?? []
    const destructive = input.body.kind === 'CLOSE' || input.body.kind === 'RESTART' || input.body.kind === 'RESET_PROFILE'
    if (destructive && instances.length > 1 && !input.body.expectedSessionId) {
      throw conflict('SESSION_INSTANCE_REQUIRED', '多个会话时必须指定要操作的会话')
    }
    const selected =
      instances.find((item) => item.session.id === input.body.expectedSessionId) ??
      (instances.length === 1 ? instances[0] : null)
    const selectedLease = selected?.lease ?? null
    const selectedLive = selected?.session ?? null
    const selectedOp =
      facts.activeOps?.find((op) => op.expectedSessionId && op.expectedSessionId === selectedLive?.id) ??
      (instances.length <= 1 ? facts.activeOp : null)
    if (origin === 'BACKGROUND') {
      if (selectedLease || selected?.holding)
        return { operation: selectedOp ?? facts.activeOp, created: false, reusedRunId: null, eligibleWorkers: null }
    }
    if (origin === 'BACKGROUND' && selectedOp)
      return { operation: selectedOp, created: false, reusedRunId: null, eligibleWorkers: null }
    if (selectedOp && input.body.kind !== 'REFRESH_LOGIN_PAGE')
      throw conflict('SESSION_OPERATION_CONFLICT', '已有会话操作尚未完成', {
        occupyingOperationId: selectedOp.id,
      })
    if (selectedLive && instances.length === 1 && (!input.body.expectedSessionId || input.body.expectedGeneration == null)) {
      throw conflict('SESSION_GENERATION_CHANGED', '操作已有实例必须提供实例与代次，请刷新后重试')
    }
    if (input.body.expectedSessionId) {
      if (
        !selectedLive ||
        selectedLive.id !== input.body.expectedSessionId ||
        (input.body.expectedGeneration != null && selectedLive.generation !== input.body.expectedGeneration)
      ) {
        throw conflict('SESSION_GENERATION_CHANGED', '会话实例已重建，请刷新后重试')
      }
    }
    if (selected?.holding || selectedLease?.purpose === 'EXECUTION') {
      throw conflict('SESSION_OPERATION_CONFLICT', '该会话正在执行运行', {
        occupyingRunId: selectedLease?.runId ?? null,
      })
    }
    if (selectedLease?.purpose === 'AUTH_WAIT' && selectedLease.ownerKind === 'RUN' && selectedLease.runId) {
      if (input.body.kind === 'LOGIN') {
        // 下方入账；领取时复用 Run 的 AUTH_WAIT。
      }
      if (input.body.kind !== 'LOGIN' && input.body.kind !== 'REFRESH_LOGIN_PAGE')
        throw conflict('SESSION_OPERATION_CONFLICT', '该会话正在等待运行认证', {
          occupyingRunId: selectedLease.runId,
        })
    }
    if (
      selectedLease?.purpose === 'AUTH_WAIT' &&
      selectedLease.operationId &&
      input.body.kind !== 'REFRESH_LOGIN_PAGE'
    ) {
      throw conflict('SESSION_OPERATION_CONFLICT', '该会话已有认证等待', {
        occupyingOperationId: selectedLease.operationId,
      })
    }
    if (
      input.body.kind === 'REFRESH_LOGIN_PAGE' &&
      selectedLease?.purpose === 'AUTH_WAIT' &&
      (selectedLive?.authControlActorId !== input.actor?.id ||
        !selectedLive?.authControlExpiresAt ||
        selectedLive.authControlExpiresAt.getTime() <= Date.now())
    )
      throw conflict('AUTH_CONTROL_INVALID', '刷新认证页须持有当前输入权')
    if (selectedLease?.purpose === 'MAINTENANCE' && selectedLease.operationId) {
      throw conflict('SESSION_OPERATION_CONFLICT', '该会话正在维护', {
        occupyingOperationId: selectedLease.operationId,
      })
    }
    if (input.body.kind === 'CLOSE' || input.body.kind === 'RESTART') {
      if (!selectedLive || selectedLive.status !== 'OPEN' || selectedLease) {
        throw conflict('SESSION_NOT_CLAIMABLE', '关闭或重启只能在空闲活实例上执行')
      }
    }
    if (input.body.kind === 'RESET_PROFILE') {
      if (selectedLease) {
        throw conflict('SESSION_OPERATION_CONFLICT', '该会话正在被占用，不能清除登录数据')
      }
      if (selectedLive?.status === 'LOST') {
        throw conflict('SESSION_NOT_CLAIMABLE', '失联实例须先处置，不能直接清除登录数据')
      }
    }
    if (input.body.kind === 'PREPARE') {
      const cap = await readAccountSessionCap(tx, input.key)
      if (instances.length >= cap.effectiveCap && !selectedLive) {
        throw conflict('SESSION_ACCOUNT_CAP_EXCEEDED', '账号并发会话已达上限')
      }
    }
    const requested = await requestSessionOperation(tx, {
      key: input.key,
      kind: input.body.kind,
      kindParams: {
        requestedBy: input.actor?.id ?? null,
        requestDigest,
        ...(input.body.kind === 'REFRESH_LOGIN_PAGE' ? { pageRef: input.body.pageRef } : {}),
        ...(input.body.kind === 'RESET_PROFILE' ? { confirmAccountId: input.body.confirmAccountId } : {}),
        ...(selectedLease?.purpose === 'AUTH_WAIT'
          ? { reusedRunId: selectedLease.runId, reusedOperationId: selectedLease.operationId }
          : {}),
      },
      origin,
      idempotencyKey: input.body.idempotencyKey,
      expectedSessionId: input.body.expectedSessionId ?? selectedLive?.id ?? null,
      expectedGeneration: input.body.expectedGeneration ?? selectedLive?.generation ?? null,
    })
    let eligibleWorkers: number | null = null
    if (requested.created) {
      await appendSessionEvent(tx, {
        key: input.key,
        type: 'operation.requested',
        sessionId: selectedLive?.id ?? null,
        generation: selectedLive?.generation ?? null,
        operationId: requested.operation.id,
        payload: { kind: input.body.kind, origin },
      })
      if (origin === 'USER') {
        const availability = await countEligibleMaintenanceWorkers(tx, { key: input.key, kind: input.body.kind })
        eligibleWorkers = availability.eligible
        const reason = availabilityWaitReason(availability)
        if (reason) {
          await recordOperationWait(tx, requested.operation, await clockNow(tx), reason, {
            onlineWorkers: availability.online,
          })
        }
      }
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
      operation: (await lockOperationRow(tx, requested.operation.id)) ?? requested.operation,
      created: requested.created,
      reusedRunId: selectedLease?.purpose === 'AUTH_WAIT' ? selectedLease.runId : null,
      eligibleWorkers,
    }
  })
}

export async function cancelSessionOperation(
  db: Db,
  input: { operationId: string; actor?: AuditActor },
): Promise<SessionOperationRow> {
  return atomic(db, async (tx) => {
    if (input.actor) await lockConsoleAuthorization(tx, input.actor.id)
    const { sessionOperations, sessionLeases, targetAccounts } = schemaFor(tx)
    const [row] = await tx
      .select()
      .from(sessionOperations)
      .where(eq(sessionOperations.id, input.operationId))
      .limit(1)
    if (!row) throw notFound('OPERATION_NOT_FOUND', '会话操作不存在')
    if (input.actor) await assertTargetPermission(tx, input.actor.id, row.targetId, 'session:control')
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, row.targetAccountId)),
    )
    if (input.actor) await assertSessionActorPermission(tx, input.actor.id, 'session:control')
    const checkedAt = await clockNow(tx)
    if (row.status === 'QUEUED' && row.queueDeadlineAt <= checkedAt) {
      // 已过排队截止：取消就是收掉它，返回真实的过期终态而不是报「不能取消」。
      await expireQueuedSessionOperations(tx, {
        now: checkedAt,
        key: { targetId: row.targetId, targetAccountId: row.targetAccountId },
      })
      const settled = await lockOperationRow(tx, row.id)
      if (settled && settled.status !== 'QUEUED') return settled
    }
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
