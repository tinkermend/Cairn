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
  getAccountSessionDetail,
  listAccountSessionOverview,
  listSessionSystemOverview,
  sessionOverviewReadStats,
  listSessionEventsAfter,
  registerWorker,
  requestMaintenanceOperation,
  requireCreatedSession,
  setSessionProbe,
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

  it('总览批量装占用事实，查询次数不随账号数线性增长', async () => {
    const workerId = `ovw-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    const label = `ovw-${newId().slice(0, 8)}`
    const unprepared = await makeAccount(`${label}-unprepared`)
    const ready = await makeAccount(`${label}-ready`)
    const expired = await makeAccount(`${label}-expired`)
    const lost = await makeAccount(`${label}-lost`)
    const maintenance = await makeAccount(`${label}-maint`)
    await Promise.all(Array.from({ length: 8 }, (_, index) => makeAccount(`${label}-extra-${index}`)))

    const openAccount = async (accountId: string, authState: 'AUTHENTICATED' | 'EXPIRED') => {
      const session = await requireCreatedSession(handle.db, {
        key: { targetId, targetAccountId: accountId },
        ownerWorkerId: workerId,
        ownerWorkerInstanceId: instanceId,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      })
      await setSessionStatus(handle.db, {
        sessionId: session.id,
        expectedVersion: session.version,
        status: 'OPEN',
        ownerWorkerId: workerId,
        ownerWorkerInstanceId: instanceId,
      })
      await setSessionProbe(handle.db, {
        sessionId: session.id,
        ownerWorkerId: workerId,
        ownerWorkerInstanceId: instanceId,
        health: 'HEALTHY',
        authState,
      })
      return session
    }
    await openAccount(ready, 'AUTHENTICATED')
    await openAccount(expired, 'EXPIRED')
    const lostSession = await openAccount(lost, 'AUTHENTICATED')
    await setSessionStatus(handle.db, {
      sessionId: lostSession.id,
      expectedVersion: lostSession.version + 1,
      status: 'LOST',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: maintenance },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })

    const originalSelect = handle.db.select
    let selects = 0
    handle.db.select = ((...args: Parameters<typeof originalSelect>) => {
      selects += 1
      return originalSelect.apply(handle.db, args)
    }) as typeof originalSelect
    try {
      const overview = await listAccountSessionOverview(handle.db, { search: label, limit: 20 })
      expect(selects).toBeGreaterThanOrEqual(4)
      expect(selects).toBeLessThanOrEqual(8)
      const byAccount = new Map(overview.items.map((item) => [item.targetAccountId, item]))
      expect(byAccount.get(unprepared)?.status).toBe('unprepared')
      expect(byAccount.get(ready)?.status).toBe('ready')
      expect(byAccount.get(expired)?.status).toBe('needs_login')
      expect(byAccount.get(lost)?.status).toBe('lost')
      expect(byAccount.get(maintenance)?.status).toBe('maintenance')
      expect(overview.summary.unprepared).toBeGreaterThanOrEqual(9)
      expect(overview.summary.available).toBe(1)
      expect(overview.summary.needsLogin).toBe(1)
      expect(overview.summary.lost).toBe(1)
      expect(overview.summary.maintenance).toBe(1)
      for (const item of overview.items) {
        const detail = await getAccountSessionDetail(handle.db, {
          targetId: item.targetId,
          targetAccountId: item.targetAccountId,
        })
        expect(detail.status).toBe(item.status)
        expect(detail.occupancy?.occupyingRunId ?? null).toBe(item.occupyingRunId)
        expect(detail.occupancy?.occupyingOperationId ?? detail.currentOperation?.id ?? null).toBe(
          item.occupyingOperationId,
        )
      }
    } finally {
      handle.db.select = originalSelect
    }
  })

  it('系统总览按目标聚合，targetId 账号摘要不受搜索影响', async () => {
    const { targets } = schemaFor(handle.db)
    const otherId = newId()
    await handle.db.insert(targets).values({
      id: otherId,
      code: `sys-${otherId.slice(0, 8)}`,
      name: '另一系统',
      entryUrl: 'https://other.example.com',
      status: 'active',
    })
    const prefix = `sysov-${newId().slice(0, 6)}`
    const localReady = await makeAccount(`${prefix}-ready`)
    const localUnprepared = await makeAccount(`${prefix}-wait`)
    const otherAccount = newId()
    const { targetAccounts } = schemaFor(handle.db)
    await handle.db.insert(targetAccounts).values({
      id: otherAccount,
      targetId: otherId,
      displayName: `${prefix}-foreign`,
      username: `u-${prefix}-foreign`,
      status: 'active',
    })
    const workerId = `sysov-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: localReady },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })

    const systems = await listSessionSystemOverview(handle.db, { search: '维护夹具', limit: 1 })
    expect(systems.items).toHaveLength(1)
    expect(systems.items[0]?.targetId).toBe(targetId)
    expect(systems.items[0]?.accountTotal).toBeGreaterThanOrEqual(2)
    expect(systems.items[0]?.targetCode).toContain('mnt-')
    expect(systems.summary.systems).toBeGreaterThanOrEqual(2)
    expect(systems.nextCursor).toBeUndefined()

    const paged = await listSessionSystemOverview(handle.db, { limit: 1 })
    expect(paged.items).toHaveLength(1)
    expect(paged.nextCursor).toBe('1')
    const page2 = await listSessionSystemOverview(handle.db, { limit: 1, cursor: paged.nextCursor })
    expect(page2.items[0]?.targetId).not.toBe(paged.items[0]?.targetId)

    const scoped = await listAccountSessionOverview(handle.db, {
      targetId,
      search: `${prefix}-wait`,
      limit: 20,
    })
    expect(scoped.items.every((item) => item.targetId === targetId)).toBe(true)
    expect(scoped.items.map((item) => item.targetAccountId)).toEqual([localUnprepared])
    expect(scoped.summary.total).toBeGreaterThanOrEqual(2)
    expect(scoped.summary.unprepared).toBeGreaterThanOrEqual(1)
    expect(scoped.items.some((item) => item.targetAccountId === otherAccount)).toBe(false)

    const byName = await listAccountSessionOverview(handle.db, { targetId: otherId, search: '维护夹具' })
    expect(byName.items).toHaveLength(0)
    expect(byName.summary.total).toBe(1)

    const stamp = `zzpage-${newId().slice(0, 8)}`
    for (let index = 0; index < 6; index += 1) {
      const extraId = newId()
      await handle.db.insert(targets).values({
        id: extraId,
        code: `${stamp}-${index}`,
        name: `${stamp}-${index}`,
        entryUrl: 'https://page.example.com',
        status: 'active',
      })
      for (let accountIndex = 0; accountIndex < 4; accountIndex += 1) {
        await handle.db.insert(targetAccounts).values({
          id: newId(),
          targetId: extraId,
          displayName: `${stamp}-acc-${index}-${accountIndex}`,
          username: `u-${stamp}-${index}-${accountIndex}`,
          status: 'active',
        })
      }
    }
    sessionOverviewReadStats.reset()
    const firstPage = await listSessionSystemOverview(handle.db, { search: stamp, limit: 1 })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.items[0]?.accountTotal).toBe(4)
    expect(firstPage.summary.systems).toBeGreaterThanOrEqual(6)
    expect(firstPage.nextCursor).toBe('1')
    expect(Math.max(0, ...sessionOverviewReadStats.occupancyKeyCounts)).toBe(4)

    sessionOverviewReadStats.reset()
    const secondPage = await listSessionSystemOverview(handle.db, {
      search: stamp,
      limit: 1,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0]?.targetId).not.toBe(firstPage.items[0]?.targetId)
    expect(secondPage.items[0]?.accountTotal).toBe(4)
    expect(Math.max(0, ...sessionOverviewReadStats.occupancyKeyCounts)).toBe(4)

    const isolatedId = newId()
    await handle.db.insert(targets).values({
      id: isolatedId,
      code: `accpage-${isolatedId.slice(0, 8)}`,
      name: `账号页-${isolatedId.slice(0, 8)}`,
      entryUrl: 'https://accounts.example.com',
      status: 'active',
    })
    const isolatedPrefix = `accpage-${newId().slice(0, 6)}`
    const isolatedAccounts = []
    for (let index = 0; index < 3; index += 1) {
      const accountId = newId()
      isolatedAccounts.push(accountId)
      await handle.db.insert(targetAccounts).values({
        id: accountId,
        targetId: isolatedId,
        displayName: `${isolatedPrefix}-${index}`,
        username: `u-${isolatedPrefix}-${index}`,
        status: 'active',
      })
    }
    const accountPage = await listAccountSessionOverview(handle.db, { targetId: isolatedId, limit: 1 })
    expect(accountPage.items).toHaveLength(1)
    expect(accountPage.summary.total).toBe(3)
    expect(accountPage.nextCursor).toBe('1')
    const accountPage2 = await listAccountSessionOverview(handle.db, {
      targetId: isolatedId,
      limit: 1,
      cursor: accountPage.nextCursor,
    })
    expect(accountPage2.items[0]?.targetAccountId).not.toBe(accountPage.items[0]?.targetAccountId)
    expect(accountPage2.summary.total).toBe(3)
    const searched = await listAccountSessionOverview(handle.db, {
      targetId: isolatedId,
      search: `${isolatedPrefix}-1`,
      limit: 20,
    })
    expect(searched.items.map((item) => item.targetAccountId)).toEqual([isolatedAccounts[1]])
    expect(searched.summary.total).toBe(3)
  })

  it('总览包含未准备账号，CLOSE 不得创建会话', async () => {
    const accountId = await makeAccount('unprepared')
    const overview = await listAccountSessionOverview(handle.db, { search: 'unprepared', limit: 20 })
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
