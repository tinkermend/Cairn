import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SESSION_OCCUPANCY_PROTOCOL,
  MAP_ASSETS_PROTOCOL,
  MAP_CONSUMPTION_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  mapListQuerySchema,
  mapObservationShell,
  type MapConditionSnapshot,
  type MapProjectionPlan,
  type Step,
} from '@cairn/shared'
import { newId } from '../id.js'
import { eq } from 'drizzle-orm'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  DomainError,
  claimRun,
  loadFrozenMapCandidates,
  upsertMapScenarioBinding,
  appendMapSelectionDecision,
  appendMapObservation,
  appendMapVerification,
  commitMapProjectionBatch,
  createRunWithSnapshot,
  createScenarioWithVersion,
  ensureMapProjection,
  getMapConsumptionPolicy,
  getRun,
  grantMapConsumptionEligibility,
  listMapAssets,
  listMapSelectionDecisions,
  loadMapProjectionState,
  registerWorker,
  sealAndPublishMapRelease,
  updateMapConsumptionPolicy,
  withdrawMapRelease,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function emptyPlan(nextCursor: number, overrides: Partial<MapProjectionPlan> = {}): MapProjectionPlan {
  return {
    protocol: MAP_ASSETS_PROTOCOL,
    algorithmVersion: MAP_IDENTITY_RULE_VERSION,
    pages: [],
    objects: [],
    assignments: [],
    implementations: [],
    descriptors: [],
    assets: [],
    conflicts: [],
    nextCursor,
    ...overrides,
  }
}

function condition(targetId: string): MapConditionSnapshot {
  return {
    targetId,
    accountBinding: { presence: 'anonymous' },
    unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
  }
}

function extractStep(id: string): Step {
  return {
    id,
    name: '提取标题',
    type: 'extract',
    effectType: 'READ_ONLY',
    outputKey: 'title',
    input: {
      target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
      as: 'text',
    },
  }
}

