import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_MAINTENANCE_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  cancelSessionOperation,
  claimSessionOperation,
  getAccountSessionDetail,
  getSessionOperation,
  getSessionOperationView,
  listSessionEventsAfter,
  registerWorker,
  requestMaintenanceOperation,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 会话操作排队可解释性', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `opq_${Date.now().toString(36)}`)
    const { consoleAccounts, targets, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'queue',
      email: `opq-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    await handle.db
      .insert(consoleAccountRoles)
      .values({ consoleAccountId: actorId, consoleRoleId: admin.id, targetScopeMode: 'all', targetScopeIds: [] })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `opq-${targetId.slice(0, 8)}`,
      name: '排队夹具',
      entryUrl: 'https://example.com',
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  // 每条用例自己决定有哪些在线节点。
  beforeEach(async () => {
    const { workers } = schemaFor(handle.db)
    await handle.db.update(workers).set({ status: 'STOPPED', stoppedAt: new Date() })
  })

  async function makeAccount(label: string): Promise<string> {
    const { targetAccounts } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `u-${label}-${id.slice(0, 6)}`,
      status: 'active',
    })
    return id
  }

  async function onlineWorker(input: { maxSessions?: number; protocols?: string[] } = {}) {
    const workerId = `opq-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      maxSessions: input.maxSessions ?? 4,
      lostAfterSeconds: 60,
      protocolCapabilities: input.protocols ?? [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    return { workerId, instanceId }
  }

  function prepare(accountId: string) {
    return requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: newId() },
      actor: { id: actorId },
    })
  }

  async function expireDeadline(operationId: string) {
    const { sessionOperations } = schemaFor(handle.db)
    await handle.db
      .update(sessionOperations)
      .set({ queueDeadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(sessionOperations.id, operationId))
  }

  async function eventsOf(accountId: string, operationId: string) {
    const events = await listSessionEventsAfter(handle.db, {
      key: { targetId, targetAccountId: accountId },
      afterSeq: 0,
    })
    return events.filter((event) => event.operationId === operationId)
  }

  it('没有在线节点时受理并记 NO_ELIGIBLE_WORKER，协议不符记 WORKER_PROTOCOL_MISSING', async () => {
    const none = await makeAccount('no-worker')
    const accepted = await prepare(none)
    expect(accepted.eligibleWorkers).toBe(0)
    expect(accepted.operation).toMatchObject({ status: 'QUEUED', waitReason: 'NO_ELIGIBLE_WORKER' })
    const waiting = (await eventsOf(none, accepted.operation!.id)).filter((e) => e.type === 'operation.queue_waiting')
    expect(waiting.map((e) => e.payload.waitReason)).toEqual(['NO_ELIGIBLE_WORKER'])
    expect((await getSessionOperationView(handle.db, accepted.operation!.id))?.waitReason).toBe('NO_ELIGIBLE_WORKER')

    await onlineWorker({ protocols: [SESSION_OCCUPANCY_PROTOCOL] })
    const legacy = await makeAccount('legacy-worker')
    const onLegacy = await prepare(legacy)
    expect(onLegacy.eligibleWorkers).toBe(0)
    expect(onLegacy.operation?.waitReason).toBe('WORKER_PROTOCOL_MISSING')
    // 节点回来以后，读时不再沿用受理时的「无节点」。
    await onlineWorker()
    expect((await getSessionOperationView(handle.db, accepted.operation!.id))?.waitReason).toBe('AWAITING_CLAIM')
    for (const op of [accepted.operation!, onLegacy.operation!]) {
      await cancelSessionOperation(handle.db, { operationId: op.id })
    }
  })

  it('心跳过期的 READY 节点不算在线', async () => {
    const worker = await onlineWorker()
    const { workers } = schemaFor(handle.db)
    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workers.id, worker.workerId))
    const accountId = await makeAccount('stale-heartbeat')
    const accepted = await prepare(accountId)
    expect(accepted.eligibleWorkers).toBe(0)
    await cancelSessionOperation(handle.db, { operationId: accepted.operation!.id })
  })

  it('没有 Worker 时过期排队不挡住重新发起，也不算维护中', async () => {
    const accountId = await makeAccount('expired')
    const key = { targetId, targetAccountId: accountId }
    const first = (await prepare(accountId)).operation!
    expect((await getAccountSessionDetail(handle.db, key)).status).toBe('maintenance')
    await expireDeadline(first.id)

    // 读路径只推导：过期未清理的排队不再是活动操作。
    const detail = await getAccountSessionDetail(handle.db, key)
    expect(detail.status).toBe('unprepared')
    expect(detail.currentOperation).toBeNull()
    expect((await getSessionOperation(handle.db, first.id))?.status).toBe('QUEUED')

    // 重新发起时在账号锁内收掉旧排队。
    const second = await prepare(accountId)
    expect(second.created).toBe(true)
    expect(await getSessionOperation(handle.db, first.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'OPERATION_QUEUE_EXPIRED',
    })
    const finished = (await eventsOf(accountId, first.id)).filter((e) => e.type === 'operation.finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]?.payload).toMatchObject({ kind: 'PREPARE', status: 'FAILED', errorCode: 'OPERATION_QUEUE_EXPIRED' })
    await cancelSessionOperation(handle.db, { operationId: second.operation!.id })
  })

  it('取消已过期的排队返回过期终态', async () => {
    const accountId = await makeAccount('cancel-expired')
    const op = (await prepare(accountId)).operation!
    await expireDeadline(op.id)
    const settled = await cancelSessionOperation(handle.db, { operationId: op.id, actor: { id: actorId } })
    expect(settled).toMatchObject({ status: 'FAILED', errorCode: 'OPERATION_QUEUE_EXPIRED' })
  })

  it('Worker 领取与受理并发过期同一操作，只有一个终态事件', async () => {
    const accountId = await makeAccount('race-expire')
    const op = (await prepare(accountId)).operation!
    await expireDeadline(op.id)
    const worker = await onlineWorker()
    await Promise.all([
      claimSessionOperation(handle.db, { ...worker, leaseTtlSeconds: 30 }),
      prepare(accountId),
    ])
    const finished = (await eventsOf(accountId, op.id)).filter((e) => e.type === 'operation.finished')
    expect(finished).toHaveLength(1)
    const { sessionOperations } = schemaFor(handle.db)
    const queued = await handle.db
      .select()
      .from(sessionOperations)
      .where(eq(sessionOperations.targetAccountId, accountId))
    for (const row of queued.filter((r) => r.status === 'QUEUED')) {
      await cancelSessionOperation(handle.db, { operationId: row.id })
    }
  })

  it('节点会话满时退回排队并记原因与上下文，原因不变不重复落事件', async () => {
    const worker = await onlineWorker({ maxSessions: 1 })
    const first = await makeAccount('cap-first')
    const firstOp = (await prepare(first)).operation!
    const claimed = await claimSessionOperation(handle.db, { ...worker, leaseTtlSeconds: 60 })
    expect(claimed?.operation.id).toBe(firstOp.id)

    const second = await makeAccount('cap-second')
    const secondOp = (await prepare(second)).operation!
    expect(secondOp.waitReason).toBeNull()
    expect(await claimSessionOperation(handle.db, { ...worker, leaseTtlSeconds: 60 })).toBeNull()
    const row = await getSessionOperation(handle.db, secondOp.id)
    expect(row).toMatchObject({ status: 'QUEUED', attemptNo: 0, waitReason: 'WORKER_SESSION_CAPACITY' })
    expect(row?.waitDetail).toMatchObject({ workerId: worker.workerId, occupied: 1, maxSessions: 1 })
    expect(row?.lastClaimAttemptAt).toBeInstanceOf(Date)

    await claimSessionOperation(handle.db, { ...worker, leaseTtlSeconds: 60 })
    const waiting = (await eventsOf(second, secondOp.id)).filter((e) => e.type === 'operation.queue_waiting')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.payload).toMatchObject({ kind: 'PREPARE', waitReason: 'WORKER_SESSION_CAPACITY' })

    const view = await getSessionOperationView(handle.db, secondOp.id)
    expect(view).toMatchObject({ waitReason: 'WORKER_SESSION_CAPACITY', queuePosition: 0 })
    await cancelSessionOperation(handle.db, { operationId: secondOp.id })
  })

  it('队列位置按全局未过期排队计算，终态为 null', async () => {
    const a = (await prepare(await makeAccount('pos-a'))).operation!
    const b = (await prepare(await makeAccount('pos-b'))).operation!
    const viewA = await getSessionOperationView(handle.db, a.id)
    const viewB = await getSessionOperationView(handle.db, b.id)
    expect(viewB!.queuePosition).toBe(viewA!.queuePosition! + 1)
    await expireDeadline(a.id)
    expect((await getSessionOperationView(handle.db, b.id))!.queuePosition).toBe(viewA!.queuePosition)
    const cancelled = await cancelSessionOperation(handle.db, { operationId: b.id })
    expect(cancelled.status).toBe('CANCELLED')
    expect((await getSessionOperationView(handle.db, b.id))!.queuePosition).toBeNull()
  })
})
