import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  mapListQuerySchema,
  normalizeAuthoringDocument,
  type MapProjectionPlan,
  type MapConditionSnapshot,
  type Step,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  applyMapGovernanceCommand,
  commitMapProjectionBatch,
  createScenarioWithVersion,
  DomainError,
  ensureMapProjection,
  getMapSummary,
  getMapAssetDetail,
  getMapReleasePublication,
  publishMapRelease,
  loadTargetScanSource,
  listMapReferenceScanWork,
  removeMapScenarioBinding,
  listMapAssets,
  loadMapImpactSource,
  listMapReferences,
  loadMapProjectionState,
  previewMapGovernance,
  publishScenarioDraft,
  saveScenarioDraft,
  sealAndPublishMapRelease,
  startMapReferenceScan,
  advanceMapReferenceScan,
  upsertMapScenarioBinding,
  withdrawMapRelease,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

const draftSteps = (document: unknown) => normalizeAuthoringDocument(document).nodes.flatMap(node => node.kind === 'step' ? [node.step] : [])

const echoStep = (id: string, name: string, outputKey: string): Step => ({
  id,
  name,
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey,
  input: { value: name },
})

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

describe.each(DRIVERS)('%s 地图查询与治理', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_gov_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-gov',
      email: `map-gov-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function freshTarget(codePrefix = 'gov'): Promise<string> {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `${codePrefix}-${id}`,
      name: '治理夹具',
      entryUrl: 'https://shop.example',
    })
    return id
  }

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  function condition(targetId: string): MapConditionSnapshot {
    return {
      targetId,
      accountBinding: { presence: 'anonymous' as const },
      unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
    }
  }

  function command(
    body: Omit<Parameters<typeof applyMapGovernanceCommand>[2], 'evidenceRefs'> & { evidenceRefs?: [] },
  ) {
    return { evidenceRefs: [], ...body }
  }

  async function seedObject(targetId: string, suffix = 'save', semanticName = '保存') {
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    const pageKey = `page:v1:top:${suffix}:top`
    const objectKey = `object:v1:${suffix}-btn`
    const implKey = `impl:v1:${suffix}`
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
            stableToken: suffix,
            reasons: ['allocation-key'],
            matchResult: 'MATCH',
          },
        ],
        implementations: [
          {
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            condition: condition(targetId),
          },
        ],
        descriptors: [
          {
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            features: { semanticName },
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
    const item = listed.items.find(item => item.assetRef.implementationKey === implKey)
    if (!item) throw new Error('seedObject 没有对象')
    return item
  }

  async function makeScenario(targetId: string, name: string, steps: Step[]) {
    return createScenarioWithVersion(handle.db, {
      targetId,
      name,
      actor: { id: actorId },
      steps,
    })
  }

  it('OMD01 两个 Target 同名对象互不可见', async () => {
    const a = await freshTarget('a')
    const b = await freshTarget('b')
    const objectA = await seedObject(a, 'keep')
    await seedObject(b, 'keep')
    const listedB = await listMapAssets(handle.db, b, 'objects', mapListQuerySchema.parse({}))
    expect(listedB.items.some((item) => item.assetRef.objectId === objectA.assetRef.objectId)).toBe(false)
    expect(listedB.items.every((item) => item.assetRef.targetId === b)).toBe(true)
    const scenario = await makeScenario(a, `引用-${newId().slice(0, 8)}`, [echoStep(newId(), '一步', 'out')])
    await upsertMapScenarioBinding(handle.db, a, {
      scenarioId: scenario.id,
      stepId: draftSteps(scenario.draft!.document)[0]!.id,
      assetRef: objectA.assetRef,
      expectedDraftRevision: scenario.draft!.revision,
      basis: 'explicit_user',
      scopeKind: 'draft',
    }, actor())
    const refsB = await listMapReferences(handle.db, b, { ...mapListQuerySchema.parse({}), visible: true })
    expect(refsB.items.some((item) => item.scenarioId === scenario.id)).toBe(false)
  })

  it('治理 overlay 退役只改当前投影展示', async () => {
    const targetId = await freshTarget('ov')
    const object = await seedObject(targetId, 'retire')
    await applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({
        evidenceRefs: [],
        kind: 'retire',
        reason: '旧入口下线',
        expectedGovernanceRevision: 0,
        assetRef: object.assetRef,
        idempotencyKey: `cmd:retire-${object.assetRefKey}`.slice(0, 192),
      }),
      actor(),
    )
    const listed = await listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({}))
    expect(listed.items[0]?.lifecycle).toBe('RETIRED')
    expect(listed.items[0]?.overlayLifecycle).toBe('RETIRED')
    await expect(
      applyMapGovernanceCommand(
        handle.db,
        targetId,
        command({
          evidenceRefs: [],
          kind: 'retire',
          reason: '重复提交',
          expectedGovernanceRevision: 0,
          assetRef: object.assetRef,
          idempotencyKey: `cmd:stale-${object.assetRefKey}`.slice(0, 192),
        }),
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'MAP_REVISION_CONFLICT' })
  })

  it('OMD07 发布快照 overlay，撤回后现行不再指向该版，历史仍可读', async () => {
    const targetId = await freshTarget('pub')
    const object = await seedObject(targetId, 'snap')
    await applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({
        evidenceRefs: [],
        kind: 'retire',
        reason: '发布前退役',
        expectedGovernanceRevision: 0,
        assetRef: object.assetRef,
        idempotencyKey: `cmd:retire-pub-${targetId}`.slice(0, 192),
      }),
      actor(),
    )
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    const published = await sealAndPublishMapRelease(
      handle.db,
      targetId,
      {
        projectionId: projection.id,
        expectedProjectionRevision: state.revision,
        expectedPublicationRevision: 0,
        idempotencyKey: `cmd:publish-${targetId}`.slice(0, 192),
        reason: '发布当前知识版本',
      },
      actor(),
    )
    await applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({
        evidenceRefs: [],
        kind: 'restore',
        reason: '恢复现行',
        expectedGovernanceRevision: 1,
        assetRef: object.assetRef,
        idempotencyKey: `cmd:restore-${targetId}`.slice(0, 192),
      }),
      actor(),
    )
    const current = await listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({}))
    expect(current.items[0]?.lifecycle).toBe('VERIFIED')
    const sealed = await listMapAssets(
      handle.db,
      targetId,
      'objects',
      mapListQuerySchema.parse({
        releaseId: published.release.releaseId,
        manifestDigest: published.release.manifestDigest,
      }),
    )
    expect(sealed.items[0]?.lifecycle).toBe('RETIRED')
    const withdrawn = await withdrawMapRelease(
      handle.db,
      targetId,
      published.release.releaseId,
      {
        expectedPublicationRevision: 1,
        idempotencyKey: `cmd:withdraw-${targetId}`.slice(0, 192),
        reason: '撤回此版本',
      },
      actor(),
    )
    expect(withdrawn.publicationStatus).toBe('withdrawn')
    const summary = await getMapSummary(handle.db, targetId, mapListQuerySchema.parse({}))
    expect(summary.publicationStatus).not.toBe('published')
    expect(summary.publishedReleaseId).toBeUndefined()
    const reread = await listMapAssets(
      handle.db,
      targetId,
      'objects',
      mapListQuerySchema.parse({
        releaseId: published.release.releaseId,
        manifestDigest: published.release.manifestDigest,
      }),
    )
    expect(reread.items[0]?.lifecycle).toBe('RETIRED')
  })

  it('OMD04 同时纠正同一身份只有一次成功', async () => {
    const targetId = await freshTarget('race')
    const object = await seedObject(targetId, 'race')
    const splitTo = newId()
    const body = {
      kind: 'correct_identity' as const,
      reason: '并发拆分',
      expectedIdentityRevision: 0,
      payload: {
        action: 'split' as const,
        oldRefs: [object.assetRef],
        newRefs: [object.assetRef, { targetId, objectId: splitTo }],
      },
    }
    const first = applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({ ...body, idempotencyKey: `cmd:race-a-${targetId}`.slice(0, 192) }),
      actor(),
    )
    const second = applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({ ...body, idempotencyKey: `cmd:race-b-${targetId}`.slice(0, 192) }),
      actor(),
    )
    const results = await Promise.allSettled([first, second])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'MAP_REVISION_CONFLICT' })
    const replay = await applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({
        ...body,
        idempotencyKey: ((fulfilled[0] as PromiseFulfilledResult<{ idempotencyKey: string }>).value.idempotencyKey),
      }),
      actor(),
    )
    expect(replay.status).toBe('applied')
    expect(replay.commandId).toBe((fulfilled[0] as PromiseFulfilledResult<{ commandId: string }>).value.commandId)
  })

  it('OMD05 拆分后原引用待确认，不自动落到子对象', async () => {
    const targetId = await freshTarget('split')
    const object = await seedObject(targetId, 'split')
    const scenario = await makeScenario(targetId, `拆分-${newId().slice(0, 8)}`, [echoStep(newId(), '一步', 'out')])
    const stepId = draftSteps(scenario.draft!.document)[0]!.id
    await upsertMapScenarioBinding(
      handle.db,
      targetId,
      {
        scenarioId: scenario.id,
        stepId,
        assetRef: object.assetRef,
        expectedDraftRevision: scenario.draft!.revision,
        basis: 'explicit_user',
        scopeKind: 'draft',
      },
      actor(),
    )
    const splitTo = newId()
    await applyMapGovernanceCommand(
      handle.db,
      targetId,
      command({
        kind: 'correct_identity',
        reason: '误合并后拆分',
        expectedIdentityRevision: 0,
        idempotencyKey: `cmd:split-${targetId}`.slice(0, 192),
        payload: {
          action: 'split',
          oldRefs: [object.assetRef],
          newRefs: [object.assetRef, { targetId, objectId: splitTo }],
        },
      }),
      actor(),
    )
    const refs = await listMapReferences(handle.db, targetId, { ...mapListQuerySchema.parse({}), visible: true })
    const bound = refs.items.find((item) => item.scenarioId === scenario.id && item.grade === 'confirmed_reference')
    expect(bound?.resolution).toBe('pending_confirmation')
    expect(bound?.assetRefKey).toBe(object.assetRefKey)
  })

  it('OMD06 扫描候选不算确切影响，绑定后才计', async () => {
    const targetId = await freshTarget('scan')
    const object = await seedObject(targetId, 'scan')
    const scenario = await makeScenario(targetId, `扫描-${newId().slice(0, 8)}`, [echoStep(newId(), '一步', 'out')])
    const stepId = draftSteps(scenario.draft!.document)[0]!.id
    await startMapReferenceScan(handle.db, targetId, actor())
    await advanceMapReferenceScan(handle.db, {
      targetId,
      complete: true,
      batch: [
        {
          scenarioId: scenario.id,
          steps: [{ stepId, assetRefKey: object.assetRefKey, objectId: object.assetRef.objectId, reasons: ['similar-name'] }],
        },
      ],
    })
    const before = await loadMapImpactSource(handle.db, targetId, { assetRefKey: object.assetRefKey, limit: 20 }, true)
    expect(before.bindings).toHaveLength(0)
    expect(before.candidates.some(item => item.scenarioId === scenario.id)).toBe(true)
    await upsertMapScenarioBinding(
      handle.db,
      targetId,
      {
        scenarioId: scenario.id,
        stepId,
        assetRef: object.assetRef,
        expectedDraftRevision: scenario.draft!.revision,
        basis: 'explicit_user',
        scopeKind: 'draft',
      },
      actor(),
    )
    const after = await loadMapImpactSource(handle.db, targetId, { assetRefKey: object.assetRefKey, limit: 20 }, true)
    expect(after.bindings.some(item => item.scenarioId === scenario.id)).toBe(true)
  })

  it('OMD03 游标与筛选摘要绑定，换条件即过期', async () => {
    const targetId = await freshTarget('cur')
    await seedObject(targetId, 'one')
    const bad = Buffer.from(JSON.stringify({ d: 'a'.repeat(64), k: 'p:x:o:x:i:x:d:0' }), 'utf8').toString('base64url')
    await expect(
      listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({ cursor: bad })),
    ).rejects.toMatchObject({ code: 'MAP_CURSOR_EXPIRED' })
    expect(DomainError).toBeDefined()
  })

  it('OMD08 草稿 OCC 阻止陈旧绑定，发布冻结版本引用', async () => {
    const targetId = await freshTarget('occ')
    const object = await seedObject(targetId, 'occ')
    const first = echoStep(newId(), '一步', 'out')
    const scenario = await makeScenario(targetId, `并发-${newId().slice(0, 8)}`, [first])
    await expect(
      upsertMapScenarioBinding(
        handle.db,
        targetId,
        {
          scenarioId: scenario.id,
          stepId: first.id,
          assetRef: object.assetRef,
          expectedDraftRevision: 0,
          basis: 'explicit_user',
          scopeKind: 'draft',
        },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    await upsertMapScenarioBinding(
      handle.db,
      targetId,
      {
        scenarioId: scenario.id,
        stepId: first.id,
        assetRef: object.assetRef,
        expectedDraftRevision: scenario.draft!.revision,
        basis: 'explicit_user',
        scopeKind: 'draft',
      },
      actor(),
    )
    const second = echoStep(newId(), '二步', 'out2')
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: scenario.draft!.revision,
      actor: { id: actorId },
      document: { schemaVersion: 1, inputs: [], steps: [first, second] },
    })
    const published = await publishScenarioDraft(handle.db, scenario.id, {
      revision: scenario.draft!.revision + 1,
      actor: { id: actorId },
    })
    const { mapScenarioBindings } = schemaFor(handle.db)
    const frozen = await handle.db.select().from(mapScenarioBindings)
    expect(
      frozen.some(
        (row) =>
          row.scenarioId === scenario.id &&
          row.scopeKind === 'version' &&
          row.scenarioVersionId === published.latestVersionId &&
          row.status === 'active',
      ),
    ).toBe(true)
  })

  it('无投影时 viewRef 为 missing，列表为空', async () => {
    const targetId = await freshTarget('miss')
    const summary = await getMapSummary(handle.db, targetId, mapListQuerySchema.parse({}))
    expect(summary.projectionStatus).toBe('missing')
    expect(summary.view.viewRef.kind).toBe('missing')
    const listed = await listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({}))
    expect(listed.items).toEqual([])
    expect(listed.view.viewRef.kind).toBe('missing')
  })

  it('预览修订冲突只给 rejectReasons，提交才抛错', async () => {
    const targetId = await freshTarget('prev')
    const object = await seedObject(targetId, 'prev')
    const preview = await previewMapGovernance(
      handle.db,
      targetId,
      {
        evidenceRefs: [],
        kind: 'retire',
        reason: '过期预览',
        expectedGovernanceRevision: 9,
        assetRef: object.assetRef,
      },
      true,
    )
    expect(preview.rejectReasons).toContain('revision_conflict')
    expect(preview.baseRevision).toBe(0)
  })

  it('同幂等键异体冲突，同体返回原命令', async () => {
    const targetId = await freshTarget('idem')
    const object = await seedObject(targetId, 'idem')
    const key = `cmd:idem-${targetId}`.slice(0, 192)
    const first = await applyMapGovernanceCommand(
      handle.db,
      targetId,
      {
        evidenceRefs: [],
        kind: 'retire',
        reason: '第一次退役',
        expectedGovernanceRevision: 0,
        assetRef: object.assetRef,
        idempotencyKey: key,
      },
      actor(),
    )
    const again = await applyMapGovernanceCommand(
      handle.db,
      targetId,
      {
        evidenceRefs: [],
        kind: 'retire',
        reason: '第一次退役',
        expectedGovernanceRevision: 0,
        assetRef: object.assetRef,
        idempotencyKey: key,
      },
      actor(),
    )
    expect(again.commandId).toBe(first.commandId)
    await expect(
      applyMapGovernanceCommand(
        handle.db,
        targetId,
        {
          evidenceRefs: [],
          kind: 'confirm_semantics',
          reason: '换成确认',
          expectedGovernanceRevision: 0,
          assetRef: object.assetRef,
          idempotencyKey: key,
        },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'MAP_IDEMPOTENCY_CONFLICT' })
  })

  it('OMD07 撤回后新消费看不到 published，封存列表仍可读', async () => {
    const targetId = await freshTarget('wd')
    const object = await seedObject(targetId, 'wd')
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    const published = await sealAndPublishMapRelease(
      handle.db,
      targetId,
      {
        projectionId: projection.id,
        expectedProjectionRevision: state.revision,
        expectedPublicationRevision: 0,
        idempotencyKey: `cmd:wd-pub-${targetId}`.slice(0, 192),
        reason: '先发布',
      },
      actor(),
    )
    await withdrawMapRelease(
      handle.db,
      targetId,
      published.release.releaseId,
      {
        expectedPublicationRevision: 1,
        idempotencyKey: `cmd:wd-${targetId}`.slice(0, 192),
        reason: '撤回此版本',
      },
      actor(),
    )
    const summary = await getMapSummary(handle.db, targetId, mapListQuerySchema.parse({}))
    expect(summary.publishedReleaseId).toBeUndefined()
    const sealed = await listMapAssets(
      handle.db,
      targetId,
      'objects',
      mapListQuerySchema.parse({
        releaseId: published.release.releaseId,
        manifestDigest: published.release.manifestDigest,
      }),
    )
    expect(sealed.items.some((item) => item.assetRef.objectId === object.assetRef.objectId)).toBe(true)
  })

  it('OMD04 并发治理只有一次成功', async () => {
    const targetId = await freshTarget('race')
    const object = await seedObject(targetId, 'race')
    const first = applyMapGovernanceCommand(
      handle.db,
      targetId,
      {
        evidenceRefs: [],
        kind: 'retire',
        reason: '并发甲',
        expectedGovernanceRevision: 0,
        assetRef: object.assetRef,
        idempotencyKey: `cmd:race-a-${targetId}`.slice(0, 192),
      },
      actor(),
    )
    const second = applyMapGovernanceCommand(
      handle.db,
      targetId,
      {
        evidenceRefs: [],
        kind: 'retire',
        reason: '并发乙',
        expectedGovernanceRevision: 0,
        assetRef: object.assetRef,
        idempotencyKey: `cmd:race-b-${targetId}`.slice(0, 192),
      },
      actor(),
    )
    const results = await Promise.allSettled([first, second])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(DomainError)
    expect((rejected.reason as DomainError).code).toBe('MAP_REVISION_CONFLICT')
  })
  it('预览不创建治理头，跨 Target 与不存在的资产不能提交', async () => {
    const targetId = await freshTarget('preview')
    const otherTarget = await freshTarget('other')
    const foreign = await seedObject(otherTarget)
    const body = command({ kind: 'retire', reason: '越界', assetRef: foreign.assetRef, expectedGovernanceRevision: 0, idempotencyKey: `cmd:${newId()}` })
    const preview = await previewMapGovernance(handle.db, targetId, body, true)
    expect(preview.rejectReasons).toContain('asset_not_found')
    const { mapGovernanceHeads, mapGovernanceCommands } = schemaFor(handle.db)
    expect(await handle.db.select().from(mapGovernanceHeads).where(eq(mapGovernanceHeads.targetId, targetId))).toHaveLength(0)
    await expect(applyMapGovernanceCommand(handle.db, targetId, body, actor())).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    expect(await handle.db.select().from(mapGovernanceCommands).where(eq(mapGovernanceCommands.targetId, targetId))).toHaveLength(0)
  })

  it('发布与撤回同键重试返回原收据，异体不重用且不重复审计', async () => {
    const targetId = await freshTarget('receipt')
    await seedObject(targetId)
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    const body = { projectionId: projection.id, expectedProjectionRevision: state.revision, expectedPublicationRevision: 0, idempotencyKey: `cmd:${newId()}`, reason: '发布' }
    const published = await sealAndPublishMapRelease(handle.db, targetId, body, actor())
    expect(await sealAndPublishMapRelease(handle.db, targetId, body, actor())).toEqual(published)
    await expect(sealAndPublishMapRelease(handle.db, targetId, { ...body, selectedAssetKeys: [] }, actor())).rejects.toMatchObject({ code: 'MAP_IDEMPOTENCY_CONFLICT' })
    const withdrawal = { expectedPublicationRevision: 1, idempotencyKey: `cmd:${newId()}`, reason: '撤回' }
    const withdrawn = await withdrawMapRelease(handle.db, targetId, published.release.releaseId, withdrawal, actor())
    expect(await withdrawMapRelease(handle.db, targetId, published.release.releaseId, withdrawal, actor())).toEqual(withdrawn)
    await expect(withdrawMapRelease(handle.db, targetId, published.release.releaseId, { ...withdrawal, reason: '换理由' }, actor())).rejects.toMatchObject({ code: 'MAP_IDEMPOTENCY_CONFLICT' })
    expect(await sealAndPublishMapRelease(handle.db, targetId, body, actor())).toEqual(published)
    expect((await getMapReleasePublication(handle.db, targetId, published.release.releaseId)).publicationStatus).toBe('withdrawn')
    const republished = await publishMapRelease(handle.db, targetId, published.release.releaseId, { expectedPublicationRevision: 2, idempotencyKey: `cmd:${newId()}`, reason: '再次批准' }, actor())
    expect(republished.publicationRevision).toBe(3)
    expect(await withdrawMapRelease(handle.db, targetId, published.release.releaseId, withdrawal, actor())).toEqual(withdrawn)
    expect((await getMapReleasePublication(handle.db, targetId, published.release.releaseId)).publicationStatus).toBe('published')
  })

  it('封存详情保留描述与条件，后续描述变更不渗入历史版本', async () => {
    const targetId = await freshTarget('snapshot')
    const object = await seedObject(targetId, 'same', '原始名称')
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    const published = await sealAndPublishMapRelease(handle.db, targetId, { projectionId: projection.id, expectedProjectionRevision: state.revision, expectedPublicationRevision: 0, idempotencyKey: `cmd:${newId()}`, reason: '快照' }, actor())
    const query = mapListQuerySchema.parse({ releaseId: published.release.releaseId })
    const before = await getMapAssetDetail(handle.db, targetId, object.assetRef.objectId!, query)
    expect(before.implementations[0]?.semanticName).toBe('原始名称')
    expect(before.implementations[0]?.conditionSnapshot?.unknownFields).toContain('workspace')
    await seedObject(targetId, 'same', '更新后的名称')
    const after = await getMapAssetDetail(handle.db, targetId, object.assetRef.objectId!, query)
    expect(after.implementations).toEqual(before.implementations)
    expect(after.name).toBe('原始名称')
    const latest = await getMapAssetDetail(handle.db, targetId, object.assetRef.objectId!, mapListQuerySchema.parse({}))
    expect(latest.implementations[0]?.semanticName).toBe('更新后的名称')
  })

  it('真实分页游标在原投影推进后过期，同一对象多个引用不漏页', async () => {
    const targetId = await freshTarget('pagination')
    const object = await seedObject(targetId, 'one')
    await seedObject(targetId, 'two')
    const page = await listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({ limit: 1 }))
    expect(page.nextCursor).toBeTruthy()
    const next = await listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({ limit: 1, cursor: page.nextCursor }))
    expect(next.items).toHaveLength(1)
    expect(next.items[0]!.assetRefKey).not.toBe(page.items[0]!.assetRefKey)
    await seedObject(targetId, 'three')
    await expect(listMapAssets(handle.db, targetId, 'objects', mapListQuerySchema.parse({ limit: 1, cursor: page.nextCursor }))).rejects.toMatchObject({ code: 'MAP_CURSOR_EXPIRED' })
    const scenario = await makeScenario(targetId, `分页-${newId()}`, [echoStep(newId(), '甲', 'a'), echoStep(newId(), '乙', 'b')])
    for (const step of draftSteps(scenario.draft!.document)) await upsertMapScenarioBinding(handle.db, targetId, { scenarioId: scenario.id, stepId: step.id, assetRef: object.assetRef, expectedDraftRevision: scenario.draft!.revision, scopeKind: 'draft', basis: 'explicit_user' }, actor())
    let cursor: string | undefined
    const ids: string[] = []
    do {
      const refs = await listMapReferences(handle.db, targetId, { limit: 1, cursor, visible: true })
      ids.push(...refs.items.map(item => item.bindingId!))
      cursor = refs.nextCursor
    } while (cursor)
    expect(new Set(ids).size).toBe(2)
    const source = await loadMapImpactSource(handle.db, targetId, { assetRefKey: object.assetRefKey, limit: 1 }, true)
    expect(source.bindings).toHaveLength(2)

  })

  it.each([1, 2])('绑定拒绝幽灵步骤与其他目标，V%s 移除步骤后发布不复制陈旧绑定', async (version) => {
    const targetId = await freshTarget('binding')
    const object = await seedObject(targetId)
    const scenario = await makeScenario(targetId, `绑定-${newId()}`, [echoStep(newId(), '甲', 'a')])
    const body = { scenarioId: scenario.id, stepId: draftSteps(scenario.draft!.document)[0]!.id, assetRef: object.assetRef, expectedDraftRevision: scenario.draft!.revision, scopeKind: 'draft' as const, basis: 'explicit_user' as const }
    await expect(upsertMapScenarioBinding(handle.db, targetId, { ...body, stepId: newId() }, actor())).rejects.toMatchObject({ code: 'MAP_REFERENCE_UNRESOLVED' })
    await expect(upsertMapScenarioBinding(handle.db, targetId, { ...body, assetRef: { ...object.assetRef, targetId: newId() } }, actor())).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    await upsertMapScenarioBinding(handle.db, targetId, body, actor())
    const replacement = echoStep(newId(), '替换', 'b')
    const document = version === 1
      ? { schemaVersion: 1, inputs: [], steps: [replacement] }
      : { authoringSchemaVersion: 2, inputs: [], nodes: [{ kind: 'step', step: replacement }] }
    await saveScenarioDraft(handle.db, scenario.id, { revision: scenario.draft!.revision, actor: { id: actorId }, document })
    const draftRefs = await listMapReferences(handle.db, targetId, { limit: 100, visible: true, scopeKind: 'draft', scenarioId: scenario.id })
    expect(draftRefs.items).toEqual([])
    await publishScenarioDraft(handle.db, scenario.id, { revision: scenario.draft!.revision + 1, actor: { id: actorId } })
    const refs = await listMapReferences(handle.db, targetId, { limit: 100, visible: true, scopeKind: 'version', scenarioId: scenario.id })
    expect(refs.items).toEqual([])
  })

  it('超过 8 个场景分批推进、重复 Worker 不重复计数、重新扫描清空水位', async () => {
    const targetId = await freshTarget('batch')
    for (let i = 0; i < 11; i++) await makeScenario(targetId, `批次-${i}-${newId()}`, [echoStep(newId(), '一步', 'a')])
    await startMapReferenceScan(handle.db, targetId, actor())
    const work = (await listMapReferenceScanWork(handle.db)).find(item => item.targetId === targetId)!
    const source = await loadTargetScanSource(handle.db, targetId, { afterScenarioId: work.lastScenarioId, limit: 9 })
    expect(source.scenarios).toHaveLength(9)
    const first = { targetId, expectedLastScenarioId: work.lastScenarioId, requestedAt: work.requestedAt, complete: false, batch: source.scenarios.slice(0, 8).map(item => ({ scenarioId: item.scenarioId, steps: [] })) }
    expect((await advanceMapReferenceScan(handle.db, first)).scanned).toBe(8)
    expect((await advanceMapReferenceScan(handle.db, first)).scanned).toBe(0)
    const next = await loadTargetScanSource(handle.db, targetId, { afterScenarioId: first.batch.at(-1)!.scenarioId, limit: 9 })
    expect(next.scenarios).toHaveLength(3)
    await advanceMapReferenceScan(handle.db, { targetId, expectedLastScenarioId: first.batch.at(-1)!.scenarioId, requestedAt: work.requestedAt, complete: true, batch: next.scenarios.map(item => ({ scenarioId: item.scenarioId, steps: [] })) })
    expect((await listMapReferences(handle.db, targetId, { limit: 20, visible: true })).scanCompleteness).toBe('complete')
    const restarted = await startMapReferenceScan(handle.db, targetId, actor())
    expect(restarted.scannedCount).toBe(0)
    expect(restarted.completeness).toBe('unknown')
  })

})
