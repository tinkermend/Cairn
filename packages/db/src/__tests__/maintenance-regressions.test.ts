import { afterEach, beforeEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SESSION_MAINTENANCE_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL } from '@cairn/shared'
import { openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { forceGrantForRun } from './lease-harness.js'
import {
  acquireAuthControl,
  appendSessionEvent,
  claimSessionOperation,
  claimSessionUse,
  createRunWithSnapshot,
  createScenarioWithVersion,
  finishSessionOperation,
  getSessionOperation,
  listReapableSessions,
  listSessionEventsAfter,
  markSessionOperationWaitingForAuth,
  registerWorker,
  requestMaintenanceOperation,
  setSessionRetention,
  setSessionStatus,
  transitionSessionUse,
} from '../test-entry.js'

let h: Awaited<ReturnType<typeof openContractDb>>
let key: { targetId: string; targetAccountId: string }
let actorId: string, workerId: string, instanceId: string
beforeEach(async () => {
  h = await openContractDb('postgres')
  const { consoleAccounts, targets, targetAccounts, consoleRoles, consoleAccountRoles } = schemaFor(h.db)
  actorId = newId()
  workerId = 'review-worker'
  instanceId = newId()
  key = { targetId: newId(), targetAccountId: newId() }
  await h.db.insert(consoleAccounts).values({ id: actorId, displayName: 'review', status: 'active' })
  const [admin] = await h.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
  if (!admin) throw new Error('missing admin role fixture')
  await h.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
  await h.db
    .insert(targets)
    .values({
      id: key.targetId,
      code: 'review',
      name: 'review',
      entryUrl: 'https://example.com',
      status: 'active',
    })
  await h.db
    .insert(targetAccounts)
    .values({
      id: key.targetAccountId,
      targetId: key.targetId,
      displayName: 'review',
      username: 'test',
      status: 'active',
    })
  await registerWorker(h.db, {
    workerId,
    instanceId,
    capacity: 8,
    maxSessions: 3,
    lostAfterSeconds: 60,
    protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
  })
})
afterEach(async () => {
  await h?.close()
})
async function prepare(idempotencyKey = 'prepare-review-key') {
  const req = await requestMaintenanceOperation(h.db, {
    key,
    body: { kind: 'PREPARE', idempotencyKey },
    actor: { id: actorId },
  })
  const claim = await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })
  if (!claim?.session || !claim.grant) throw Error('fixture claim failed')
  await setSessionStatus(h.db, {
    sessionId: claim.session.id,
    expectedVersion: claim.session.version,
    status: 'OPEN',
    ownerWorkerId: workerId,
    ownerWorkerInstanceId: instanceId,
  })
  return { req, claim }
}
async function idle() {
  const { claim } = await prepare()
  await finishSessionOperation(h.db, { operationId: claim.operation.id, workerId, status: 'SUCCEEDED' })
  return claim.session!
}
it('保留中的会话应排除空闲回收', async () => {
  const s = await idle()
  await setSessionRetention(h.db, {
    key,
    body: { action: 'set', retainSeconds: 3600 },
    actor: { id: actorId },
  })
  const { browserSessions } = schemaFor(h.db)
  await h.db
    .update(browserSessions)
    .set({ lastUsedAt: new Date(Date.now() - 601000) })
    .where(eq(browserSessions.id, s.id))
  expect((await listReapableSessions(h.db, workerId)).map((x) => x.id)).not.toContain(s.id)
})
it('独立操作 AUTH_WAIT 应能领取控制权', async () => {
  const { claim } = await prepare()
  await transitionSessionUse(h.db, {
    sessionId: claim.session!.id,
    fromPurpose: 'MAINTENANCE',
    toPurpose: 'AUTH_WAIT',
    owner: { kind: 'SESSION_OPERATION', operationId: claim.operation.id },
    holderWorkerId: workerId,
    holderInstanceId: instanceId,
    leaseTtlSeconds: 60,
    waitSeconds: 600,
    reason: 'review',
  })
  await markSessionOperationWaitingForAuth(h.db, { operationId: claim.operation.id, workerId })
  await expect(
    acquireAuthControl(h.db, {
      sessionId: claim.session!.id,
      runId: claim.operation.id,
      actor: { id: actorId },
      workerId,
      workerInstanceId: instanceId,
      sessionGeneration: claim.session!.generation,
    }),
  ).resolves.toHaveProperty('token')
})
it('关闭操作已领取后应阻止新的执行租约', async () => {
  const s = await idle()
  await requestMaintenanceOperation(h.db, {
    key,
    body: {
      kind: 'CLOSE',
      idempotencyKey: 'close-review-key',
      expectedSessionId: s.id,
      expectedGeneration: s.generation,
    },
    actor: { id: actorId },
  })
  const close = await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })
  expect(close?.operation.kind).toBe('CLOSE')
  const scenario = await createScenarioWithVersion(h.db, {
    targetId: key.targetId,
    name: 'review',
    actor: { id: actorId },
    steps: [{ id: newId(), name: 'echo', type: 'echo', effectType: 'READ_ONLY', input: { value: 'review' } }],
  })
  const run = await createRunWithSnapshot(h.db, {
    scenarioId: scenario.id,
    targetAccountId: key.targetAccountId,
    actor: { id: actorId },
  })
  const grant = await forceGrantForRun(h, run.detail.id, workerId)
  const use = await claimSessionUse(h.db, {
    key,
    owner: { kind: 'RUN', runId: run.detail.id, runFencingToken: grant.fencingToken },
    purpose: 'EXECUTION',
    holderWorkerId: workerId,
    holderInstanceId: instanceId,
    leaseTtlSeconds: 60,
    reusePolicy: 'NEW_PAGE',
    idleTtlSeconds: 600,
    maxLifetimeSeconds: 14400,
  })
  expect(use.ok).toBe(false)
})
it('总览游标不应漏掉后来另一个账号的低 seq 事件', async () => {
  await appendSessionEvent(h.db, { key, type: 'operation.requested' })
  await appendSessionEvent(h.db, { key, type: 'operation.finished' })
  const first = await listSessionEventsAfter(h.db, { afterSeq: 0 })
  const another = { ...key, targetAccountId: newId() }
  await h.db
    .insert(schemaFor(h.db).targetAccounts)
    .values({
      id: another.targetAccountId,
      targetId: key.targetId,
      displayName: 'another',
      username: 'another',
      status: 'active',
    })
  await appendSessionEvent(h.db, { key: another, type: 'operation.requested' })
  expect(
    await listSessionEventsAfter(h.db, { watermarks: { [key.targetAccountId]: first.at(-1)!.seq } }),
  ).toHaveLength(1)
})
it('操作已领取后相同请求重试应返回原操作', async () => {
  const { req } = await prepare()
  await expect(
    requestMaintenanceOperation(h.db, {
      key,
      body: { kind: 'PREPARE', idempotencyKey: 'prepare-review-key' },
      actor: { id: actorId },
    }),
  ).resolves.toMatchObject({ created: false, operation: { id: req.operation!.id } })
})
it('关闭排队后出现占用应失败，而不在运行结束后再关闭', async () => {
  const s = await idle()
  const req = await requestMaintenanceOperation(h.db, {
    key,
    body: {
      kind: 'CLOSE',
      idempotencyKey: 'close-review-key',
      expectedSessionId: s.id,
      expectedGeneration: s.generation,
    },
    actor: { id: actorId },
  })
  const { sessionLeases } = schemaFor(h.db)
  await h.db
    .insert(sessionLeases)
    .values({
      id: newId(),
      sessionId: s.id,
      purpose: 'MAINTENANCE',
      ownerKind: 'SESSION_OPERATION',
      operationId: req.operation!.id,
      holderWorkerId: workerId,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60000),
      sessionGeneration: s.generation,
      sessionFencingToken: 1,
    })
  expect(await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })).toBeNull()
  expect((await getSessionOperation(h.db, req.operation!.id))?.status).toBe('FAILED')
})
it('无租约的 CLOSE 在 Worker 重启后应收敛失败', async () => {
  const s = await idle()
  const req = await requestMaintenanceOperation(h.db, {
    key,
    body: {
      kind: 'CLOSE',
      idempotencyKey: 'close-review-crash',
      expectedSessionId: s.id,
      expectedGeneration: s.generation,
    },
    actor: { id: actorId },
  })
  await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })
  const { isolateOrphanedSessions, reapSessionLeases } = await import('../test-entry.js')
  const replacement = newId()
  const { workers, browserSessions } = schemaFor(h.db)
  await h.db.update(workers).set({ instanceId: replacement }).where(eq(workers.id, workerId))
  expect(await isolateOrphanedSessions(h.db, workerId, replacement)).toBe(1)
  expect((await h.db.select().from(browserSessions).where(eq(browserSessions.id, s.id)))[0]!.status).toBe(
    'LOST',
  )
  await reapSessionLeases(h.db)
  expect((await getSessionOperation(h.db, req.operation!.id))?.status).toBe('FAILED')
})
it('停用的账号不应被用户 PREPARE 领取', async () => {
  const { targetAccounts } = schemaFor(h.db)
  await h.db
    .update(targetAccounts)
    .set({ status: 'disabled' })
    .where(eq(targetAccounts.id, key.targetAccountId))
  await expect(
    requestMaintenanceOperation(h.db, {
      key,
      body: { kind: 'PREPARE', idempotencyKey: 'disabled-prepare-key' },
      actor: { id: actorId },
    }),
  ).rejects.toMatchObject({ code: 'AUTH_CONFIGURATION_REVOKED' })
  expect(await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })).toBeNull()
})