describe.each(DRIVERS)('%s 地图运行消费', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_omf_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-omf',
      email: `map-omf-${actorId}@example.com`,
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
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `omf-${id}`,
      name: '消费夹具',
      entryUrl: 'https://shop.example',
    })
    return id
  }

  async function seedAndPublish(targetId: string) {
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    const pageKey = `page:v1:top:omf:top`
    const objectKey = `object:v1:omf-title`
    const implKey = `impl:v1:omf`
    await commitMapProjectionBatch(handle.db, {
      projectionId: projection.id,
      expectedCursor: state.cursor,
      expectedRevision: state.revision,
      plan: emptyPlan(state.cursor + 1, {
        pages: [
          {
            kind: 'top',
            allocationKey: pageKey,
            routeTemplate: 'https://shop.example/orders',
            frameKey: 'top',
            reasons: ['allocation-key'],
            matchResult: 'MATCH',
          },
        ],
        objects: [
          {
            allocationKey: objectKey,
            pageAllocationKey: pageKey,
            regionKey: 'action',
            stableToken: 'title',
            reasons: ['allocation-key'],
            matchResult: 'MATCH',
          },
        ],
        implementations: [{ objectAllocationKey: objectKey, implementationKey: implKey, condition: condition(targetId) }],
        descriptors: [
          {
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            features: {
              semanticName: '订单标题',
              locators: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '单据' }] },
            },
            condition: condition(targetId),
          },
        ],
        assets: [
          {
            pageAllocationKey: pageKey,
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            lifecycle: 'VERIFIED',
            importance: 0,
            executable: true,
            rejectReasons: [],
            dimensions: [
              { dimension: 'locator', verdict: 'confirmed', confirmedCount: 1, rejectedCount: 0, unknownCount: 0 },
            ],
            sampleCount: 1,
            changeCount: 1,
          },
        ],
      }),
    })
    const listed = await listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({}))
    const item = listed.items[0]
    if (!item) throw new Error('没有对象')
    const ready = await loadMapProjectionState(handle.db, projection.id)
    const published = await sealAndPublishMapRelease(
      handle.db,
      targetId,
      {
        projectionId: projection.id,
        expectedProjectionRevision: ready.revision,
        expectedPublicationRevision: 0,
        idempotencyKey: `cmd:omf-pub-${targetId}`.slice(0, 192),
        reason: '发布消费夹具',
      },
      actor(),
    )
    return { item, published }
  }

  async function readyWorker(suffix: string, capabilities: string[]) {
    const workerId = `omf-w-${suffix}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 2,
      lostAfterSeconds: 3600,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, ...capabilities],
    })
    return { workerId, instanceId }
  }

  it('默认政策关闭，新 Run 写入 mode=off 且不读发布版', async () => {
    const targetId = await freshTarget()
    const policy = await getMapConsumptionPolicy(handle.db, targetId)
    expect(policy.policy.mode).toBe('off')
    expect(policy.revision).toBe(0)
    const step = extractStep(newId())
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `关闭-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [step],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.mapConsumption).toEqual({ mode: 'off' })
    const { mapRunReleaseRefs } = schemaFor(handle.db)
    const refs = await handle.db.select().from(mapRunReleaseRefs)
    expect(refs.filter((row) => row.runId === created.detail.id)).toEqual([])
  })

  it('无资格不能打开 read_only_fallback；shadow 需要 Worker 能力才能创建启用 Run', async () => {
    const targetId = await freshTarget()
    await expect(
      updateMapConsumptionPolicy(
        handle.db,
        targetId,
        {
          expectedRevision: 0,
          idempotencyKey: `policy:fallback-${targetId}`.slice(0, 128),
          mode: 'read_only_fallback',
          reason: '未验证就打开',
        },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'MAP_CONSUMPTION_NOT_ELIGIBLE' })
    const updated = await updateMapConsumptionPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `policy:shadow-${targetId}`.slice(0, 128),
        mode: 'shadow',
        reason: '只比较',
      },
      actor(),
    )
    expect(updated.policy.mode).toBe('shadow')
    await seedAndPublish(targetId)
    const step = extractStep(newId())
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `影子-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [step],
    })
    await expect(
      createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'MAP_CONSUMER_UNAVAILABLE' })
    await readyWorker(targetId.slice(0, 8), [MAP_CONSUMPTION_PROTOCOL])
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.mapConsumption?.mode).toBe('shadow')
    expect(created.detail.snapshot.mapConsumption && 'releaseId' in created.detail.snapshot.mapConsumption
      ? created.detail.snapshot.mapConsumption.releaseId
      : null).toBeTruthy()
  })

  it('OMF02 撤回后不能再冻结该版；已创建 Run 摘要不变', async () => {
    const targetId = await freshTarget()
    const { published } = await seedAndPublish(targetId)
    await updateMapConsumptionPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `policy:sh2-${targetId}`.slice(0, 128),
        mode: 'shadow',
        reason: '比较',
      },
      actor(),
    )
    await readyWorker(`b${targetId.slice(0, 6)}`, [MAP_CONSUMPTION_PROTOCOL])
    const step = extractStep(newId())
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `固定-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [step],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const digest = created.detail.snapshot.digest
    await withdrawMapRelease(
      handle.db,
      targetId,
      published.release.releaseId,
      { expectedPublicationRevision: 1, idempotencyKey: `cmd:wd-${targetId}`.slice(0, 192), reason: '撤回' },
      actor(),
    )
    expect(created.detail.snapshot.digest).toBe(digest)
    await expect(
      createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        actor: { id: actorId },
        mapConsumption: { releaseId: published.release.releaseId },
      }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('OMF09/10 选择记录幂等，失效租约不能写入', async () => {
    const targetId = await freshTarget()
    const step = extractStep(newId())
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `决策-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [step],
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const stepRun = created.detail.stepRuns[0]!
    const { attempts } = schemaFor(handle.db)
    const attemptId = newId()
    await handle.db.insert(attempts).values({
      id: attemptId,
      stepRunId: stepRun.id,
      attemptNo: 1,
      status: 'RUNNING',
      startedAt: new Date(),
    })
    const decision = {
      decisionId: newId(),
      runId: created.detail.id,
      stepRunId: stepRun.id,
      attemptId,
      decisionOrdinal: 0,
      targetId,
      baselineOutcome: 'FOUND',
      candidatesEvaluated: [],
      mode: 'off' as const,
      decision: 'baseline' as const,
      reasonCode: 'BASELINE_FOUND' as const,
      spentMs: 3,
      extraAiCalls: 0 as const,
      evidenceRefs: [],
    }
    await expect(
      appendMapSelectionDecision(handle.db, {
        grant: {
          runId: created.detail.id,
          leaseId: newId(),
          fencingToken: 1,
          holderWorkerId: 'missing',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        decision,
      }),
    ).rejects.toMatchObject({ code: 'MAP_FACT_STALE_OWNER' })
    const listed = await listMapSelectionDecisions(handle.db, created.detail.id, { limit: 20 })
    expect(listed.items).toEqual([])
  })

  it('政策 OCC 冲突，资格后可以写 fallback 政策', async () => {
    const targetId = await freshTarget()
    await updateMapConsumptionPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `policy:off-${targetId}`.slice(0, 128),
        mode: 'off',
        reason: '保持关闭',
      },
      actor(),
    )
    await expect(
      updateMapConsumptionPolicy(
        handle.db,
        targetId,
        {
          expectedRevision: 0,
          idempotencyKey: `policy:stale-${targetId}`.slice(0, 128),
          mode: 'shadow',
          reason: '旧修订',
        },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'MAP_REVISION_CONFLICT' })
    await grantMapConsumptionEligibility(handle.db, { targetId, reportId: `omt-omf-${targetId.slice(0, 8)}` })
    const opened = await updateMapConsumptionPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 1,
        idempotencyKey: `policy:ro-${targetId}`.slice(0, 128),
        mode: 'read_only_fallback',
        reason: '夹具资格',
      },
      actor(),
    )
    expect(opened.policy.mode).toBe('read_only_fallback')
    expect(opened.eligibility?.reportId).toContain('omt-omf')
  })
  it('同键并发政策命令可重放，跨 Target 白名单被拒绝', async () => {
    const targetId = await freshTarget()
    const body = { expectedRevision: 0, idempotencyKey: `concurrent:${newId()}`, mode: 'shadow' as const, reason: '并发重放' }
    const results = await Promise.all([updateMapConsumptionPolicy(handle.db, targetId, body, actor()), updateMapConsumptionPolicy(handle.db, targetId, body, actor())])
    expect(results[0]).toEqual(results[1])
    expect(results[0]!.revision).toBe(1)
    await expect(updateMapConsumptionPolicy(handle.db, targetId, { ...body, expectedRevision: 1,
      idempotencyKey: `cross:${newId()}`, allowedAssetRefs: [{ targetId: newId(), objectId: newId() }] }, actor())).rejects.toMatchObject({ code: 'MAP_TARGET_MISMATCH' })
  })

  async function enabledRun(mode: 'shadow' | 'read_only_fallback' = 'shadow') {
    const targetId = await freshTarget()
    const { item } = await seedAndPublish(targetId)
    const worker = await readyWorker(newId(), [MAP_CONSUMPTION_PROTOCOL])
    if (mode === 'read_only_fallback') {
      await grantMapConsumptionEligibility(handle.db, { targetId, reportId: `omt-feedback-${newId()}` })
    }
    await updateMapConsumptionPolicy(handle.db, targetId, { expectedRevision: 0,
      idempotencyKey: `enabled:${newId()}`, mode, reason: '边界验证' }, actor())
    const step = extractStep(newId())
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `boundary-${newId()}`, actor: { id: actorId }, steps: [step] })
    await upsertMapScenarioBinding(handle.db, targetId, { scenarioId: scenario.id, scenarioVersionId: scenario.latestVersionId,
      stepId: step.id, expectedDraftRevision: scenario.draft!.revision, assetRef: item.assetRef, basis: 'explicit_user', scopeKind: 'version' }, actor())
    const created = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
    const frozen = created.detail.snapshot.mapConsumption!
    if (frozen.mode === 'off') throw new Error('expected enabled snapshot')
    expect(frozen.bindings).toHaveLength(1)
    return { targetId, created, frozen, worker, scenario, step }
  }

  it('发布内容被修改但存储摘要未更新时，冻结和消费都拒绝', async () => {
    const { frozen, scenario, step } = await enabledRun()
    expect((await loadFrozenMapCandidates(handle.db, frozen, step.id)).candidates).toHaveLength(1)
    const { mapReleases } = schemaFor(handle.db)
    const [release] = await handle.db.select().from(mapReleases).where(eq(mapReleases.id, frozen.releaseId))
    await handle.db.update(mapReleases).set({ manifest: { ...release!.manifest, items: [] } }).where(eq(mapReleases.id, frozen.releaseId))
    expect(await loadFrozenMapCandidates(handle.db, frozen, step.id)).toEqual({ digestOk: false, candidates: [] })
    await expect(createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })).rejects.toMatchObject({ code: 'MAP_RELEASE_NOT_PUBLISHED' })
  })

  it('确认错配保留反证并冻结新的 read_only_fallback，新的独立资格才可恢复', async () => {
    const { targetId, created, frozen, worker, scenario, step } = await enabledRun('read_only_fallback')
    const { attempts, runs } = schemaFor(handle.db)
    const otherRuns = await handle.db.select({ id: runs.id }).from(runs)
    const grant = await claimRun(handle, {
      ...worker, leaseTtlSeconds: 120, excludeRunIds: otherRuns.filter(row => row.id !== created.detail.id).map(row => row.id),
    })
    expect(grant?.runId).toBe(created.detail.id)
    const stepRun = created.detail.stepRuns[0]!
    const attemptId = newId()
    await handle.db.insert(attempts).values({ id: attemptId, stepRunId: stepRun.id, attemptNo: 1, status: 'RUNNING', startedAt: new Date() })
    const decisionId = newId()
    await appendMapSelectionDecision(handle.db, {
      grant: grant!,
      decision: {
        decisionId, runId: created.detail.id, stepRunId: stepRun.id, attemptId, decisionOrdinal: 0,
        targetId, releaseId: frozen.releaseId, manifestDigest: frozen.manifestDigest,
        policyVersion: frozen.policy.policyVersion, consumerVersion: frozen.consumerVersion,
        assetRef: frozen.bindings[0]!.assetRef, baselineOutcome: 'TARGET_NOT_FOUND', candidatesEvaluated: [],
        mode: 'read_only_fallback', decision: 'selected', reasonCode: 'FALLBACK_USED', spentMs: 1,
        extraAiCalls: 0, evidenceRefs: [],
      },
    })
    const observation = mapObservationShell({
      id: newId(), targetId, sourceType: 'user_confirmed',
      sourceRef: { sourceType: 'user_confirmed', actorId, decisionId, scope: 'omf-review' },
      phase: 'before_action', dedupeKey: `obs:wrong:${newId()}`, captureStatus: 'observed',
    })
    await appendMapObservation(handle.db, { caller: { kind: 'console', actorId }, observation })
    await appendMapVerification(handle.db, {
      caller: { kind: 'console', actorId },
      verification: {
        id: newId(), schemaVersion: 1, targetId, dedupeKey: `ver:wrong:${newId()}`,
        observationIds: [observation.id], dimension: 'identity', verdict: 'rejected',
        claim: { proposition: '已确认候选指向错误业务记录' }, evidenceRefs: [],
        evaluatedAt: new Date().toISOString(), evaluatorVersion: 'map-review@1',
        verificationSource: { kind: 'user_confirmed', actorId, decisionId,
          sourceEventKey: `review:${decisionId}`, sourceVersion: 'map-review@1' },
      },
    })
    const closed = await getMapConsumptionPolicy(handle.db, targetId)
    expect(closed.eligibility?.suspendedAt).toBeTruthy()
    await expect(createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })).rejects.toMatchObject({ code: 'MAP_CONSUMPTION_NOT_ELIGIBLE' })
    await grantMapConsumptionEligibility(handle.db, { targetId, reportId: closed.eligibility!.reportId })
    expect((await getMapConsumptionPolicy(handle.db, targetId)).eligibility?.suspendedAt).toBeTruthy()
    await grantMapConsumptionEligibility(handle.db, { targetId, reportId: `omt-regrant-${newId()}` })
    expect((await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })).detail.snapshot.mapConsumption?.mode).toBe('read_only_fallback')
    expect(step.id).toBeTruthy()
  })

  it('真实领取后的决策幂等，过期租约、终态 Attempt、伪造冻结均不能写', async () => {
    const { targetId, created, frozen, worker } = await enabledRun()
    const { runs, attempts, runLeases } = schemaFor(handle.db)
    const all = await handle.db.select({ id: runs.id }).from(runs)
    const grant = await claimRun(handle, { ...worker, leaseTtlSeconds: 120, excludeRunIds: all.filter(row => row.id !== created.detail.id).map(row => row.id) })
    expect(grant?.runId).toBe(created.detail.id)
    const stepRun = created.detail.stepRuns[0]!
    const attemptId = newId()
    await handle.db.insert(attempts).values({ id: attemptId, stepRunId: stepRun.id, attemptNo: 1, status: 'RUNNING', startedAt: new Date() })
    const decision = { decisionId: newId(), runId: created.detail.id, stepRunId: stepRun.id, attemptId,
      decisionOrdinal: 0, targetId, releaseId: frozen.releaseId, manifestDigest: frozen.manifestDigest,
      policyVersion: frozen.policy.policyVersion, consumerVersion: frozen.consumerVersion,
      baselineOutcome: 'FOUND', candidatesEvaluated: [], mode: 'shadow' as const, decision: 'baseline' as const,
      reasonCode: 'BASELINE_FOUND' as const, spentMs: 3, extraAiCalls: 0 as const, evidenceRefs: [] }
    const saved = await appendMapSelectionDecision(handle.db, { grant: grant!, decision })
    expect(await appendMapSelectionDecision(handle.db, { grant: grant!, decision: { ...decision, decisionId: newId() } })).toEqual(saved)
    await expect(appendMapSelectionDecision(handle.db, { grant: grant!, decision: { ...decision, reasonCode: 'NO_BINDING' } })).rejects.toMatchObject({ code: 'MAP_IDEMPOTENCY_CONFLICT' })
    await expect(appendMapSelectionDecision(handle.db, { grant: grant!, decision: { ...decision, decisionId: newId(), decisionOrdinal: 2, manifestDigest: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'MAP_TARGET_MISMATCH' })
    await appendMapSelectionDecision(handle.db, { grant: grant!, decision: { ...decision, decisionId: newId(), decisionOrdinal: 1 } })
    const first = await listMapSelectionDecisions(handle.db, created.detail.id, { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()
    const second = await listMapSelectionDecisions(handle.db, created.detail.id, { limit: 1, cursor: first.nextCursor })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.decisionId).not.toBe(first.items[0]!.decisionId)
    expect(second.nextCursor).toBeUndefined()
    await expect(listMapSelectionDecisions(handle.db, created.detail.id, { limit: 1, cursor: first.nextCursor, stepRunId: newId() })).rejects.toMatchObject({ code: 'MAP_TARGET_MISMATCH' })
    await handle.db.update(runLeases).set({ expiresAt: new Date(0) }).where(eq(runLeases.id, grant!.leaseId))
    await expect(appendMapSelectionDecision(handle.db, { grant: grant!, decision: { ...decision, decisionId: newId(), decisionOrdinal: 2 } })).rejects.toMatchObject({ code: 'MAP_FACT_STALE_OWNER' })
    await handle.db.update(runLeases).set({ expiresAt: new Date(Date.now() + 120_000) }).where(eq(runLeases.id, grant!.leaseId))
    await handle.db.update(attempts).set({ status: 'SUCCEEDED' }).where(eq(attempts.id, attemptId))
    await expect(appendMapSelectionDecision(handle.db, { grant: grant!, decision: { ...decision, decisionId: newId(), decisionOrdinal: 2 } })).rejects.toMatchObject({ code: 'MAP_FACT_STALE_OWNER' })
    expect((await listMapSelectionDecisions(handle.db, created.detail.id, { limit: 20 })).items).toHaveLength(2)
  })

  it('发布撤回与创建并发只会完整冻结或拒绝；旧 Run 不追随发布状态', async () => {
    const { targetId, frozen, scenario, created } = await enabledRun()
    const [run, withdrawal] = await Promise.allSettled([
      createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId }, mapConsumption: { releaseId: frozen.releaseId } }),
      withdrawMapRelease(handle.db, targetId, frozen.releaseId, { expectedPublicationRevision: 1,
        idempotencyKey: `withdraw:${newId()}`, reason: '并发撤回' }, actor()),
    ])
    expect(withdrawal.status).toBe('fulfilled')
    if (run.status === 'fulfilled') {
      expect(run.value.detail.snapshot.mapConsumption).toMatchObject({ releaseId: frozen.releaseId, manifestDigest: frozen.manifestDigest })
      const { mapRunReleaseRefs } = schemaFor(handle.db)
      const refs = await handle.db.select().from(mapRunReleaseRefs).where(eq(mapRunReleaseRefs.runId, run.value.detail.id))
      expect(refs).toHaveLength(1)
    } else expect(run.reason).toMatchObject({ code: 'MAP_RELEASE_WITHDRAWN' })
    expect((await getRun(handle.db, created.detail.id)).snapshot).toEqual(created.detail.snapshot)
  })

  it('不声明消费协议的 Worker 不能领取已启用消费的 Run', async () => {
    const { created } = await enabledRun()
    const worker = await readyWorker(`legacy-${newId()}`, [])
    const { runs } = schemaFor(handle.db)
    const all = await handle.db.select({ id: runs.id }).from(runs)
    const grant = await claimRun(handle, { ...worker, leaseTtlSeconds: 120,
      excludeRunIds: all.filter(row => row.id !== created.detail.id).map(row => row.id) })
    expect(grant).toBeNull()
  })

})
