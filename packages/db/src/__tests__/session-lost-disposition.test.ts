import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SESSION_OCCUPANCY_PROTOCOL,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { enterAuthWaitForRun, forceGrantForRun, seedWorker } from './lease-harness.js'
import { TargetsStore } from '../console/targets.js'
import {
  claimSessionUse,
  createRunWithSnapshot,
  createScenarioWithVersion,
  evaluateRunSessionEligibility,
  findLiveSession,
  getAccountSessionDetail,
  getRun,
  getSessionById,
  isolateOrphanedSessions,
  listSessionEvents,
  readSessionScheduling,
  registerFixture,
  registerWorker,
  requireCreatedSession,
  setSessionRetention,
  setSessionStatus,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000d2',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 失联处置策略', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `ld_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'ld',
      email: `ld-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function makeTarget(label: string) {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `ld-${label}-${id.slice(0, 8)}`,
      name: label,
      entryUrl: 'https://example.com',
      status: 'active',
    })
    return id
  }

  async function makeAccount(targetId: string, label: string) {
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

  async function openSession(input: {
    targetId: string
    accountId: string
    workerId: string
    instanceId?: string
  }) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId: input.targetId, targetAccountId: input.accountId },
      ownerWorkerId: input.workerId,
      ownerWorkerInstanceId: input.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 60,
      maxLifetimeSeconds: 14_400,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: input.workerId,
      ownerWorkerInstanceId: input.instanceId,
    })
    return (await getSessionById(handle.db, session.id))!
  }

  async function setLostDisposition(targetId: string, lostDisposition: 'AUTO' | 'MANUAL') {
    const { targets } = schemaFor(handle.db)
    await handle.db.update(targets).set({ sessionPolicy: { lostDisposition } }).where(eq(targets.id, targetId))
  }

  async function replaceWorker(workerId: string) {
    const replacement = newId()
    const { workers } = schemaFor(handle.db)
    await handle.db.update(workers).set({ instanceId: replacement }).where(eq(workers.id, workerId))
    return replacement
  }

  async function queueRun(targetId: string, accountId: string, sessionPolicy?: { leaseTtlSeconds: number }) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `ld-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      sessionPolicy,
      actor: { id: actorId },
    })
  }

  async function eligibility(input: {
    runId: string
    createdAt: string
    targetId: string
    accountId: string
    workerId: string
    instanceId: string
  }) {
    return evaluateRunSessionEligibility(handle.db, {
      run: {
        id: input.runId,
        createdAt: new Date(input.createdAt),
        targetId: input.targetId,
        targetAccountId: input.accountId,
      },
      workerId: input.workerId,
      instanceId: input.instanceId,
      maxSessions: 8,
      scheduling: await readSessionScheduling(handle.db),
    })
  }

  it('LD01 缺字段保持 LOST 且运行 SESSION_LOST', async () => {
    const targetId = await makeTarget('manual')
    const accountId = await makeAccount(targetId, 'manual')
    const worker = await seedWorker(handle, `ld01-${newId().slice(0, 8)}`)
    const session = await openSession({
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    const run = await queueRun(targetId, accountId)
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(1)
    const lost = (await getSessionById(handle.db, session.id))!
    expect(lost.status).toBe('LOST')
    expect(lost.closeReason).toBe('owner_instance_replaced')
    expect(await findLiveSession(handle.db, { targetId, targetAccountId: accountId })).toMatchObject({
      id: session.id,
      status: 'LOST',
    })
    const judged = await eligibility({
      runId: run.detail.id,
      createdAt: run.detail.createdAt,
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: replacement,
    })
    expect(judged).toMatchObject({ eligible: false, facts: { waitReason: 'SESSION_LOST' } })
    const events = await listSessionEvents(handle.db, { sessionId: session.id, limit: 20 })
    expect(events.items.some((event) => event.type === 'session.lost')).toBe(true)
    expect(events.items.some((event) => event.type === 'session.closed')).toBe(false)
  })

  it('LD02/LD05/LD11 AUTO isolate 先记失联再关行，不新建 OPEN', async () => {
    const targetId = await makeTarget('auto')
    const accountId = await makeAccount(targetId, 'auto')
    await setLostDisposition(targetId, 'AUTO')
    const worker = await seedWorker(handle, `ld02-${newId().slice(0, 8)}`)
    const session = await openSession({
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    const profileKey = session.profileKey
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(1)
    const closed = (await getSessionById(handle.db, session.id))!
    expect(closed.status).toBe('CLOSED')
    expect(closed.closeReason).toBe('owner_lost_auto_disposed')
    expect(closed.profileKey).toBe(profileKey)
    expect(await findLiveSession(handle.db, { targetId, targetAccountId: accountId })).toBeNull()
    const { browserSessions, consoleAuditEvents } = schemaFor(handle.db)
    const live = await handle.db
      .select({ id: browserSessions.id, status: browserSessions.status })
      .from(browserSessions)
      .where(eq(browserSessions.targetAccountId, accountId))
    expect(live.filter((row) => row.status === 'OPEN' || row.status === 'LOST')).toHaveLength(0)
    const events = await listSessionEvents(handle.db, { sessionId: session.id, limit: 20 })
    const lost = events.items.find((event) => event.type === 'session.lost')
    const closedEvent = events.items.find((event) => event.type === 'session.closed')
    expect(lost?.payload).toMatchObject({ closeReason: 'owner_instance_replaced' })
    expect(closedEvent?.payload).toMatchObject({ disposition: 'AUTO', closeReason: 'owner_lost_auto_disposed' })
    expect(lost!.seq).toBeLessThan(closedEvent!.seq)
    const audits = await handle.db
      .select()
      .from(consoleAuditEvents)
      .where(eq(consoleAuditEvents.resourceId, session.id))
    expect(audits.some((row) => row.action === 'session.dispose')).toBe(false)
  })

  it('LD03 同 Worker 只自动处置 AUTO 目标', async () => {
    const manualTarget = await makeTarget('mix-manual')
    const autoTarget = await makeTarget('mix-auto')
    await setLostDisposition(autoTarget, 'AUTO')
    const manualAccount = await makeAccount(manualTarget, 'mix-manual')
    const autoAccount = await makeAccount(autoTarget, 'mix-auto')
    const worker = await seedWorker(handle, `ld03-${newId().slice(0, 8)}`)
    const manualSession = await openSession({
      targetId: manualTarget,
      accountId: manualAccount,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    const autoSession = await openSession({
      targetId: autoTarget,
      accountId: autoAccount,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(2)
    expect((await getSessionById(handle.db, manualSession.id))?.status).toBe('LOST')
    expect((await getSessionById(handle.db, autoSession.id))?.status).toBe('CLOSED')
    expect((await getSessionById(handle.db, autoSession.id))?.closeReason).toBe('owner_lost_auto_disposed')
  })

  it('LD04/LD09 AUTO 后已排队运行可新建会话并沿用保留意图', async () => {
    const targetId = await makeTarget('queue')
    const accountId = await makeAccount(targetId, 'queue')
    await setLostDisposition(targetId, 'AUTO')
    const worker = await seedWorker(handle, `ld04-${newId().slice(0, 8)}`)
    const previous = await openSession({
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    await setSessionRetention(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { action: 'set', retainSeconds: 1800 },
      actor: { id: actorId },
    })
    const run = await queueRun(targetId, accountId)
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(1)
    expect((await getSessionById(handle.db, previous.id))?.status).toBe('CLOSED')
    const judged = await eligibility({
      runId: run.detail.id,
      createdAt: run.detail.createdAt,
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: replacement,
    })
    expect(judged.eligible).toBe(true)
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: worker.workerId,
      holderInstanceId: replacement,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 60,
      maxLifetimeSeconds: 14_400,
    })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) throw new Error(claimed.message)
    expect(claimed.created).toBe(true)
    expect(claimed.session.id).not.toBe(previous.id)
    expect(claimed.session.status).toBe('CREATING')
    expect(claimed.session.retainUntil?.getTime()).toBeGreaterThan(Date.now())
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: accountId })
    expect(detail.retained).toBe(true)
    expect(detail.session?.id).toBe(claimed.session.id)
  })

  it('LD06 正常关闭不写自动处置理由', async () => {
    const targetId = await makeTarget('shutdown')
    const accountId = await makeAccount(targetId, 'shutdown')
    await setLostDisposition(targetId, 'AUTO')
    const worker = await seedWorker(handle, `ld06-${newId().slice(0, 8)}`)
    const session = await openSession({
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    expect(
      await setSessionStatus(handle.db, {
        sessionId: session.id,
        expectedVersion: session.version,
        status: 'CLOSED',
        closeReason: 'worker_shutdown',
        ownerWorkerId: worker.workerId,
        ownerWorkerInstanceId: worker.instanceId,
      }),
    ).toBe(true)
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(0)
    const closed = (await getSessionById(handle.db, session.id))!
    expect(closed.status).toBe('CLOSED')
    expect(closed.closeReason).toBe('worker_shutdown')
  })

  it('LD07 已 LOST 的行不会被后来的 AUTO 回放', async () => {
    const targetId = await makeTarget('replay')
    const accountId = await makeAccount(targetId, 'replay')
    const worker = await seedWorker(handle, `ld07-${newId().slice(0, 8)}`)
    const session = await openSession({
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(1)
    expect((await getSessionById(handle.db, session.id))?.status).toBe('LOST')
    await setLostDisposition(targetId, 'AUTO')
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(0)
    expect((await getSessionById(handle.db, session.id))?.status).toBe('LOST')
    expect((await getSessionById(handle.db, session.id))?.closeReason).toBe('owner_instance_replaced')
  })

  it('LD08 POST/createRun 拒绝 lostDisposition，其它 Run 覆盖不影响判定', async () => {
    const targetId = await makeTarget('run-override')
    const accountId = await makeAccount(targetId, 'run-override')
    await setLostDisposition(targetId, 'AUTO')
    await expect(
      queueRun(targetId, accountId, { lostDisposition: 'MANUAL' } as never),
    ).rejects.toThrow()
    const worker = await seedWorker(handle, `ld08-${newId().slice(0, 8)}`)
    const session = await openSession({
      targetId,
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    await queueRun(targetId, accountId, { leaseTtlSeconds: 20 })
    const replacement = await replaceWorker(worker.workerId)
    expect(await isolateOrphanedSessions(handle.db, worker.workerId, replacement)).toBe(1)
    expect((await getSessionById(handle.db, session.id))?.closeReason).toBe('owner_lost_auto_disposed')
  })

  it('AUTO 先结算 AUTH_WAIT 再关行，不把等待租约标 REVOKED', async () => {
    const targetId = await makeTarget('auth-wait')
    const accountId = await makeAccount(targetId, 'auth-wait')
    await setLostDisposition(targetId, 'AUTO')
    const worker = await seedWorker(handle, `ld-aw-${newId().slice(0, 8)}`)
    const run = await queueRun(targetId, accountId)
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    const { claimed, waitGrant } = await enterAuthWaitForRun(handle, {
      targetId,
      targetAccountId: accountId,
      grant,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      holdSeconds: 600,
    })
    const { workers, sessionLeases } = schemaFor(handle.db)
    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: new Date(0), status: 'LOST' })
      .where(eq(workers.id, worker.workerId))
    await registerWorker(handle.db, {
      workerId: worker.workerId,
      instanceId: newId(),
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const closed = (await getSessionById(handle.db, claimed.session.id))!
    expect(closed.status).toBe('CLOSED')
    expect(closed.closeReason).toBe('owner_lost_auto_disposed')
    const [wait] = await handle.db
      .select()
      .from(sessionLeases)
      .where(eq(sessionLeases.id, waitGrant.leaseId))
    expect(wait?.status).toBe('EXPIRED')
    expect(wait?.releaseReason).toBe('auth_wait_holder_lost')
    expect((await getRun(handle.db, run.detail.id)).status).toBe('RECOVERING')
  })

  it('LD12 目标策略卡读写 lostDisposition', async () => {
    const targetId = await makeTarget('ui-policy')
    const store = new TargetsStore(registerFixture(handle), () => Buffer.from('fixture'))
    const initial = await store.getTarget(targetId)
    expect(initial.sessionPolicy).toBeNull()
    expect(initial.effectiveSessionPolicy?.lostDisposition).toBe('MANUAL')
    const updated = await store.updateSessionPolicy(targetId, { lostDisposition: 'AUTO' }, { id: actorId })
    expect(updated.sessionPolicy).toEqual({ lostDisposition: 'AUTO' })
    expect(updated.effectiveSessionPolicy?.lostDisposition).toBe('AUTO')
    const cleared = await store.updateSessionPolicy(targetId, { lostDisposition: null }, { id: actorId })
    expect(cleared.sessionPolicy).toBeNull()
    expect(cleared.effectiveSessionPolicy?.lostDisposition).toBe('MANUAL')
  })
})
