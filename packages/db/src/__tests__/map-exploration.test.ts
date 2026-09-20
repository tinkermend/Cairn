import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAP_EXPLORE_PROTOCOL, MAP_JOBS_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createMapJob,
  createMapSafeEntry,
  getExplorationPolicy,
  registerWorker,
  requireCreatedSession,
  setSessionProbe,
  setSessionStatus,
  updateExplorationPolicy,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function exploreSteps(): Step[] {
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
      input: {
        target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
        expect: { kind: 'visible' },
      },
    },
    {
      id: newId(),
      name: '观察',
      type: 'map_observe',
      effectType: 'READ_ONLY',
      outputKey: 'explore_observation',
      input: { mode: 'allowlist', allowlist: [{ origin: 'https://shop.example' }], seedUrls: [] },
    },
    {
      id: newId(),
      name: '提名',
      type: 'map_propose',
      effectType: 'READ_ONLY',
      outputKey: 'explore_proposal',
      input: { from: 'explore_observation' },
    },
    {
      id: newId(),
      name: '守卫',
      type: 'map_guarded_action',
      effectType: 'READ_ONLY',
      outputKey: 'explore_action',
      input: { from: 'explore_proposal' },
    },
    {
      id: newId(),
      name: '核验',
      type: 'map_verify',
      effectType: 'READ_ONLY',
      outputKey: 'explore_verification',
      input: { from: 'explore_action', observationFrom: 'explore_observation' },
    },
  ]
}

describe.each(DRIVERS)('%s 有界探索账本', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_omi_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-omi',
      email: `map-omi-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function freshTarget() {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `omi-${targetId}`,
      name: '探索夹具',
      entryUrl: 'https://shop.example/home',
      loginUrl: 'https://idp.example/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '探索账号',
      username: `ops-${accountId}`,
      status: 'active',
      usage: 'both',
      mapUsageGuard: 'Y',
    })
    return { targetId, accountId }
  }

  async function readyWorker(suffix: string, capabilities: string[]) {
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId: `omi-w-${suffix}`,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, ...capabilities],
    })
    return { workerId: `omi-w-${suffix}`, instanceId }
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
    await handle.db.update(browserSessions).set({ observedTier: 'LOGIN_VERIFIED' }).where(eq(browserSessions.id, session.id))
    return session
  }

  async function enableFactory() {
    const current = await getOrCreatePlatformConfig(handle.db)
    if (current.document.mapExplorationEnabled) return
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '夹具开放探索',
      document: { ...current.document, mapExplorationEnabled: true },
      actor: { id: actorId },
    })
  }

  async function disableFactory() {
    const current = await getOrCreatePlatformConfig(handle.db)
    if (!current.document.mapExplorationEnabled) return
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '夹具关闭探索',
      document: { ...current.document, mapExplorationEnabled: false },
      actor: { id: actorId },
    })
  }

  async function enableExplore(targetId: string) {
    return updateExplorationPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `explore:${targetId}`.slice(0, 128),
        exploreEnabled: true,
        mode: 'allowlist',
        modelEnabled: false,
        allowlist: [{ origin: 'https://shop.example', pathPrefix: '/orders' }],
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
        idempotencyKey: `explore-entry:${targetId}`.slice(0, 128),
        name: '订单入口',
        url: 'https://shop.example/orders',
        arrivalName: '订单标题',
        arrivalTarget: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
        safetyBasisKind: 'confirmed_path',
        summary: '只读探索已确认路径',
        jobKinds: ['map_explore'],
      },
      actor(),
    )
  }

  it('OMI01 工厂与目标默认关闭，不能建探索作业', async () => {
    const { targetId, accountId } = await freshTarget()
    const policy = await getExplorationPolicy(handle.db, targetId)
    expect(policy.policy.exploreEnabled).toBe(false)
    expect(policy.revision).toBe(0)
    const entry = await addEntry(targetId)
    await expect(
      createMapJob(
        handle.db,
        targetId,
        {
          source: 'explore',
          manualId: `closed-${targetId}`.slice(0, 32),
          expectedPolicyRevision: 0,
          expectedExplorationRevision: 0,
          jobKind: 'map_explore',
          targetAccountId: accountId,
          entryId: entry.entryId,
        },
        actor(),
        { steps: exploreSteps() },
      ),
    ).rejects.toMatchObject({ code: 'MAP_FORBIDDEN' })
  })

  it('OMI12 打开后无探索协议 Worker 仍不可创建', async () => {
    const { targetId, accountId } = await freshTarget()
    await enableFactory()
    const explore = await enableExplore(targetId)
    const entry = await addEntry(targetId)
    const worker = await readyWorker(targetId.slice(0, 8), [MAP_JOBS_PROTOCOL])
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    await expect(
      createMapJob(
        handle.db,
        targetId,
        {
          source: 'explore',
          manualId: `noworker-${targetId}`.slice(0, 32),
          expectedPolicyRevision: 0,
          expectedExplorationRevision: explore.revision,
          jobKind: 'map_explore',
          targetAccountId: accountId,
          entryId: entry.entryId,
        },
        actor(),
        { steps: exploreSteps() },
      ),
    ).rejects.toMatchObject({ code: 'MAP_CONSUMER_UNAVAILABLE' })
    await disableFactory()
  })

  it('准入齐全时创建首片且 continue 不续跑', async () => {
    const { targetId, accountId } = await freshTarget()
    await enableFactory()
    const explore = await enableExplore(targetId)
    const entry = await addEntry(targetId)
    const worker = await readyWorker(`${targetId.slice(0, 6)}x`, [MAP_JOBS_PROTOCOL, MAP_EXPLORE_PROTOCOL])
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)
    const created = await createMapJob(
      handle.db,
      targetId,
      {
        source: 'explore',
        manualId: `ok-${targetId}`.slice(0, 32),
        expectedPolicyRevision: 0,
        expectedExplorationRevision: explore.revision,
        jobKind: 'map_explore',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: exploreSteps() },
    )
    expect(created.created).toBe(true)
    expect(created.job.jobKind).toBe('map_explore')
    expect(created.job.slices).toHaveLength(1)
    await disableFactory()
  })

  it('LEGACY 已登录会话可以创建探索作业', async () => {
    const { targetId, accountId } = await freshTarget()
    await enableFactory()
    const explore = await enableExplore(targetId)
    const entry = await addEntry(targetId)
    const worker = await readyWorker(`${targetId.slice(0, 6)}L`, [MAP_JOBS_PROTOCOL, MAP_EXPLORE_PROTOCOL])
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
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
      ownerWorkerId: worker.workerId,
      ownerWorkerInstanceId: worker.instanceId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    const { browserSessions } = schemaFor(handle.db)
    await handle.db.update(browserSessions).set({ observedTier: 'LEGACY' }).where(eq(browserSessions.id, session.id))
    const created = await createMapJob(
      handle.db,
      targetId,
      {
        source: 'explore',
        manualId: `legacy-${targetId}`.slice(0, 32),
        expectedPolicyRevision: 0,
        expectedExplorationRevision: explore.revision,
        jobKind: 'map_explore',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: exploreSteps() },
    )
    expect(created.created).toBe(true)
    expect(created.job.jobKind).toBe('map_explore')
    await disableFactory()
  })
})
