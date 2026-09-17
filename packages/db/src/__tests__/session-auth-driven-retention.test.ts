import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_POLICY,
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'
import { TargetsStore } from '../console/targets.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import {
  abandonSessionKeepAlive,
  claimSessionOperation,
  claimSessionUse,
  createRunWithSnapshot,
  createScenarioWithVersion,
  findActiveLeaseForSession,
  findEvictableSession,
  hasQueuedSessionCreateOperation,
  forceLastUsedAt,
  getAccountSessionDetail,
  getSessionById,
  isolateOrphanedSessions,
  listDueRetainedSessions,
  listReapableSessions,
  listSessionEvents,
  loadResolvedSessionPolicyForTarget,
  registerFixture,
  registerWorker,
  releaseSessionUse,
  requestMaintenanceOperation,
  requireCreatedSession,
  scheduleNextAuthCheck,
  setSessionAuthSummary,
  setSessionRetention,
  setSessionStatus,
} from '../test-entry.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000d1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 认证驱动保活', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `adr_${Date.now().toString(36)}`)
    const { consoleAccounts, targets, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'adr',
      email: `adr-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `adr-${targetId.slice(0, 8)}`,
      name: '保活夹具',
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

  async function openSession(input: {
    accountId: string
    workerId: string
    instanceId?: string
    reclaimMode?: 'IDLE' | 'AUTH_DRIVEN'
    idleTtlSeconds?: number
    maxLifetimeSeconds?: number
    keepAliveSeconds?: number
    authProbeIntervalSeconds?: number
    evictionPriority?: number
  }) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: input.accountId },
      ownerWorkerId: input.workerId,
      ownerWorkerInstanceId: input.instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: input.idleTtlSeconds ?? 60,
      maxLifetimeSeconds: input.maxLifetimeSeconds ?? 14_400,
      reclaimMode: input.reclaimMode,
      keepAliveSeconds: input.keepAliveSeconds,
      authProbeIntervalSeconds: input.authProbeIntervalSeconds,
      evictionPriority: input.evictionPriority,
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

  async function succeedAuth(session: { id: string }, workerId: string, instanceId?: string) {
    const ok = await setSessionAuthSummary(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      authState: 'AUTHENTICATED',
      identityState: 'MATCH',
      lastAuthError: null,
      authProfileRevision: 1,
      observedTier: 'IDENTITY_VERIFIED',
      recordSuccess: true,
    })
    expect(ok).toBe(true)
    return (await getSessionById(handle.db, session.id))!
  }

  it('SL01 默认 IDLE 空闲超时可回收', async () => {
    const worker = await seedWorker(handle, `sl01-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('sl01')
    const session = await openSession({ accountId, workerId: worker.workerId, instanceId: worker.instanceId })
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    const reapable = await listReapableSessions(handle.db, worker.workerId)
    expect(reapable.map((row) => row.id)).toContain(session.id)
  })

  it('SL02 AUTH_DRIVEN 核验成功后空闲不回收', async () => {
    const worker = await seedWorker(handle, `sl02-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('sl02')
    const session = await openSession({
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    const after = await succeedAuth(session, worker.workerId, worker.instanceId)
    expect(after.keepAliveUntil?.getTime()).toBeGreaterThan(Date.now())
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 24 * 3600_000))
    expect(await listReapableSessions(handle.db, worker.workerId)).toHaveLength(0)
    const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: accountId }, limit: 20 })
    expect(events.items.some((event) => event.type === 'session.keepalive_extended')).toBe(true)
  })

  it('SL03 AUTH_DRIVEN 不豁免 expires_at', async () => {
    const worker = await seedWorker(handle, `sl03-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('sl03')
    const session = await openSession({
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
      maxLifetimeSeconds: 120,
    })
    await succeedAuth(session, worker.workerId, worker.instanceId)
    const { browserSessions } = schemaFor(handle.db)
    await handle.db
      .update(browserSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(browserSessions.id, session.id))
    const reapable = await listReapableSessions(handle.db, worker.workerId)
    expect(reapable.map((row) => row.id)).toContain(session.id)
  })

  it('SL04/SL05 due 列表含保活会话，暂停预算仍进入且放弃后停止巡检', async () => {
    const worker = await seedWorker(handle, `sl05-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('sl05')
    const session = await openSession({
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    await succeedAuth(session, worker.workerId, worker.instanceId)
    const { browserSessions, targetAccountAuthBudget } = schemaFor(handle.db)
    await handle.db
      .update(browserSessions)
      .set({ nextAuthCheckAt: new Date(Date.now() - 1000) })
      .where(eq(browserSessions.id, session.id))
    const due = await listDueRetainedSessions(handle.db, worker.workerId)
    expect(due.some((row) => row.session.id === session.id)).toBe(true)
    await handle.db.insert(targetAccountAuthBudget).values({
      id: newId(),
      targetAccountId: accountId,
      windowStartedAt: new Date(),
      autoLoginCount: 0,
      consecutiveFailures: 3,
      pausedReason: 'credential_or_challenge',
      lastConfigRevision: 1,
    })
    const duePaused = await listDueRetainedSessions(handle.db, worker.workerId)
    expect(duePaused.some((row) => row.session.id === session.id)).toBe(true)
    await abandonSessionKeepAlive(handle.db, session.id)
    const abandoned = (await getSessionById(handle.db, session.id))!
    expect(abandoned.nextAuthCheckAt).toBeNull()
    expect(abandoned.keepAliveUntil?.getTime()).toBeGreaterThan(Date.now())
    await handle.db
      .update(browserSessions)
      .set({ keepAliveUntil: new Date(Date.now() - 1000) })
      .where(eq(browserSessions.id, session.id))
    expect((await listReapableSessions(handle.db, worker.workerId)).map((row) => row.id)).toContain(session.id)
  })

  it('SL08/SL09 三级解析冻结，改 Target 不影响已有行与快照', async () => {
    const { targets } = schemaFor(handle.db)
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: 'sl08 platform',
      document: {
        ...current.document,
        session: { ...current.document.session, reuse: 'REUSE_PAGE', idleTtlSeconds: 900 },
      },
      actor: { id: actorId },
    })
    await handle.db
      .update(targets)
      .set({ sessionPolicy: { keepAliveSeconds: 1800, reclaim: 'AUTH_DRIVEN' } })
      .where(eq(targets.id, targetId))
    const resolved = await loadResolvedSessionPolicyForTarget(handle.db, targetId)
    expect(resolved.reuse).toBe('REUSE_PAGE')
    expect(resolved.idleTtlSeconds).toBe(900)
    expect(resolved.reclaim).toBe('AUTH_DRIVEN')
    expect(resolved.keepAliveSeconds).toBe(1800)
    const accountId = await makeAccount('sl08')
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `adr-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      sessionPolicy: { evictionPriority: 3 },
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.sessionPolicy).toMatchObject({
      reuse: 'REUSE_PAGE',
      idleTtlSeconds: 900,
      reclaim: 'AUTH_DRIVEN',
      keepAliveSeconds: 1800,
      evictionPriority: 3,
    })
    const worker = await seedWorker(handle, `sl09-${newId().slice(0, 8)}`)
    const session = await openSession({
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: resolved.reclaim,
      keepAliveSeconds: resolved.keepAliveSeconds,
      authProbeIntervalSeconds: resolved.authProbeIntervalSeconds,
    })
    await handle.db
      .update(targets)
      .set({ sessionPolicy: { reclaim: 'IDLE' } })
      .where(eq(targets.id, targetId))
    expect((await getSessionById(handle.db, session.id))?.reclaimMode).toBe('AUTH_DRIVEN')
    expect((await getSessionById(handle.db, session.id))?.keepAliveSeconds).toBe(1800)
    const again = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    expect(again.detail.snapshot.sessionPolicy?.reclaim).toBe('IDLE')
    expect(created.detail.snapshot.sessionPolicy?.reclaim).toBe('AUTH_DRIVEN')
    const store = new TargetsStore(registerFixture(handle), () => Buffer.from('fixture'))
    const dto = await store.getTarget(targetId)
    expect(dto.sessionPolicy).toEqual({ reclaim: 'IDLE' })
    expect(dto.effectiveSessionPolicy?.reclaim).toBe('IDLE')
    await store.updateSessionPolicy(targetId, { reclaim: null, idleTtlSeconds: 1200 }, { id: actorId })
    const updated = await store.getTarget(targetId)
    expect(updated.sessionPolicy).toEqual({ idleTtlSeconds: 1200 })
    expect(updated.effectiveSessionPolicy?.idleTtlSeconds).toBe(1200)
  })

  it('SL10 PREPARE 建会话读平台→Target 解析结果', async () => {
    const { targets } = schemaFor(handle.db)
    await handle.db
      .update(targets)
      .set({ sessionPolicy: { reuse: 'REUSE_PAGE', idleTtlSeconds: 800, maxLifetimeSeconds: 7200, reclaim: 'AUTH_DRIVEN' } })
      .where(eq(targets.id, targetId))
    const accountId = await makeAccount('sl10')
    const workerId = `sl10-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: `prep-${accountId}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const claimed = await claimSessionOperation(handle.db, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(claimed?.session).toMatchObject({
      reusePolicy: 'REUSE_PAGE',
      idleTtlSeconds: 800,
      maxLifetimeSeconds: 7200,
      reclaimMode: 'AUTH_DRIVEN',
    })
  })

  it('仅 PREPARE / VALIDATE / LOGIN 排队算会建会话', async () => {
    const accountId = await makeAccount('create-queue')
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: `prep-q-${accountId}-xxxxxxxx` },
      actor: { id: actorId },
    })
    expect(await hasQueuedSessionCreateOperation(handle.db)).toBe(true)
    const { sessionOperations } = schemaFor(handle.db)
    await handle.db
      .update(sessionOperations)
      .set({
        status: 'FAILED',
        errorCode: 'SESSION_NOT_CLAIMABLE',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(sessionOperations.targetAccountId, accountId), eq(sessionOperations.status, 'QUEUED')))
    expect(await hasQueuedSessionCreateOperation(handle.db)).toBe(false)
    const worker = await seedWorker(handle, `q-${newId().slice(0, 8)}`)
    const session = await openSession({
      accountId: await makeAccount('verify-queue'),
      workerId: worker.workerId,
      instanceId: worker.instanceId,
    })
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: session.targetAccountId },
      body: {
        kind: 'VERIFY_AUTH',
        idempotencyKey: `verify-q-${session.targetAccountId}-xxxxxxxx`,
        expectedSessionId: session.id,
        expectedGeneration: session.generation,
      },
      actor: { id: actorId },
    })
    expect(await hasQueuedSessionCreateOperation(handle.db)).toBe(false)
  })

  it('SL11 PREPARE 成功后同实例后续 Run 复用同一会话', async () => {
    const { targets } = schemaFor(handle.db)
    await handle.db
      .update(targets)
      .set({
        sessionPolicy: {
          reclaim: 'AUTH_DRIVEN',
          keepAliveSeconds: 3600,
          authProbeIntervalSeconds: 900,
        },
      })
      .where(eq(targets.id, targetId))
    const accountId = await makeAccount('sl11')
    const workerId = `sl11-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { kind: 'PREPARE', idempotencyKey: `prep-${accountId}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const prepared = await claimSessionOperation(handle.db, { workerId, instanceId, leaseTtlSeconds: 60 })
    expect(prepared?.session).toBeTruthy()
    const preparedSession = prepared!.session
    await setSessionStatus(handle.db, {
      sessionId: preparedSession.id,
      expectedVersion: preparedSession.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    await succeedAuth(preparedSession, workerId, instanceId)
    if (prepared?.grant) {
      await releaseSessionUse(handle.db, {
        leaseId: prepared.grant.leaseId,
        holderWorkerId: workerId,
        reason: 'prepare_done',
      })
    }
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `adr-sl11-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const firstRun = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const secondRun = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const firstGrant = await forceGrantForRun(handle, firstRun.detail.id, workerId)
    const firstClaim = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: firstGrant.runId, runFencingToken: firstGrant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(firstClaim.ok).toBe(true)
    if (!firstClaim.ok) throw new Error(firstClaim.message)
    expect(firstClaim.created).toBe(false)
    expect(firstClaim.session.id).toBe(preparedSession.id)
    expect(firstClaim.session.generation).toBe(preparedSession.generation)
    await releaseSessionUse(handle.db, {
      leaseId: firstClaim.grant.leaseId,
      holderWorkerId: workerId,
      reason: 'run_done',
    })
    const secondGrant = await forceGrantForRun(handle, secondRun.detail.id, workerId)
    const secondClaim = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: secondGrant.runId, runFencingToken: secondGrant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(secondClaim.ok).toBe(true)
    if (!secondClaim.ok) throw new Error(secondClaim.message)
    expect(secondClaim.created).toBe(false)
    expect(secondClaim.session.id).toBe(preparedSession.id)
    expect(secondClaim.session.generation).toBe(preparedSession.generation)
    const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: accountId }, limit: 50 })
    expect(events.items.filter((event) => event.type === 'auth.attempt_started')).toHaveLength(0)
  })

  it('SL12 驱逐先 IDLE 后 AUTH_DRIVEN，租约与人工保留不可选', async () => {
    const worker = await seedWorker(handle, `sl12-${newId().slice(0, 8)}`)
    const idleAccount = await makeAccount('sl12-idle')
    const keepAccount = await makeAccount('sl12-keep')
    const retainedAccount = await makeAccount('sl12-retain')
    const idle = await openSession({
      accountId: idleAccount,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'IDLE',
      evictionPriority: 5,
    })
    const kept = await openSession({
      accountId: keepAccount,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
      evictionPriority: 0,
    })
    await succeedAuth(kept, worker.workerId, worker.instanceId)
    const retained = await openSession({
      accountId: retainedAccount,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'IDLE',
      evictionPriority: 0,
    })
    await setSessionRetention(handle.db, {
      key: { targetId, targetAccountId: retainedAccount },
      body: { action: 'set', retainSeconds: 600 },
      actor: { id: actorId },
    })
    await forceLastUsedAt(handle.db, idle.id, new Date(Date.now() - 60_000))
    const first = await findEvictableSession(handle.db, worker.workerId, worker.instanceId)
    expect(first?.id).toBe(idle.id)
    const latestIdle = (await getSessionById(handle.db, idle.id))!
    await setSessionStatus(handle.db, {
      sessionId: idle.id,
      expectedVersion: latestIdle.version,
      status: 'CLOSED',
      closeReason: 'capacity_evict',
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
    })
    const second = await findEvictableSession(handle.db, worker.workerId, worker.instanceId)
    expect(second?.id).toBe(kept.id)
    expect(second?.id).not.toBe(retained.id)

    const leasedAccount = await makeAccount('sl12-lease')
    const leased = await openSession({
      accountId: leasedAccount,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'IDLE',
      evictionPriority: 0,
    })
    await forceLastUsedAt(handle.db, leased.id, new Date(Date.now() - 3600_000))
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `adr-sl12-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: leasedAccount,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, run.detail.id, worker.workerId)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: leasedAccount },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: worker.workerId,
      holderInstanceId: worker.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(claimed.ok).toBe(true)
    const third = await findEvictableSession(handle.db, worker.workerId, worker.instanceId)
    expect(third?.id).toBe(kept.id)
    expect(third?.id).not.toBe(leased.id)
  })

  it('SL13 策略保活不占人工保留配额', async () => {
    const workerId = `sl13-${newId().slice(0, 8)}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 4,
      maxSessions: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, SESSION_MAINTENANCE_PROTOCOL],
    })
    const keepAccount = await makeAccount('sl13-keep')
    const retainAccount = await makeAccount('sl13-retain')
    const kept = await openSession({
      accountId: keepAccount,
      workerId,
      instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    await succeedAuth(kept, workerId, instanceId)
    const retained = await openSession({
      accountId: retainAccount,
      workerId,
      instanceId,
      reclaimMode: 'IDLE',
    })
    const result = await setSessionRetention(handle.db, {
      key: { targetId, targetAccountId: retainAccount },
      body: { action: 'set', retainSeconds: 600 },
      actor: { id: actorId },
    })
    expect(result.retainUntil).toBeTruthy()
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: retainAccount })
    expect(detail.retention?.quotaUsed).toBe(1)
    expect(detail.session?.id).toBe(retained.id)

    const extraKeep = await makeAccount('sl13-keep-2')
    const extraKept = await openSession({
      accountId: extraKeep,
      workerId,
      instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    await succeedAuth(extraKept, workerId, instanceId)
    const extraRetain = await makeAccount('sl13-retain-2')
    const extraRetained = await openSession({
      accountId: extraRetain,
      workerId,
      instanceId,
      reclaimMode: 'IDLE',
    })
    await expect(
      setSessionRetention(handle.db, {
        key: { targetId, targetAccountId: extraRetain },
        body: { action: 'set', retainSeconds: 600 },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'RETENTION_QUOTA_EXCEEDED' })
    expect((await getSessionById(handle.db, extraRetained.id))?.reclaimMode).toBe('IDLE')
    expect((await getSessionById(handle.db, extraKept.id))?.keepAliveUntil).toBeTruthy()
  })

  it('SL14 Worker 实例更替后旧行保持 LOST，保活列仍在', async () => {
    const workerId = `sl14-${newId().slice(0, 8)}`
    const oldInstance = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: oldInstance,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const accountId = await makeAccount('sl14')
    const session = await openSession({
      accountId,
      workerId,
      instanceId: oldInstance,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    const live = await succeedAuth(session, workerId, oldInstance)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `adr-sl14-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const grant = await forceGrantForRun(handle, run.detail.id, workerId)
    const leased = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: accountId },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: oldInstance,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(leased.ok).toBe(true)
    const replacement = newId()
    const { workers } = schemaFor(handle.db)
    await handle.db.update(workers).set({ instanceId: replacement }).where(eq(workers.id, workerId))
    expect(await isolateOrphanedSessions(handle.db, workerId, replacement)).toBeGreaterThanOrEqual(1)
    const lost = (await getSessionById(handle.db, live.id))!
    expect(lost.status).toBe('LOST')
    expect(lost.closeReason).toBe('owner_instance_replaced')
    expect(lost.reclaimMode).toBe('AUTH_DRIVEN')
    expect(lost.keepAliveUntil).toBeTruthy()
    expect(await findActiveLeaseForSession(handle.db, live.id)).toBeNull()
  })

  it('取消人工保留时保活会话不清空 nextAuthCheckAt', async () => {
    const worker = await seedWorker(handle, `clr-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('clear-keep')
    const session = await openSession({
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    await succeedAuth(session, worker.workerId, worker.instanceId)
    await setSessionRetention(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { action: 'set', retainSeconds: 600 },
      actor: { id: actorId },
    })
    await setSessionRetention(handle.db, {
      key: { targetId, targetAccountId: accountId },
      body: { action: 'clear' },
      actor: { id: actorId },
    })
    const after = (await getSessionById(handle.db, session.id))!
    expect(after.retainUntil).toBeNull()
    expect(after.nextAuthCheckAt).toBeTruthy()
  })

  it('scheduleNextAuthCheck 使用冻结的巡检间隔', async () => {
    const worker = await seedWorker(handle, `sch-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('schedule')
    const session = await openSession({
      accountId,
      workerId: worker.workerId,
      instanceId: worker.instanceId,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 120,
    })
    const before = Date.now()
    await scheduleNextAuthCheck(handle.db, session.id)
    const after = (await getSessionById(handle.db, session.id))!
    const delta = after.nextAuthCheckAt!.getTime() - before
    expect(delta).toBeGreaterThanOrEqual(110_000)
    expect(delta).toBeLessThan(130_000)
  })

  it('无画像时 PREPARE / LOGIN 仍可用（LEGACY 旁路）', async () => {
    const accountId = await makeAccount('no-profile')
    const detail = await getAccountSessionDetail(handle.db, { targetId, targetAccountId: accountId })
    const prepare = detail.actions.find((action) => action.kind === 'PREPARE')
    const login = detail.actions.find((action) => action.kind === 'LOGIN')
    expect(prepare?.enabled).toBe(true)
    expect(prepare?.disabledReason).toBeNull()
    expect(login?.enabled).toBe(true)
    expect(login?.disabledReason).toBeNull()
  })

  it('缺字段历史策略仍解析为 IDLE', async () => {
    expect(DEFAULT_SESSION_POLICY.reclaim).toBe('IDLE')
  })

  it('AUTH_DRIVEN 建会话缺少保活字段则拒绝', async () => {
    const worker = await seedWorker(handle, `sl-create-${newId().slice(0, 8)}`)
    const accountId = await makeAccount('create-auth')
    await expect(
      requireCreatedSession(handle.db, {
        key: { targetId, targetAccountId: accountId },
        ownerWorkerId: worker.workerId,
        ownerWorkerInstanceId: worker.instanceId,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 60,
        maxLifetimeSeconds: 14_400,
        reclaimMode: 'AUTH_DRIVEN',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_POLICY_INVALID' })
  })
})