it('领取前撤销权限不得执行已排队操作', async () => {
  const req = await requestMaintenanceOperation(h.db, {
    key,
    body: { kind: 'PREPARE', idempotencyKey: 'revoke-before-claim' },
    actor: { id: actorId },
  })
  const { consoleAccountRoles } = schemaFor(h.db)
  await h.db.delete(consoleAccountRoles).where(eq(consoleAccountRoles.consoleAccountId, actorId))
  expect(await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })).toBeNull()
  expect((await getSessionOperation(h.db, req.operation!.id))?.errorCode).toBe('AUTH_CONFIGURATION_REVOKED')
})
it('旧页面必须携带代次，不能关闭替换后的实例', async () => {
  await idle()
  await expect(
    requestMaintenanceOperation(h.db, {
      key,
      body: { kind: 'CLOSE', idempotencyKey: 'missing-generation' },
      actor: { id: actorId },
    }),
  ).rejects.toMatchObject({ code: 'SESSION_GENERATION_CHANGED' })
})
it('登录提交后进程失联必须收敛到未知结果，迟到成功无效', async () => {
  const { claim } = await prepare()
  const { markMaintenanceLoginSubmitted, reapSessionLeases, getSessionById } =
    await import('../test-entry.js')
  await markMaintenanceLoginSubmitted(h.db, claim.operation.id, instanceId)
  await h.db
    .update(schemaFor(h.db).workers)
    .set({ instanceId: newId() })
    .where(eq(schemaFor(h.db).workers.id, workerId))
  await reapSessionLeases(h.db)
  expect((await getSessionOperation(h.db, claim.operation.id))?.errorCode).toBe('OUTCOME_UNKNOWN')
  expect((await getSessionById(h.db, claim.session!.id))?.authState).toBe('UNKNOWN')
  expect(
    await finishSessionOperation(h.db, {
      operationId: claim.operation.id,
      workerId,
      workerInstanceId: instanceId,
      status: 'SUCCEEDED',
    }),
  ).toBe(false)
})
it('同账号并发事件的序号唯一且连续', async () => {
  await Promise.all(
    Array.from({ length: 8 }, () => appendSessionEvent(h.db, { key, type: 'operation.requested' })),
  )
  const events = await listSessionEventsAfter(h.db, { key, afterSeq: 0 })
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})

