import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMapJobRun, MAP_JOBS_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  claimRun,
  cancelMapJob,
  createMapJob,
  createMapSafeEntry,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getMapJobPolicy,
  getTargetAccessPolicy,
  updateTargetAccessPolicy,
  requestRunCancel,
  listScenarios,
  registerWorker,
  requireCreatedSession,
  setSessionProbe,
  setSessionStatus,
  updateMapJobPolicy,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function probeSteps(): Step[] {
  return [
    {
      id: newId(),
      name: '打开入口',
      type: 'navigate',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { url: 'https://shop.example/orders' },
    },
    {
      id: newId(),
      name: '到达标题',
      type: 'assert',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] }, expect: { kind: 'visible' } },
    },
  ]
}

describe.each(DRIVERS)('%s 地图作业账本', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_omg_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-omg',
      email: `map-omg-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function freshTarget(loginUrl?: string) {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `omg-${targetId}`,
      name: '作业夹具',
      entryUrl: 'https://shop.example/home',
      loginUrl: loginUrl ?? 'https://idp.example/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '作业账号',
      username: `ops-${accountId}`,
      status: 'active',
    })
    return { targetId, accountId }
  }

  async function readyWorker(suffix: string, capabilities: string[]) {
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId: `omg-w-${suffix}`,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, ...capabilities],
    })
    return { workerId: `omg-w-${suffix}`, instanceId }
  }

  async function prepareSession(targetId: string, accountId: string, workerId: string, instanceId: string) {
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
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    const { browserSessions } = schemaFor(handle.db)
    const { eq } = await import('drizzle-orm')
    await handle.db.update(browserSessions).set({ observedTier: 'LOGIN_VERIFIED' }).where(eq(browserSessions.id, session.id))
    return session
  }

  async function enableJobs(targetId: string) {
    return updateMapJobPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `enable:${targetId}`.slice(0, 128),
        manualJobsEnabled: true,
        reason: '夹具开放',
      },
      actor(),
    )
  }

  async function addEntry(targetId: string) {
    return createMapSafeEntry(
      handle.db,
      targetId,
      {
        idempotencyKey: `entry:${targetId}`.slice(0, 128),
        name: '订单入口',
        url: 'https://shop.example/orders',
        arrivalName: '订单标题',
        arrivalTarget: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
        safetyBasisKind: 'confirmed_path',
        summary: '只读复查已确认路径',
        jobKinds: ['map_probe', 'map_refresh'],
      },
      actor(),
    )
  }

  it('工厂政策默认关闭，新正式 Run 冻结授权且含认证域', async () => {
    const { targetId } = await freshTarget()
    const policy = await getMapJobPolicy(handle.db, targetId)
    expect(policy.policy.manualJobsEnabled).toBe(false)
    expect(policy.revision).toBe(0)
    const access = await getTargetAccessPolicy(handle.db, targetId)
    expect(access.seeded).toBe(true)
    expect(access.resourceLoadsUnrestricted).toBe(true)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `正式-${newId().slice(0, 8)}`,
      actor: { kind: 'console', id: actorId },
      steps: probeSteps(),
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { kind: 'console', id: actorId },
    })
    expect(created.detail.snapshot.accessPolicy?.policy.rules.map((rule) => rule.purpose).sort()).toEqual([
      'authentication',
      'business_surface',
    ])
    expect(created.detail.snapshot.allowedOrigins).toEqual(expect.arrayContaining(['https://shop.example', 'https://idp.example']))
    expect(created.detail.snapshot.mapJob).toBeUndefined()
  })

  it('冻结 pathPrefix，路径级 deny 不掏空 allowedOrigins', async () => {
    const { targetId } = await freshTarget()
    await updateTargetAccessPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `path:${targetId}`.slice(0, 128),
        reason: '收窄业务路径',
        rules: [
          { origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/' },
          { origin: 'https://shop.example', purpose: 'business_surface', effect: 'deny', pathPrefix: '/admin' },
          { origin: 'https://idp.example', purpose: 'authentication', effect: 'allow' },
        ],
      },
      actor(),
    )
    const access = await getTargetAccessPolicy(handle.db, targetId)
    expect(access.policy?.rules.some((rule) => rule.pathPrefix === '/admin')).toBe(true)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `路径-${newId().slice(0, 8)}`,
      actor: { kind: 'console', id: actorId },
      steps: probeSteps(),
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { kind: 'console', id: actorId },
    })
    expect(created.detail.snapshot.accessPolicy?.policy.rules.some((rule) => rule.pathPrefix === '/admin')).toBe(true)
    expect(created.detail.snapshot.allowedOrigins).toEqual(
      expect.arrayContaining(['https://shop.example', 'https://idp.example']),
    )
    await requestRunCancel(handle.db, created.detail.id, actor())
  })

  it('OMG04 未准备会话不能建作业；OMG12 开关关闭也不能建', async () => {
    const { targetId, accountId } = await freshTarget()
    const entry = await addEntry(targetId)
    await expect(
      createMapJob(
        handle.db,
        targetId,
        {
          manualId: `closed-${targetId}`.slice(0, 32),
          expectedPolicyRevision: 0,
          jobKind: 'map_probe',
          targetAccountId: accountId,
          entryId: entry.entryId,
        },
        actor(),
        { steps: probeSteps() },
      ),
    ).rejects.toMatchObject({ code: 'MAP_FORBIDDEN' })
    await enableJobs(targetId)
    await expect(
      createMapJob(
        handle.db,
        targetId,
        {
          manualId: `auth-${targetId}`.slice(0, 32),
          expectedPolicyRevision: 1,
          jobKind: 'map_probe',
          targetAccountId: accountId,
          entryId: entry.entryId,
        },
        actor(),
        { steps: probeSteps() },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_PREPARATION_REQUIRED' })
  })

  it('OMG01 同键同摘要返回原作业，换摘要冲突，换账号独立', async () => {
    const { targetId, accountId } = await freshTarget()
    const otherAccount = newId()
    const { targetAccounts } = schemaFor(handle.db)
    await handle.db.insert(targetAccounts).values({
      id: otherAccount,
      targetId,
      displayName: '第二账号',
      username: `ops-${otherAccount}`,
      status: 'active',
    })
    const worker = await readyWorker(targetId.slice(0, 8), [MAP_JOBS_PROTOCOL])
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await prepareSession(targetId, otherAccount, worker.workerId, worker.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const body = {
      manualId: `same-${targetId}`.slice(0, 32),
      expectedPolicyRevision: 1,
      jobKind: 'map_probe' as const,
      targetAccountId: accountId,
      entryId: entry.entryId,
    }
    const first = await createMapJob(handle.db, targetId, body, actor(), { steps: probeSteps() })
    const again = await createMapJob(handle.db, targetId, body, actor(), { steps: probeSteps() })
    expect(again.created).toBe(false)
    expect(again.job.jobId).toBe(first.job.jobId)
    await expect(
      createMapJob(
        handle.db,
        targetId,
        { ...body, jobKind: 'map_refresh' },
        actor(),
        { steps: probeSteps() },
      ),
    ).rejects.toMatchObject({ code: 'MAP_IDEMPOTENCY_CONFLICT' })
    await cancelMapJob(handle.db, first.job.jobId, actor())
    const other = await createMapJob(
      handle.db,
      targetId,
      { ...body, targetAccountId: otherAccount, manualId: `other-${targetId}`.slice(0, 32) },
      actor(),
      { steps: probeSteps() },
    )
    expect(other.job.jobId).not.toBe(first.job.jobId)
    const listed = await listScenarios(handle.db, { targetId, limit: 50 })
    expect(listed.items.every((item) => !item.name.startsWith('[地图作业]'))).toBe(true)
    expect(first.job.firstRunId).toBeTruthy()
    const { runs } = schemaFor(handle.db)
    const { eq } = await import('drizzle-orm')
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, first.job.firstRunId!))
    expect(run?.snapshot.mapJob?.purpose).toBe('map_probe')
    expect(run?.snapshot.allowedOrigins).toEqual(['https://shop.example'])
    expect(run?.snapshot.mapConsumption).toEqual({ mode: 'off' })
    expect(run?.snapshot.mapCapturePolicy?.enabled).toBe(true)
    expect(run?.snapshot.accessPolicy).toBeTruthy()
    await cancelMapJob(handle.db, other.job.jobId, actor())
  })

  it('OMG05 同键用户 Run 可领取时跳过地图片；无作业协议的 Worker 也不领', async () => {
    const { targetId, accountId } = await freshTarget()
    const capable = await readyWorker(`c${targetId.slice(0, 6)}`, [MAP_JOBS_PROTOCOL])
    const legacy = await readyWorker(`l${targetId.slice(0, 6)}`, [])
    const session = await prepareSession(targetId, accountId, capable.workerId, capable.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const job = await createMapJob(
      handle.db,
      targetId,
      {
        manualId: `yield-${targetId}`.slice(0, 32),
        expectedPolicyRevision: 1,
        jobKind: 'map_probe',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: probeSteps() },
    )
    const { browserSessions } = schemaFor(handle.db)
    const { eq } = await import('drizzle-orm')
    const now = new Date()
    await handle.db
      .update(browserSessions)
      .set({ status: 'CLOSED', closedAt: now, closeReason: 'cleanup', updatedAt: now })
      .where(eq(browserSessions.id, session.id))
    const { runs, workers } = schemaFor(handle.db)
    const [jobRun] = await handle.db.select().from(runs).where(eq(runs.id, job.job.firstRunId!))
    expect(jobRun?.snapshot.mapJob?.jobId).toBe(job.job.jobId)
    expect(isMapJobRun(jobRun!.snapshot)).toBe(true)
    const [legacyRow] = await handle.db.select().from(workers).where(eq(workers.id, legacy.workerId))
    expect(legacyRow?.protocolCapabilities).toEqual([SESSION_OCCUPANCY_PROTOCOL])
    async function claimUntil(
      worker: { workerId: string; instanceId: string },
      stop: (runId: string) => boolean,
    ) {
      for (let i = 0; i < 16; i += 1) {
        const grant = await claimRun(handle, {
          workerId: worker.workerId,
          instanceId: worker.instanceId,
          leaseTtlSeconds: 60,
        })
        if (!grant || stop(grant.runId)) return grant
      }
      return null
    }

    const skipped = await claimUntil(legacy, (runId) => runId === job.job.firstRunId)
    expect(skipped).toBeNull()
    const userScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `用户-${newId().slice(0, 8)}`,
      actor: { kind: 'console', id: actorId },
      steps: probeSteps(),
    })
    const userRun = await createRunWithSnapshot(handle.db, {
      scenarioId: userScenario.id,
      targetAccountId: accountId,
      actor: { kind: 'console', id: actorId },
    })
    const yielded = await claimUntil(
      capable,
      (runId) => runId === userRun.detail.id || runId === job.job.firstRunId,
    )
    expect(yielded?.runId).toBe(userRun.detail.id)
    expect(yielded?.runId).not.toBe(job.job.firstRunId)
  })

  it('OMH08 startBefore 到期后 claim 跳过地图片', async () => {
    const { targetId, accountId } = await freshTarget()
    const capable = await readyWorker(`s${targetId.slice(0, 6)}`, [MAP_JOBS_PROTOCOL])
    await prepareSession(targetId, accountId, capable.workerId, capable.instanceId)
    await enableJobs(targetId)
    const entry = await addEntry(targetId)
    const job = await createMapJob(
      handle.db,
      targetId,
      {
        source: 'scheduled',
        occurrenceId: newId(),
        startBefore: new Date(Date.now() - 1000).toISOString(),
        expectedPolicyRevision: 1,
        jobKind: 'map_refresh',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: probeSteps() },
    )
    const grant = await claimRun(handle, {
      workerId: capable.workerId,
      instanceId: capable.instanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId ?? null).not.toBe(job.job.firstRunId)
  })
})
