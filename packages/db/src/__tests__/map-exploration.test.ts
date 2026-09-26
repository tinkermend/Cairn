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
  getTargetStateRule,
  upsertTargetStateRule,
  getExploreEntryRequestProfile,
  upsertExploreEntryRequestProfile,
  listExploreStateRecipes,
  getExploreStateRecipe,
  createExploreStateRecipe,
  reviewExploreStateRecipe,
  acquireRecipeUsage,
  listExploreCandidates,
  getExploreCandidate,
  reviewExploreCandidate,
  consumeExploreCandidateReview,
  listExploreTraversals,
  reviewUnknownExploreJob,
  recordExploreState,
  recordExploreDiscoveries,
  recordExploreTraversal,
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

  it('EX-D01/D02/D03 候选线索收集、三级状态建模与存证', async () => {
    const { targetId, accountId } = await freshTarget()
    await enableFactory()
    const explore = await enableExplore(targetId)
    const entry = await addEntry(targetId)
    const worker = await readyWorker(`${targetId.slice(0, 6)}d`, [MAP_JOBS_PROTOCOL, MAP_EXPLORE_PROTOCOL])
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)

    const job = await createMapJob(
      handle.db,
      targetId,
      {
        source: 'explore',
        manualId: `discover-${targetId}`.slice(0, 32),
        expectedPolicyRevision: 0,
        expectedExplorationRevision: explore.revision,
        jobKind: 'map_explore',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: exploreSteps() },
    )

    // 1. 存入 ExploreState
    const stateId = await recordExploreState(handle.db, {
      targetId,
      targetAccountId: accountId,
      jobId: job.job.jobId,
      pageKey: 'page:https://shop.example/orders',
      viewStateKey: 'view:orders_list',
      presentationStateKey: 'pres:orders_tab_active',
      snapshotData: { title: '订单列表' },
    })
    expect(stateId).toBeDefined()

    // 2. 存入一批发现线索（包括正常链接、展开控件、以及带拒绝原因的写操作）
    const [candidateId1, candidateId2, candidateId3] = await recordExploreDiscoveries(handle.db, [
      {
        targetId,
        jobId: job.job.jobId,
        runId: job.job.firstRunId!,
        sourceExploreStateId: stateId,
        sourcePresentationStateKey: 'pres:orders_tab_active',
        controlFingerprint: 'fp-link-details',
        accessibleName: '查看详情',
        role: 'link',
        ancestorPath: ['table', 'tbody', 'tr', 'td'],
        candidateCategory: 'explicit_url',
        targetUrl: 'https://shop.example/orders/101',
        targetHint: '/orders/101',
        collectorVersion: 1,
        evidenceStatus: 'complete',
      },
      {
        targetId,
        jobId: job.job.jobId,
        runId: job.job.firstRunId!,
        sourceExploreStateId: stateId,
        sourcePresentationStateKey: 'pres:orders_tab_active',
        controlFingerprint: 'fp-btn-expand',
        accessibleName: '展开高级筛选',
        role: 'button',
        ancestorPath: ['div', 'form'],
        candidateCategory: 'reveal',
        targetHint: '展开筛选面板',
        collectorVersion: 1,
        evidenceStatus: 'complete',
      },
      {
        targetId,
        jobId: job.job.jobId,
        runId: job.job.firstRunId!,
        sourceExploreStateId: stateId,
        sourcePresentationStateKey: 'pres:orders_tab_active',
        controlFingerprint: 'fp-btn-delete',
        accessibleName: '删除订单',
        role: 'button',
        ancestorPath: ['div'],
        candidateCategory: 'opaque_navigation',
        targetHint: '删除',
        collectorVersion: 1,
        evidenceStatus: 'complete',
        rejectionReason: '名称像破坏性动作',
      },
    ])

    // 查询验证
    const candidates = await listExploreCandidates(handle.db, targetId, job.job.jobId)
    expect(candidates.items).toHaveLength(3)
    expect(candidates.totalGaps).toBe(1) // candidateId3 带有 rejectionReason

    const singleCand = await getExploreCandidate(handle.db, targetId, job.job.jobId, candidateId1)
    expect(singleCand.accessibleName).toBe('查看详情')
    expect(singleCand.status).toBe('discovered')
    await disableFactory()
  })

  it('EX-S01 状态配方创建、审核与使用配额递减', async () => {
    const { targetId, accountId } = await freshTarget()
    const entry = await addEntry(targetId)

    const createdRecipe = await createExploreStateRecipe(
      handle.db,
      targetId,
      {
        idempotencyKey: `recipe-key-${newId()}`,
        targetAccountId: accountId,
        safeEntryId: entry.entryId,
        recipeName: '直达已归档订单',
        steps: [
          {
            stepOrdinal: 0,
            name: '点击归档标签',
            actionKind: 'ui_navigate',
            postStateAssertion: { selector: '.archived-list' },
            requestEnvelope: [],
          },
        ],
        safetyBasisKind: 'manual_verification',
        safetySummary: '已人工复核标签切换为只读状态',
        isManualSeed: true,
        timeoutSeconds: 60,
      },
      actor(),
    )
    expect(createdRecipe.status).toBe('pending_review')

    // 审核配方
    const reviewedRecipe = await reviewExploreStateRecipe(
      handle.db,
      targetId,
      createdRecipe.recipeId,
      {
        expectedRevision: createdRecipe.revision,
        decision: 'approved',
        reason: '复核通过，允许回放 3 次',
        usageLimit: 3,
      },
      actor(),
    )
    expect(reviewedRecipe.status).toBe('approved')
    expect(reviewedRecipe.usageRemaining).toBe(3)

    // 消耗配额
    const ok1 = await acquireRecipeUsage(handle.db, createdRecipe.recipeId)
    const ok2 = await acquireRecipeUsage(handle.db, createdRecipe.recipeId)
    const ok3 = await acquireRecipeUsage(handle.db, createdRecipe.recipeId)
    const ok4 = await acquireRecipeUsage(handle.db, createdRecipe.recipeId)

    expect(ok1).toBe(true)
    expect(ok2).toBe(true)
    expect(ok3).toBe(true)
    expect(ok4).toBe(false) // 配额耗尽
  })

  it('EX-S02/EX-A01~A05 候选审核、配额核销与单跳限制', async () => {
    const { targetId, accountId } = await freshTarget()
    await enableFactory()
    const explore = await enableExplore(targetId)
    const entry = await addEntry(targetId)
    const worker = await readyWorker(`${targetId.slice(0, 6)}s`, [MAP_JOBS_PROTOCOL, MAP_EXPLORE_PROTOCOL])
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)

    const job = await createMapJob(
      handle.db,
      targetId,
      {
        source: 'explore',
        manualId: `onehop-${targetId}`.slice(0, 32),
        expectedPolicyRevision: 0,
        expectedExplorationRevision: explore.revision,
        jobKind: 'map_explore',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: exploreSteps() },
    )

    const [candId] = await recordExploreDiscoveries(handle.db, [
      {
        targetId,
        jobId: job.job.jobId,
        runId: job.job.firstRunId!,
        sourcePresentationStateKey: 'pres:home',
        controlFingerprint: 'fp-menu-billing',
        accessibleName: '账单概览',
        role: 'link',
        ancestorPath: ['nav'],
        candidateCategory: 'explicit_url',
        targetUrl: 'https://shop.example/billing',
        targetHint: '/billing',
        collectorVersion: 1,
        evidenceStatus: 'complete',
      },
    ])

    // 审核候选
    const review = await reviewExploreCandidate(
      handle.db,
      targetId,
      job.job.jobId,
      candId,
      {
        expectedRevision: 0,
        idempotencyKey: `cand-rev-${candId}`,
        decision: 'approved',
        actionCategory: 'direct_url_open',
        securityBasis: '人工复核只读账单链接',
        requestEnvelope: [],
        validDurationHours: 12,
      },
      actor(),
    )
    expect(review.decision).toBe('approved')
    expect(review.quotaRemaining).toBe(1)

    // 第一次消费配额执行 -> 成功
    const consumed = await consumeExploreCandidateReview(
      handle.db,
      targetId,
      job.job.jobId,
      candId,
      review.expectedRevision,
    )
    expect(consumed.review.id).toBe(review.id)
    expect(consumed.parentJob.entryId).toBe(entry.entryId)

    // 第二次尝试消费同一次审核配额 -> 报错配额耗尽
    await expect(
      consumeExploreCandidateReview(
        handle.db,
        targetId,
        job.job.jobId,
        candId,
        review.expectedRevision,
      ),
    ).rejects.toMatchObject({ code: 'MAP_REVIEW_QUOTA_EXHAUSTED' })

    // 记录 Traversal
    const traversalId = newId()
    await recordExploreTraversal(handle.db, {
      id: traversalId,
      targetId,
      jobId: job.job.jobId,
      runId: job.job.firstRunId!,
      discoveryId: candId,
      reviewId: review.id,
      actionCategory: 'direct_url_open',
      relationType: 'link_observed',
      fromPresentationStateKey: 'pres:home',
      toPresentationStateKey: 'pres:billing',
      guardDecision: 'allow',
      guardReason: 'allowlist 允许访问',
      actionOutcome: 'completed',
      locationVerify: 'support',
      actionVerify: 'support',
      pageChangeVerify: 'support',
      evidenceStatus: 'complete',
    })

    const traversals = await listExploreTraversals(handle.db, targetId, job.job.jobId)
    expect(traversals).toHaveLength(1)
    expect(traversals[0].actionOutcome).toBe('completed')
    expect(traversals[0].promoted).toBe(false) // 绝不自动提拔
    await disableFactory()
  })

  it('EX-U01 未知动作结果人工核查与锁释放', async () => {
    const { targetId, accountId } = await freshTarget()
    await enableFactory()
    const explore = await enableExplore(targetId)
    const entry = await addEntry(targetId)
    const worker = await readyWorker(`${targetId.slice(0, 6)}u`, [MAP_JOBS_PROTOCOL, MAP_EXPLORE_PROTOCOL])
    await prepareSession(targetId, accountId, worker.workerId, worker.instanceId)

    const job = await createMapJob(
      handle.db,
      targetId,
      {
        source: 'explore',
        manualId: `unknown-${targetId}`.slice(0, 32),
        expectedPolicyRevision: 0,
        expectedExplorationRevision: explore.revision,
        jobKind: 'map_explore',
        targetAccountId: accountId,
        entryId: entry.entryId,
      },
      actor(),
      { steps: exploreSteps() },
    )

    // 模拟运行产生 unknown 结果并置 job 为 needs_review
    const { mapJobs } = schemaFor(handle.db)
    await handle.db
      .update(mapJobs)
      .set({ jobStatus: 'needs_review', stopReason: 'action_outcome_unknown' })
      .where(eq(mapJobs.id, job.job.jobId))

    // 人工核查判定为 failed
    const res = await reviewUnknownExploreJob(
      handle.db,
      targetId,
      job.job.jobId,
      {
        decision: 'failed',
        reason: '页面未跳转且无明显内容变化，人工判定动作失效',
      },
      actor(),
    )
    expect(res.status).toBe('failed')

    // 验证 activeGuard 已被清除，且 jobStatus 变为 failed
    const [updatedJob] = await handle.db.select().from(mapJobs).where(eq(mapJobs.id, job.job.jobId))
    expect(updatedJob.jobStatus).toBe('failed')
    expect(updatedJob.activeGuard).toBeNull()
    await disableFactory()
  })
})