it('受控重启不建立维护租约，并延续保留截止', async () => {
  const s = await idle()
  await setSessionRetention(h.db, {
    key,
    body: { action: 'set', retainSeconds: 600 },
    actor: { id: actorId },
  })
  const { recreateSessionForOperation, adoptSessionRetention, getSessionById, findActiveLeaseRow } =
    await import('../test-entry.js')
  await requestMaintenanceOperation(h.db, {
    key,
    body: {
      kind: 'RESTART',
      idempotencyKey: 'restart-controlled',
      expectedSessionId: s.id,
      expectedGeneration: s.generation,
    },
    actor: { id: actorId },
  })
  const claim = await claimSessionOperation(h.db, { workerId, instanceId, leaseTtlSeconds: 60 })
  expect(claim?.grant).toBeNull()
  const closing = (await getSessionById(h.db, s.id))!
  await setSessionStatus(h.db, {
    sessionId: s.id,
    expectedVersion: closing.version,
    status: 'CLOSED',
    ownerWorkerId: workerId,
    ownerWorkerInstanceId: instanceId,
  })
  const created = await recreateSessionForOperation(h.db, {
    operationId: claim!.operation.id,
    workerId,
    instanceId,
  })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  await adoptSessionRetention(h.db, { fromSessionId: s.id, toSessionId: created.session.id })
  const next = (await getSessionById(h.db, created.session.id))!
  expect(next.retainUntil?.toISOString()).toBe(closing.retainUntil?.toISOString())
  expect(next.generation).toBe(s.generation + 1)
  expect(await findActiveLeaseRow(h.db, next.id)).toBeNull()
})

