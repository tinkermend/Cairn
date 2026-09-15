import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { forceGrantForRun } from './lease-harness.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import {
  DomainError,
  acquireSessionLease,
  createRunWithSnapshot,
  createScenarioWithVersion,
  enterRunWaitingForAuth,
  eq,
  forceLeaseExpiresAt,
  getSessionById,
  getWorkerById,
  getWorkerDetail,
  heartbeatWorker,
  isolateOrphanedSessions,
  listSessions,
  listWorkers,
  markLostWorkers,
  markWorkerDraining,
  markWorkerStopped,
  registerWorker,
  requireCreatedSession,
  resolveWorkerRoute,
  setSessionStatus,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
import { targetAccounts as pg_targetAccounts, targets as pg_targets } from '../schema/targets.js'
import { workers as pg_workers } from '../schema/worker.js'

let consoleAccounts = pg_consoleAccounts
let targetAccounts = pg_targetAccounts
let targets = pg_targets
let workers = pg_workers

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000091',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

const fleetOptions = {
  networkMode: 'local' as const,
  envEndpoints: { 'local-worker': 'http://127.0.0.1:8091' },
  canSeeEndpoint: true,
}

describe.each(DRIVERS)('%s Worker 登记与舰队', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let accountId: string
  let accountId2: string
  let scenarioId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `wr_${Date.now().toString(36)}`)
    ;({ consoleAccounts, targetAccounts, targets, workers } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    accountId = newId()
    accountId2 = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'wr-tester',
      email: `wr-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `wr-${targetId.slice(0, 8)}`,
      name: '登记夹具',
      entryUrl: 'https://example.com',
    })
    await handle.db.insert(targetAccounts).values([
      { id: accountId, targetId, displayName: '账号甲', username: 'alice', status: 'active' },
      { id: accountId2, targetId, displayName: '账号乙', username: 'bob', status: 'active' },
    ])
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '登记账本',
      steps: [echoStep],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function makeAccount(label: string) {
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: label,
      status: 'active',
    })
    return id
  }

  async function openOwnedSession(input: {
    workerId: string
    account?: string
    instanceId?: string | null
  }) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: input.account ?? accountId },
      ownerWorkerId: input.workerId,
      ownerWorkerInstanceId: input.instanceId ?? undefined,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    return (await getSessionById(handle.db, session.id))!
  }

  it('同 ID 双开只有一方成功；到期后接管，迟到心跳/停机不能改新行', async () => {
    const workerId = `dup-${newId().slice(0, 8)}`
    const first = newId()
    const second = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: first,
      capacity: 2,
      lostAfterSeconds: 120,
      internalBaseUrl: 'http://127.0.0.1:8091',
    })
    await expect(
      registerWorker(handle.db, {
        workerId,
        instanceId: second,
        capacity: 2,
        lostAfterSeconds: 60,
        internalBaseUrl: 'http://127.0.0.1:8092',
      }),
    ).rejects.toMatchObject({ code: 'WORKER_ID_CONFLICT' })

    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(workers.id, workerId))

    const taken = await registerWorker(handle.db, {
      workerId,
      instanceId: second,
      capacity: 3,
      lostAfterSeconds: 60,
      internalBaseUrl: 'http://127.0.0.1:8093',
    })
    expect(taken.worker.instanceId).toBe(second)
    expect(taken.worker.internalBaseUrl).toBe('http://127.0.0.1:8093')
    expect(taken.worker.lostAfterSeconds).toBe(60)

    expect(await heartbeatWorker(handle.db, workerId, first)).toBe('instance_taken')
    expect(await markWorkerDraining(handle.db, workerId, first)).toBe(false)
    expect(await markWorkerStopped(handle.db, workerId, first)).toBe(false)
    expect(await heartbeatWorker(handle.db, workerId, second)).toBe('ok')
    const current = await getWorkerById(handle.db, workerId)
    expect(current?.instanceId).toBe(second)
    expect(current?.status).toBe('READY')
    expect(current?.internalBaseUrl).toBe('http://127.0.0.1:8093')
  })

  it('同代次重复登记不撤销租约；缺少期限且非 STOPPED 不得接管', async () => {
    const workerId = `same-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 1,
      lostAfterSeconds: 60,
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    await forceGrantForRun(handle, created.detail.id, workerId)
    const again = await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      lostAfterSeconds: 15,
    })
    expect(again.revokedRunIds).toEqual([])
    expect(again.worker.lostAfterSeconds).toBe(60)

    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: null, lostAfterSeconds: null })
      .where(eq(workers.id, workerId))
    const error = await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 60,
    }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('WORKER_ID_CONFLICT')
  })

  it('冻结 120 秒期限：申请者/扫描者 60 秒不能提前接管或判 LOST', async () => {
    const workerId = `ttl-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 1,
      lostAfterSeconds: 120,
    })
    await handle.db
      .update(workers)
      .set({
        heartbeatAt: new Date(Date.now() - 90_000),
        heartbeatExpiresAt: new Date(Date.now() + 30_000),
      })
      .where(eq(workers.id, workerId))

    await expect(
      registerWorker(handle.db, {
        workerId,
        instanceId: newId(),
        capacity: 1,
        lostAfterSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_ID_CONFLICT' })
    expect(await markLostWorkers(handle.db, 60)).not.toContain(workerId)
    expect(await heartbeatWorker(handle.db, workerId, instanceId)).toBe('ok')
  })

  it('到期边界：相等即过期，迟到心跳不能复活', async () => {
    const workerId = `exp-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 1,
      lostAfterSeconds: 60,
    })
    const expiredAt = new Date(Date.now() - 5)
    await handle.db.update(workers).set({ heartbeatExpiresAt: expiredAt }).where(eq(workers.id, workerId))
    expect(await heartbeatWorker(handle.db, workerId, instanceId)).toBe('lost')
    const afterLate = await getWorkerById(handle.db, workerId)
    expect(afterLate?.status).toBe('READY')
    expect(afterLate?.heartbeatExpiresAt?.getTime()).toBe(expiredAt.getTime())
    expect(await markLostWorkers(handle.db)).toContain(workerId)
    expect((await getWorkerById(handle.db, workerId))?.status).toBe('LOST')
  })

  it('存量 Session 不反填实例；接管把旧/未知未关闭会话隔离为 LOST', async () => {
    const workerId = `sess-${newId().slice(0, 8)}`
    const oldInstance = newId()
    const newInstance = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: oldInstance,
      capacity: 2,
      lostAfterSeconds: 60,
    })
    const unknown = await openOwnedSession({ workerId, account: await makeAccount('unknown') })
    const owned = await openOwnedSession({
      workerId,
      account: await makeAccount('owned'),
      instanceId: oldInstance,
    })
    expect(unknown.ownerWorkerInstanceId).toBeNull()
    expect(owned.ownerWorkerInstanceId).toBe(oldInstance)

    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(workers.id, workerId))
    await registerWorker(handle.db, {
      workerId,
      instanceId: newInstance,
      capacity: 2,
      lostAfterSeconds: 60,
    })

    const isolatedUnknown = await getSessionById(handle.db, unknown.id)
    const isolatedOwned = await getSessionById(handle.db, owned.id)
    expect(isolatedUnknown?.status).toBe('LOST')
    expect(isolatedOwned?.status).toBe('LOST')
    expect(isolatedUnknown?.ownerWorkerInstanceId).toBeNull()
    expect(isolatedOwned?.ownerWorkerInstanceId).toBe(oldInstance)
    expect(isolatedUnknown?.closeReason).toBe('owner_instance_replaced')
    expect(await isolateOrphanedSessions(handle.db, workerId, oldInstance)).toBe(0)
  })

  it('心跳按行内期限续期，并记录句柄采样连续差异', async () => {
    const workerId = `hb-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 45,
    })
    await openOwnedSession({ workerId, account: await makeAccount('hb'), instanceId })
    expect(await heartbeatWorker(handle.db, workerId, instanceId)).toBe('ok')
    const none = await getWorkerById(handle.db, workerId)
    expect(none?.liveHandleCount).toBeNull()
    expect(none?.sampledSlotCount).toBeNull()
    expect(none?.handleMismatchStreak).toBe(0)
    expect(none?.lostAfterSeconds).toBe(45)

    expect(await heartbeatWorker(handle.db, workerId, instanceId, { liveHandleCount: 0 })).toBe('ok')
    expect((await getWorkerById(handle.db, workerId))?.handleMismatchStreak).toBe(1)
    expect(await heartbeatWorker(handle.db, workerId, instanceId, { liveHandleCount: 0 })).toBe('ok')
    const persistent = await getWorkerById(handle.db, workerId)
    expect(persistent?.handleMismatchStreak).toBe(2)
    expect(persistent?.sampledSlotCount).toBe(1)
    expect(await heartbeatWorker(handle.db, workerId, instanceId, { liveHandleCount: 1 })).toBe('ok')
    expect((await getWorkerById(handle.db, workerId))?.handleMismatchStreak).toBe(0)
  })

  it('列表含四值状态，分页后详情计数不随 Session 页变化；过期租约不算执行中', async () => {
    const stamp = `wrlist-${newId().slice(0, 8)}`
    const readyId = `a-ready-${stamp}`
    const drainingId = `b-drain-${stamp}`
    const stoppedId = `c-stop-${stamp}`
    const lostId = `d-lost-${stamp}`
    const readyInstance = newId()
    await registerWorker(handle.db, {
      workerId: readyId,
      instanceId: readyInstance,
      capacity: 1,
      lostAfterSeconds: 60,
      internalBaseUrl: 'http://127.0.0.1:8091',
    })
    for (const workerId of [drainingId, stoppedId, lostId]) {
      await registerWorker(handle.db, {
        workerId,
        instanceId: newId(),
        capacity: 1,
        lostAfterSeconds: 60,
      })
    }
    expect(await markWorkerDraining(handle.db, drainingId, (await getWorkerById(handle.db, drainingId))!.instanceId)).toBe(
      true,
    )
    expect(await markWorkerStopped(handle.db, stoppedId, (await getWorkerById(handle.db, stoppedId))!.instanceId)).toBe(
      true,
    )
    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(workers.id, lostId))
    expect(await markLostWorkers(handle.db)).toContain(lostId)

    const slotAccount = await makeAccount('slot')
    const session = await openOwnedSession({
      workerId: readyId,
      account: slotAccount,
      instanceId: readyInstance,
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: slotAccount,
      actor: { id: actorId },
    })
    const lease = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: created.detail.id,
      holderWorkerId: readyId,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    expect(lease.ok).toBe(true)
    if (lease.ok) await forceLeaseExpiresAt(handle.db, lease.lease.id, new Date(Date.now() - 1000))

    const listed = await listWorkers(
      handle.db,
      { limit: 2, search: stamp },
      { ...fleetOptions, envEndpoints: { [readyId]: 'http://127.0.0.1:8099' } },
    )
    expect(listed.items.map((item) => item.status)).toEqual(['READY', 'DRAINING'])
    expect(listed.nextCursor).toBeTruthy()
    const rest = await listWorkers(
      handle.db,
      { limit: 10, search: stamp, cursor: listed.nextCursor },
      fleetOptions,
    )
    expect(rest.items.map((item) => item.status)).toEqual(['STOPPED', 'LOST'])
    expect(rest.items.find((item) => item.status === 'STOPPED')?.heartbeatFresh).toBe(true)

    const ready = listed.items[0]!
    expect(ready.counts.occupiedSlots).toBe(1)
    expect(ready.counts.expiredLeaseResidue).toBe(1)
    expect(ready.counts.executingSlots).toBe(0)
    expect(ready.routeAvailability).toBe('eligible')
    expect(ready.endpointSource).toBe('database')
    expect(ready.internalEndpoint?.baseUrl).toBe('http://127.0.0.1:8091')

    const expiredReady = await listWorkers(
      handle.db,
      { status: 'LOST', search: stamp },
      { ...fleetOptions, envEndpoints: { [lostId]: 'http://127.0.0.1:8091' } },
    )
    expect(expiredReady.items[0]?.routeAvailability).toBe('unavailable')
    expect(expiredReady.items[0]?.endpointSource).toBe('none')

    const invalid = await registerWorker(handle.db, {
      workerId: `bad-${stamp}`,
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 60,
      internalBaseUrl: 'http://worker.example:8091',
    })
    const invalidList = await listWorkers(
      handle.db,
      { search: invalid.worker.id },
      { ...fleetOptions, envEndpoints: { [invalid.worker.id]: 'http://127.0.0.1:8091' } },
    )
    expect(invalidList.items[0]).toMatchObject({
      routeReason: 'endpoint_invalid',
      endpointSource: 'none',
      internalEndpoint: null,
    })

    const detail = await getWorkerDetail(handle.db, readyId, { limit: 1 }, fleetOptions)
    expect(detail.worker.counts.occupiedSlots).toBe(1)
    expect(detail.sessions.items).toHaveLength(1)
    const filtered = await getWorkerDetail(handle.db, readyId, { limit: 1, status: 'CLOSED' }, fleetOptions)
    expect(filtered.worker.counts.occupiedSlots).toBe(1)
    expect(filtered.sessions.items).toHaveLength(0)
    expect((await listSessions(handle.db, { ownerWorkerId: readyId })).map((item) => item.id)).toEqual([
      session.id,
    ])
  })

  it('查表过期租约/hold 仍能读到 Session，但不能当作可转发关联', async () => {
    const workerId = `route-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 1,
      lostAfterSeconds: 60,
    })
    const session = await openOwnedSession({ workerId, instanceId })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const lease = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: created.detail.id,
      holderWorkerId: workerId,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })
    expect(lease.ok).toBe(true)
    const live = await resolveWorkerRoute(handle.db, created.detail.id)
    expect(live.associationLive).toBe(true)
    expect(live.session?.id).toBe(session.id)

    if (lease.ok) await forceLeaseExpiresAt(handle.db, lease.lease.id, new Date(Date.now() - 1000))
    const staleLease = await resolveWorkerRoute(handle.db, created.detail.id)
    expect(staleLease.associationLive).toBe(false)
    expect(staleLease.session?.id).toBe(session.id)

    const waiting = await createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, waiting.detail.id, workerId)
    const heldSession = await openOwnedSession({ workerId, account: await makeAccount('hold'), instanceId })
    expect(
      await enterRunWaitingForAuth(handle.db, {
        grant,
        sessionId: heldSession.id,
        workerId,
        workerInstanceId: instanceId,
        holdSeconds: 30,
      }),
    ).toBe(true)
    const held = await resolveWorkerRoute(handle.db, waiting.detail.id)
    expect(held.associationLive).toBe(true)
    expect(held.session?.id).toBe(heldSession.id)
    expect(held.runStatus).toBe('WAITING_FOR_AUTH')

    const { browserSessions } = schemaFor(handle.db)
    await handle.db
      .update(browserSessions)
      .set({ authHoldExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(browserSessions.id, heldSession.id))
    const staleHold = await resolveWorkerRoute(handle.db, waiting.detail.id)
    expect(staleHold.associationLive).toBe(false)
    expect(staleHold.session?.id).toBe(heldSession.id)
  })
})
