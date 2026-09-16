import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_MAINTENANCE_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { enterAuthWaitForRun, forceGrantForRun, seedWorker } from './lease-harness.js'
import {
  appendSessionEvent,
  claimSessionOperation,
  createRunWithSnapshot,
  createScenarioWithVersion,
  cancelSessionOperation,
  DomainError,
  findEvictableSession,
  listAccountSessionOverview,
  listSessionEventsAfter,
  registerWorker,
  requestMaintenanceOperation,
  setSessionRetention,
  setSessionStatus,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 会话维护账本', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `mnt_${Date.now().toString(36)}`)
    const { consoleAccounts, targets, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'maintenance',
      email: `mnt-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `mnt-${targetId.slice(0, 8)}`,
      name: '维护夹具',
      entryUrl: 'https://example.com',
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function makeAccount(label: string): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}`,
      status: 'active',
    })
    return id
  }

  it.each(['expiresAt', 'waitDeadlineAt'] as const)('独立认证完成与 %s 回收并发，不死锁也不写迟到成功', async field => {
    const { transitionSessionUse, markSessionOperationWaitingForAuth, acquireAuthControl, findAuthWaitLeaseForOperation, finishSessionOperation, reapSessionLeases, getSessionOperation, getSessionById } = await import('../test-entry.js')
    const accountId = await makeAccount(`race-${field}`)
    const workerId = `race-${newId()}`, instanceId = newId()
    await registerWorker(handle.db, { workerId, instanceId, capacity: 4, lostAfterSeconds: 60, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL] })
    const op = await requestMaintenanceOperation(handle.db, { key: { targetId, targetAccountId: accountId }, body: { kind: 'PREPARE', idempotencyKey: newId() }, actor: { id: actorId } })
    const operation = op.operation
    if (!operation) throw new Error('maintenance operation was not created')
    const claim = (await claimSessionOperation(handle.db, { workerId, instanceId, leaseTtlSeconds: 60 }))!
    expect(claim.operation.id).toBe(operation.id)
    const session = claim.session!
    await setSessionStatus(handle.db, { sessionId: session.id, expectedVersion: session.version, status: 'OPEN', ownerWorkerId: workerId, ownerWorkerInstanceId: instanceId })
    await transitionSessionUse(handle.db, { sessionId: session.id, fromPurpose: 'MAINTENANCE', toPurpose: 'AUTH_WAIT', owner: { kind: 'SESSION_OPERATION', operationId: operation.id }, holderWorkerId: workerId, holderInstanceId: instanceId, leaseTtlSeconds: 60, waitSeconds: 600 })
    await markSessionOperationWaitingForAuth(handle.db, { operationId: operation.id, workerId })
    const control = await acquireAuthControl(handle.db, { sessionId: session.id, runId: operation.id, actor: { id: actorId }, workerId, workerInstanceId: instanceId, sessionGeneration: session.generation })
    const { sessionLeases } = schemaFor(handle.db)
    const lease = (await findAuthWaitLeaseForOperation(handle.db, operation.id))!
    await handle.db.update(sessionLeases).set({ [field]: new Date(0) }).where(eq(sessionLeases.id, lease.id))
    const complete = () => finishSessionOperation(handle.db, { operationId: operation.id, workerId, workerInstanceId: instanceId, status: 'SUCCEEDED', authControl: { sessionId: session.id, actorId, generation: session.generation, epoch: control.epoch, token: control.token } })
    // A late completion must be rejected even before the reaper runs.
    expect(await complete()).toBe(false)
    const [finished] = await Promise.all([
      complete(),
      reapSessionLeases(handle.db),
    ])
    expect(finished).toBe(false)
    expect((await getSessionOperation(handle.db, operation.id))?.status).toBe('FAILED')
    expect(await findAuthWaitLeaseForOperation(handle.db, operation.id)).toBeNull()
    expect((await getSessionById(handle.db, session.id))?.authControlActorId).toBeNull()
  })

  it('总览包含未准备账号，CLOSE 不得创建会话', async () => {
    const accountId = await makeAccount('unprepared')
    const overview = await listAccountSessionOverview(handle.db, {})
    expect(overview.items.some((item) => item.targetAccountId === accountId && item.status === 'unprepared')).toBe(true)
    await expect(
      requestMaintenanceOperation(handle.db, {
        key: { targetId, targetAccountId: accountId },
        body: { kind: 'CLOSE', idempotencyKey: `close-${accountId}-xxxxxxxx` },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_CLAIMABLE' })
  })

  it('维护占用时拒绝新操作；空闲 OPEN 才能设置保留并跳过回收', async () => {
    const accountId = await makeAccount('retain')
    const workerId = `worker-${newId()}`
    const instanceId = newId()
    const worker = { workerId, instanceId }
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      maxSessions: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: `prep-${accountId}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const claimed = await claimSessionOperation(handle.db, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 60,
    })
    expect(claimed?.grant).toBeTruthy()
    expect(claimed?.session).toBeTruthy()
    if (!claimed?.grant || !claimed.session) return
    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    await expect(
      requestMaintenanceOperation(handle.db, {
        key: { targetId, targetAccountId: accountId },
        body: { kind: 'VERIFY_AUTH', idempotencyKey: `busy-${accountId}-xxxxxxxx` },
        actor: { id: actorId },
      }),
    ).rejects.toBeInstanceOf(DomainError)

    const { sessionLeases } = schemaFor(handle.db)
    await handle.db.delete(sessionLeases).where(eq(sessionLeases.sessionId, claimed.session.id))
    const retained = await setSessionRetention(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { action: 'set', retainSeconds: 600, reason: '联调' },
      actor: { id: actorId },
    })
    expect(retained.retainUntil).toBeTruthy()
    expect(await findEvictableSession(handle.db, worker.workerId, worker.instanceId)).toBeNull()
  })

  it('旧 Worker 不领取维护 kind', async () => {
    const accountId = await makeAccount('old-worker')
    const worker = await seedWorker(handle)
    const queued = await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: `prep-${accountId}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const claimed = await claimSessionOperation(handle.db, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(claimed).toBeNull()
    if (queued.operation) await cancelSessionOperation(handle.db, { operationId: queued.operation.id })
  })

  it('LOGIN 复用 Run AUTH_WAIT，操作账本关联原 Run', async () => {
    const accountId = await makeAccount('login-reuse')
    const worker = await seedWorker(handle)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `mnt-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 600,
    })
    const { findLiveSession } = await import('../test-entry.js')
    const current = await findLiveSession(handle.db, { targetId, targetAccountId: accountId })
    const reused = await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'LOGIN', idempotencyKey: `login-${accountId}-xxxxxxxx`, expectedSessionId: current!.id, expectedGeneration: current!.generation },
      actor: { id: actorId },
    })
    expect(reused.operation?.kindParams?.reusedRunId).toBe(created.detail.id)
    expect(reused.reusedRunId).toBe(created.detail.id)
  })

  it('RESET 在无活实例时可提交', async () => {
    const accountId = await makeAccount('reset-only')
    const reset = await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: {
        kind: 'RESET_PROFILE',
        idempotencyKey: `reset-${accountId}-xxxxxxxx`,
        confirmAccountId: accountId,
      },
      actor: { id: actorId },
    })
    expect(reset.created).toBe(true)
    expect(reset.operation?.kind).toBe('RESET_PROFILE')
    if (reset.operation) await cancelSessionOperation(handle.db, { operationId: reset.operation.id })
  })

  it('节点保留配额为 0 时拒绝设置保留', async () => {
    const accountId = await makeAccount('quota')
    const workerId = `worker-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      maxSessions: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: `prep-${accountId}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const claimed = await claimSessionOperation(handle.db, {
      workerId,
      instanceId,
      leaseTtlSeconds: 60,
    })
    expect(claimed?.session).toBeTruthy()
    if (!claimed?.session) return
    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    const { sessionLeases } = schemaFor(handle.db)
    await handle.db.delete(sessionLeases).where(eq(sessionLeases.sessionId, claimed.session.id))
    await expect(
      setSessionRetention(handle.db, {
        key: { targetId, targetAccountId: accountId },
        body: { action: 'set', retainSeconds: 600, reason: '配额' },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'RETENTION_QUOTA_EXCEEDED' })
  })

  it('后台维护幂等键同窗口复用原操作', async () => {
    const accountId = await makeAccount('bg-window')
    const first = await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'VERIFY_AUTH', idempotencyKey: 'bg-verify:acc:6' },
      origin: 'BACKGROUND',
    })
    const second = await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'VERIFY_AUTH', idempotencyKey: 'bg-verify:acc:6' },
      origin: 'BACKGROUND',
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.operation?.id).toBe(first.operation?.id)
  })

  it('SSE 游标按同账号序号返回并发事件', async () => {
    const accountId = await makeAccount('event-sequence')
    const key = { targetId, targetAccountId: accountId }
    await Promise.all(
      Array.from({ length: 8 }, () => appendSessionEvent(handle.db, { key, type: 'operation.requested' })),
    )
    const events = await listSessionEventsAfter(handle.db, { key, afterSeq: 0 })
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: 8 }, (_, index) => index + 1))
  })
})