async function waitingOperationWithControl() {
  const { claim } = await prepare()
  await transitionSessionUse(h.db, {
    sessionId: claim.session!.id,
    fromPurpose: 'MAINTENANCE',
    toPurpose: 'AUTH_WAIT',
    owner: { kind: 'SESSION_OPERATION', operationId: claim.operation.id },
    holderWorkerId: workerId,
    holderInstanceId: instanceId,
    leaseTtlSeconds: 60,
    waitSeconds: 600,
    reason: 'manual',
  })
  await markSessionOperationWaitingForAuth(h.db, { operationId: claim.operation.id, workerId })
  const control = await acquireAuthControl(h.db, {
    sessionId: claim.session!.id,
    runId: claim.operation.id,
    actor: { id: actorId },
    workerId,
    workerInstanceId: instanceId,
    sessionGeneration: claim.session!.generation,
  })
  const authControl = {
    sessionId: claim.session!.id,
    actorId,
    generation: claim.session!.generation,
    epoch: control.epoch,
    token: control.token,
  }
  return { claim, authControl }
}

it('完成独立认证须持有有效控制令牌，并原子释放等待占用', async () => {
  const { claim, authControl } = await waitingOperationWithControl()
  expect(
    await finishSessionOperation(h.db, {
      operationId: claim.operation.id,
      workerId,
      workerInstanceId: instanceId,
      status: 'SUCCEEDED',
      authControl: { ...authControl, token: 'wrong-token' },
    }),
  ).toBe(false)
  expect((await getSessionOperation(h.db, claim.operation.id))?.status).toBe('WAITING_FOR_AUTH')
  expect(
    await finishSessionOperation(h.db, {
      operationId: claim.operation.id,
      workerId,
      workerInstanceId: instanceId,
      status: 'SUCCEEDED',
      authControl,
    }),
  ).toBe(true)
  const { getSessionById, findActiveLeaseRow } = await import('../test-entry.js')
  expect((await getSessionById(h.db, claim.session!.id))?.authControlActorId).toBeNull()
  expect(await findActiveLeaseRow(h.db, claim.session!.id)).toBeNull()
})

it('终态前的后台维护跨窗口复用同一操作', async () => {
  const s = await idle()
  const body = { kind: 'VERIFY_AUTH' as const, expectedSessionId: s.id, expectedGeneration: s.generation }
  const first = await requestMaintenanceOperation(h.db, {
    key,
    body: { ...body, idempotencyKey: 'bg-verify:account:1' },
    origin: 'BACKGROUND',
  })
  const second = await requestMaintenanceOperation(h.db, {
    key,
    body: { ...body, idempotencyKey: 'bg-verify:account:2' },
    origin: 'BACKGROUND',
  })
  expect(second.operation?.id).toBe(first.operation?.id)
  expect(second.created).toBe(false)
})
