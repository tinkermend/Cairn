import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb, grantAdminScope } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'
import { TargetsStore } from '../console/targets.js'
import {
  claimRun,
  claimSessionOperation,
  claimSessionUse,
  computeRunPlacement,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSession,
  expose,
  findLiveSessions,
  getAccountSessionDetail,
  getSessionById,
  markWorkerDraining,
  recreateSessionForOperation,
  registerWorker,
  releaseSessionUse,
  requestMaintenanceOperation,
  setSessionStatus,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c2',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 同账号多独立会话', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `accs_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'account-concurrency',
      email: `accs-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)
    await handle.db.insert(targets).values({
      id: targetId,
      code: `accs-${targetId.slice(0, 8)}`,
      name: '并发夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  afterEach(async () => {
    const { runs, browserSessions, sessionLeases, targets } = schemaFor(handle.db)
    await handle.db.update(sessionLeases).set({ status: 'RELEASED', releasedAt: new Date() })
    await handle.db.update(browserSessions).set({ status: 'CLOSED', closedAt: new Date(), closeReason: 'cleanup' })
    await handle.db.update(runs).set({ status: 'CANCELLED', finishedAt: new Date() })
    await handle.db.update(targets).set({ sessionPolicy: null }).where(eq(targets.id, targetId))
  })

  async function makeAccount(label: string, maxConcurrentSessions = 1): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}`,
      status: 'active',
      maxConcurrentSessions,
    })
    return id
  }

  async function enableConcurrent() {
    const { targets } = schemaFor(handle.db)
    await handle.db.update(targets).set({ sessionPolicy: { accountSessionMode: 'concurrent' } }).where(eq(targets.id, targetId))
  }

  async function seedConcurrentWorker(suffix: string) {
    const workerId = `accs-${suffix}-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      maxSessions: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [
        SESSION_OCCUPANCY_PROTOCOL,
        SESSION_ACCOUNT_CONCURRENCY_PROTOCOL,
        SESSION_MAINTENANCE_PROTOCOL,
      ],
    })
    return { workerId, instanceId }
  }

  async function queueRun(accountId: string) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `accs-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
  }

  async function claimExecution(accountId: string, worker: { workerId: string; instanceId: string }) {
    const created = await queueRun(accountId)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: worker.workerId,
      holderInstanceId: worker.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    return { created, grant, claimed }
  }

  it('AC01 exclusive 同槽第二条活行插不进去，第二 Run 等待占用', async () => {
    const accountId = await makeAccount('ac01')
    const worker = await seedWorker(handle, `ac01-${newId().slice(0, 8)}`)
    const first = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(first.ok).toBe(true)
    await expect(
      createSession(handle.db, {
        key: { targetId, targetAccountId: accountId },
        ownerWorkerId: worker.workerId,
        ownerWorkerInstanceId: worker.instanceId,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    const runAccount = await makeAccount('ac01-run')
    const run = await claimExecution(runAccount, worker)
    expect(run.claimed.ok).toBe(true)
    const waiting = await queueRun(runAccount)
    const placement = await computeRunPlacement(handle.db, {
      status: waiting.detail.status,
      createdAt: new Date(waiting.detail.createdAt),
      targetId,
      targetAccountId: runAccount,
      hasActiveLease: false,
    })
    expect(placement.waitReason).toBe('SESSION_IN_USE_BY_RUN')
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: runAccount })
    expect(detail.instances).toHaveLength(1)
    expect(detail.session?.id).toBe(detail.instances[0]?.id)
    expect(detail.effectiveCap).toBe(1)
  })

  it('AC02 concurrent cap=3 三 Run 三会话，第四条达上限', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac02', 3)
    const worker = await seedConcurrentWorker('ac02')
    const claimed = []
    for (let i = 0; i < 3; i += 1) {
      claimed.push(await claimExecution(accountId, worker))
      expect(claimed[i]!.claimed.ok).toBe(true)
    }
    const sessions = claimed.map((item) => (item.claimed.ok ? item.claimed.session : null))
    const ids = new Set(sessions.map((row) => row?.id))
    const slots = new Set(sessions.map((row) => row?.accountSlot))
    const keys = new Set(sessions.map((row) => row?.profileKey))
    expect(ids.size).toBe(3)
    expect(slots).toEqual(new Set([1, 2, 3]))
    expect(keys.size).toBe(3)
    expect([...keys].some((key) => key?.endsWith('/2'))).toBe(true)

    const fourth = await queueRun(accountId)
    const placement = await computeRunPlacement(handle.db, {
      status: fourth.detail.status,
      createdAt: new Date(fourth.detail.createdAt),
      targetId,
      targetAccountId: accountId,
      hasActiveLease: false,
    })
    expect(placement.waitReason).toBe('SESSION_ACCOUNT_AT_CAPACITY')
    const extra = await claimExecution(accountId, worker)
    expect(extra.claimed.ok).toBe(false)
    if (!extra.claimed.ok) expect(extra.claimed.code).toBe('SESSION_BUSY')
  })

  it('AC03 本节点空闲 OPEN 必须复用', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac03', 3)
    const worker = await seedConcurrentWorker('ac03')
    const first = await claimExecution(accountId, worker)
    expect(first.claimed.ok).toBe(true)
    if (!first.claimed.ok) return
    await setSessionStatus(handle.db, {
      sessionId: first.claimed.session.id,
      expectedVersion: first.claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    await releaseSessionUse(handle.db, {
      leaseId: first.claimed.grant.leaseId,
      holderWorkerId: worker.workerId,
      reason: 'idle',
    })
    const second = await claimExecution(accountId, worker)
    expect(second.claimed.ok).toBe(true)
    if (!second.claimed.ok) return
    expect(second.claimed.session.id).toBe(first.claimed.session.id)
    expect(second.claimed.created).toBe(false)
    expect(await findLiveSessions(handle.db, { targetId, targetAccountId: accountId })).toHaveLength(1)
  })

  it('AC04 他节点空闲且能领时本节点不得新建', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac04', 3)
    const owner = await seedConcurrentWorker('ac04a')
    const other = await seedConcurrentWorker('ac04b')
    const first = await claimExecution(accountId, owner)
    expect(first.claimed.ok).toBe(true)
    if (!first.claimed.ok) return
    await setSessionStatus(handle.db, {
      sessionId: first.claimed.session.id,
      expectedVersion: first.claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: owner.workerId,
      ownerWorkerInstanceId: owner.instanceId,
    })
    await releaseSessionUse(handle.db, {
      leaseId: first.claimed.grant.leaseId,
      holderWorkerId: owner.workerId,
      reason: 'idle',
    })
    const second = await claimExecution(accountId, other)
    expect(second.claimed.ok).toBe(false)
    if (!second.claimed.ok) expect(second.claimed.code).toBe('SESSION_BUSY')
    expect(await findLiveSessions(handle.db, { targetId, targetAccountId: accountId })).toHaveLength(1)
  })

  it('AC04b 他节点空闲但 DRAINING 时合格节点可新建', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac04b', 3)
    const owner = await seedConcurrentWorker('ac04b-a')
    const other = await seedConcurrentWorker('ac04b-b')
    const first = await claimExecution(accountId, owner)
    expect(first.claimed.ok).toBe(true)
    if (!first.claimed.ok) return
    await setSessionStatus(handle.db, {
      sessionId: first.claimed.session.id,
      expectedVersion: first.claimed.session.version,
      status: 'OPEN',
      ownerWorkerId: owner.workerId,
      ownerWorkerInstanceId: owner.instanceId,
    })
    await releaseSessionUse(handle.db, {
      leaseId: first.claimed.grant.leaseId,
      holderWorkerId: owner.workerId,
      reason: 'idle',
    })
    await markWorkerDraining(handle.db, owner.workerId, owner.instanceId)
    const second = await claimExecution(accountId, other)
    expect(second.claimed.ok).toBe(true)
    if (!second.claimed.ok) return
    expect(second.claimed.session.id).not.toBe(first.claimed.session.id)
    expect(second.claimed.created).toBe(true)
  })

  it('AC12 多会话 CLOSE 必须指定 sessionId，指定后只关那一台', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac12', 3)
    const worker = await seedConcurrentWorker('ac12')
    const first = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 1,
    })
    const second = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 2,
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    await setSessionStatus(handle.db, {
      sessionId: first.session.id,
      expectedVersion: first.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    await setSessionStatus(handle.db, {
      sessionId: second.session.id,
      expectedVersion: second.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    await expect(
      requestMaintenanceOperation(handle.db, {
        key: { targetId, targetAccountId: accountId },
        body: { kind: 'CLOSE', idempotencyKey: `close-all-${accountId}-xxxxxxxx` },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'SESSION_INSTANCE_REQUIRED' })

    const opened = await findLiveSessions(handle.db, { targetId, targetAccountId: accountId })
    const target = opened.find((row) => row.id === first.session.id)!
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: {
        kind: 'CLOSE',
        idempotencyKey: `close-one-${accountId}-xxxxxxxx`,
        expectedSessionId: target.id,
        expectedGeneration: target.generation,
      },
      actor: { id: actorId },
    })
    const stillLive = await findLiveSessions(handle.db, { targetId, targetAccountId: accountId })
    expect(stillLive.some((row) => row.id === second.session.id)).toBe(true)
    const otherRun = await claimExecution(accountId, worker)
    expect(otherRun.claimed.ok).toBe(true)
  })

  it('AC14 未声明并发协议时 cap>1 不领，cap=1 仍领', async () => {
    await enableConcurrent()
    const multi = await makeAccount('ac14-multi', 3)
    const single = await makeAccount('ac14-single', 1)
    const old = await seedWorker(handle, `ac14-old-${newId().slice(0, 8)}`)
    const queuedMulti = await queueRun(multi)
    expect(
      await claimRun(handle, {
        workerId: old.workerId,
        instanceId: old.instanceId,
        leaseTtlSeconds: 30,
      }),
    ).toBeNull()
    const queuedSingle = await queueRun(single)
    const grant = await claimRun(handle, {
      workerId: old.workerId,
      instanceId: old.instanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(queuedSingle.detail.id)
    expect(grant?.runId).not.toBe(queuedMulti.detail.id)
  })

  it('AC17 详情以 instances[] 为事实，生产读取不再假设单行', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac17', 3)
    const worker = await seedConcurrentWorker('ac17')
    await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 1,
    })
    await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 2,
    })
    const lives = await findLiveSessions(handle.db, { targetId, targetAccountId: accountId })
    expect(lives).toHaveLength(2)
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: accountId })
    expect(detail.instances).toHaveLength(2)
    expect(detail.session).toBeNull()
    expect(detail.liveCount).toBe(2)
    expect(detail.effectiveCap).toBe(3)
  })

  it('exclusive 写入 cap>1 被拒，concurrent 可写', async () => {
    const store = new TargetsStore(expose(handle), () => Buffer.from('secret'))
    const actor = {
      id: actorId,
      displayName: 'account-concurrency',
      email: `accs-${actorId}@example.com`,
      status: 'active' as const,
      roles: [],
      permissions: [],
    }
    await expect(
      store.createAccount(
        targetId,
        { displayName: '独占超限', username: `cap-ex-${newId().slice(0, 8)}`, maxConcurrentSessions: 3 },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'SESSION_CONCURRENCY_UNSUPPORTED' })
    await enableConcurrent()
    const created = await store.createAccount(
      targetId,
      { displayName: '并发账号', username: `cap-ok-${newId().slice(0, 8)}`, maxConcurrentSessions: 3 },
      actor,
    )
    expect(created.maxConcurrentSessions).toBe(3)
    expect(created.effectiveMaxConcurrentSessions).toBe(3)
  })

  it('AC18 RESTART slot=2 新行仍是同一槽和盘键', async () => {
    await enableConcurrent()
    const accountId = await makeAccount('ac18', 3)
    const worker = await seedConcurrentWorker('ac18')
    const first = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 1,
    })
    const second = await createSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      accountSlot: 2,
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    await setSessionStatus(handle.db, {
      sessionId: first.session.id,
      expectedVersion: first.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    await setSessionStatus(handle.db, {
      sessionId: second.session.id,
      expectedVersion: second.session.version,
      status: 'OPEN',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    const live = (await getSessionById(handle.db, second.session.id))!
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: {
        kind: 'RESTART',
        idempotencyKey: `restart-slot2-${accountId}-xxxxxxxx`,
        expectedSessionId: live.id,
        expectedGeneration: live.generation,
      },
      actor: { id: actorId },
    })
    const claim = await claimSessionOperation(handle.db, {
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      leaseTtlSeconds: 60,
    })
    expect(claim?.operation.kind).toBe('RESTART')
    const closing = (await getSessionById(handle.db, live.id))!
    await setSessionStatus(handle.db, {
      sessionId: live.id,
      expectedVersion: closing.version,
      status: 'CLOSED',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    const created = await recreateSessionForOperation(handle.db, {
      operationId: claim!.operation.id,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.session.accountSlot).toBe(2)
    expect(created.session.profileKey).toBe(second.session.profileKey)
    expect(created.session.predecessorSessionId).toBe(second.session.id)
  })
})
