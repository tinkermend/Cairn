import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  RUNTIME_SCHEMA_VERSION,
  mapListQuerySchema,
  isAuthoringDocumentV2,
  scenarioDocumentDigest,
  scenarioDocumentSchema,
  type MapConditionSnapshot,
  type MapProjectionPlan,
  type ScenarioDocument,
  type Step,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  acceptKnowledgeProposal,
  completeKnowledgeProposal,
  createScenarioWithVersion,
  createTerminology,
  DomainError,
  ensureMapProjection,
  commitMapProjectionBatch,
  getKnowledgeProposal,
  getTerminology,
  validateKnowledgeSources,
  retireTerminology,
  getScenario,
  listMapAssets,
  listTerminology,
  loadMapProjectionState,
  matchTerminology,
  saveScenarioDraft,
  startKnowledgeProposal,
  updateTerminology,
  upsertMapScenarioBinding,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function asFlatDocument(document: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(document)) {
    return scenarioDocumentSchema.parse({
      schemaVersion: document.schemaVersion,
      inputs: document.inputs,
      steps: document.nodes.filter((node) => node.kind === 'step').map((node) => node.step),
    })
  }
  return scenarioDocumentSchema.parse(document)
}

const echoStep = (id: string, name: string, outputKey = 'out'): Extract<Step, { type: 'echo' }> => ({
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

describe.each(DRIVERS)('%s 地图术语与知识建议', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_know_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-knowledge',
      email: `map-know-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function freshTarget(codePrefix = 'know'): Promise<string> {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `${codePrefix}-${id}`,
      name: '知识夹具',
      entryUrl: 'https://shop.example',
    })
    return id
  }

  function condition(targetId: string): MapConditionSnapshot {
    return {
      targetId,
      accountBinding: { presence: 'anonymous' },
      unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
    }
  }

  async function seedObject(targetId: string, suffix = 'term') {
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
        implementations: [{ objectAllocationKey: objectKey, implementationKey: implKey, condition: condition(targetId) }],
        descriptors: [
          {
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            features: { semanticName: suffix },
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
    const item = listed.items.find((row) => row.assetRef.implementationKey === implKey)
    if (!item?.assetRef.objectId) throw new Error('seedObject 没有对象')
    return item.assetRef
  }

  it('OME13 两目标术语隔离，并发更新只一份成功', async () => {
    const a = await freshTarget('ta')
    const b = await freshTarget('tb')
    const termA = await createTerminology(handle.db, a, {
      idempotencyKey: `term-a-${newId().slice(0, 8)}`,
      canonicalName: '销售订单',
      aliases: ['订单'],
      meaning: '前台销售单',
    }, actor())
    await createTerminology(handle.db, b, {
      idempotencyKey: `term-b-${newId().slice(0, 8)}`,
      canonicalName: '销售订单',
      aliases: ['订单'],
      meaning: '另一目标的销售单',
    }, actor())
    const listedB = await listTerminology(handle.db, b, { q: '订单', limit: 20 })
    expect(listedB.items.every((item) => item.targetId === b)).toBe(true)
    expect(listedB.items.some((item) => item.termId === termA.termId)).toBe(false)
    const first = await getTerminology(handle.db, a, termA.termId)
    const [ok, conflicted] = await Promise.allSettled([
      updateTerminology(handle.db, a, termA.termId, {
        expectedRevision: first.revision,
        meaning: '并发甲',
      }, actor()),
      updateTerminology(handle.db, a, termA.termId, {
        expectedRevision: first.revision,
        meaning: '并发乙',
      }, actor()),
    ])
    const success = [ok, conflicted].filter((item) => item.status === 'fulfilled')
    const failed = [ok, conflicted].filter((item) => item.status === 'rejected')
    expect(success).toHaveLength(1)
    expect(failed).toHaveLength(1)
    if (failed[0]?.status === 'rejected') {
      expect((failed[0].reason as DomainError).code).toBe('KNOWLEDGE_REVISION_CONFLICT')
    }
  })

  it('OME04 同别名 match 返回多个候选', async () => {
    const targetId = await freshTarget('alias')
    await createTerminology(handle.db, targetId, {
      idempotencyKey: `alias-1-${newId().slice(0, 8)}`,
      canonicalName: '销售订单',
      aliases: ['订单'],
      meaning: '前台销售单',
      termStatus: 'confirmed',
    }, actor())
    await createTerminology(handle.db, targetId, {
      idempotencyKey: `alias-2-${newId().slice(0, 8)}`,
      canonicalName: '采购订单',
      aliases: ['订单'],
      meaning: '采购入库单',
      termStatus: 'confirmed',
    }, actor())
    const matched = await matchTerminology(handle.db, targetId, { alias: '订单' })
    expect(matched.items.length).toBeGreaterThanOrEqual(2)
  })

  it('OME06 草稿变化后接受旧建议失败且保留内容；重复接受只一次', async () => {
    const targetId = await freshTarget('stale')
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `建议-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [echoStep(newId(), '基线')],
    })
    const draft = scenario.draft!
    const draftDoc = asFlatDocument(draft.document)
    const digest = await scenarioDocumentDigest(draftDoc)
    const started = await startKnowledgeProposal(
      handle.db,
      scenario.id,
      {
        idempotencyKey: `prop-${newId().slice(0, 8)}`,
        question: '按订单号 1001 查询状态',
        expectedDraftRevision: draft.revision,
        documentDigest: digest,
      },
      actor(),
      { selectedTermRevisions: [], platformAiConfigRevision: 0 },
    )
    const nextSteps = [...draftDoc.steps, echoStep(newId(), '复制', 'copied')]
    const proposedDoc = { schemaVersion: RUNTIME_SCHEMA_VERSION, inputs: draftDoc.inputs, steps: nextSteps }
    const completed = await completeKnowledgeProposal(handle.db, scenario.id, started.proposal.proposalId, {
      status: 'proposed',
      question: started.proposal.question,
      document: proposedDoc,
      diffs: [{ fieldPath: ['steps', 'length'], from: 1, to: 2 }],
      diagnostics: [],
      sources: [],
      unknowns: [],
      termCandidates: [],
      suggestedModules: [],
      suggestedBindings: [],
    })
    expect(completed.proposalStatus).toBe('proposed')
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: draft.revision,
      document: { ...draftDoc, steps: [echoStep(draftDoc.steps[0]!.id, '已改', 'out')] },
      actor: { id: actorId },
    })
    await expect(
      acceptKnowledgeProposal(
        handle.db,
        scenario.id,
        completed.proposalId,
        { idempotencyKey: `acc-${newId().slice(0, 8)}`, expectedDraftRevision: draft.revision, documentDigest: digest },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORING_PROPOSAL_STALE' })
    const kept = await getKnowledgeProposal(handle.db, scenario.id, completed.proposalId)
    expect(kept.proposalStatus).toBe('stale')
    expect(kept.document?.steps).toHaveLength(2)

    const scenario2 = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `建议2-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [echoStep(newId(), '基线2')],
    })
    const draft2 = scenario2.draft!
    const draftDoc2 = asFlatDocument(draft2.document)
    const digest2 = await scenarioDocumentDigest(draftDoc2)
    const started2 = await startKnowledgeProposal(
      handle.db,
      scenario2.id,
      {
        idempotencyKey: `prop2-${newId().slice(0, 8)}`,
        question: '按订单号 1001 查询状态',
        expectedDraftRevision: draft2.revision,
        documentDigest: digest2,
      },
      actor(),
      { selectedTermRevisions: [], platformAiConfigRevision: 0 },
    )
    const proposed2 = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      inputs: draftDoc2.inputs,
      steps: [...draftDoc2.steps, echoStep(newId(), '复制2', 'copied2')],
    }
    await completeKnowledgeProposal(handle.db, scenario2.id, started2.proposal.proposalId, {
      status: 'proposed',
      question: started2.proposal.question,
      document: proposed2,
      diffs: [{ fieldPath: ['steps', 'length'], from: 1, to: 2 }],
      diagnostics: [],
      sources: [],
      unknowns: [],
      termCandidates: [],
      suggestedModules: [],
      suggestedBindings: [],
    })
    const acceptKey = `acc2-${newId().slice(0, 8)}`
    const firstAccept = await acceptKnowledgeProposal(
      handle.db,
      scenario2.id,
      started2.proposal.proposalId,
      { idempotencyKey: acceptKey, expectedDraftRevision: draft2.revision, documentDigest: digest2 },
      actor(),
    )
    const secondAccept = await acceptKnowledgeProposal(
      handle.db,
      scenario2.id,
      started2.proposal.proposalId,
      { idempotencyKey: acceptKey, expectedDraftRevision: draft2.revision, documentDigest: digest2 },
      actor(),
    )
    expect(firstAccept.draftRevision).toBe(secondAccept.draftRevision)
    expect(secondAccept.proposal.proposalStatus).toBe('accepted')
    expect(secondAccept.proposal.sources).toEqual([])
    await expect(acceptKnowledgeProposal(handle.db, scenario2.id, started2.proposal.proposalId, { idempotencyKey: acceptKey, expectedDraftRevision: 999, documentDigest: digest2 }, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_IDEMPOTENCY_CONFLICT' })
  })

  it('OME14 接受建议写 accepted_proposal 绑定，控制台 API 仍拒该 basis', async () => {
    const targetId = await freshTarget('bind')
    const assetRef = await seedObject(targetId)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `绑定-${newId().slice(0, 8)}`,
      actor: { id: actorId },
      steps: [echoStep(newId(), '基线')],
    })
    const draft = scenario.draft!
    const draftDoc = asFlatDocument(draft.document)
    const digest = await scenarioDocumentDigest(draftDoc)
    const extraId = newId()
    const started = await startKnowledgeProposal(
      handle.db,
      scenario.id,
      {
        idempotencyKey: `bind-${newId().slice(0, 8)}`,
        question: '按订单号 1001 查询状态',
        expectedDraftRevision: draft.revision,
        documentDigest: digest,
      },
      actor(),
      { selectedTermRevisions: [], platformAiConfigRevision: 0 },
    )
    const proposed = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      inputs: draftDoc.inputs,
      steps: [...draftDoc.steps, echoStep(extraId, '复制绑定', 'bound')],
    }
    await completeKnowledgeProposal(handle.db, scenario.id, started.proposal.proposalId, {
      status: 'proposed',
      question: started.proposal.question,
      document: proposed,
      diffs: [{ fieldPath: ['steps', 'length'], from: 1, to: 2 }],
      diagnostics: [],
      sources: [],
      unknowns: [],
      termCandidates: [],
      suggestedModules: [],
      suggestedBindings: [{ stepId: extraId, assetRef }],
    })
    await acceptKnowledgeProposal(
      handle.db,
      scenario.id,
      started.proposal.proposalId,
      { idempotencyKey: `bind-acc-${newId().slice(0, 8)}`, expectedDraftRevision: draft.revision, documentDigest: digest },
      actor(),
    )
    const { mapScenarioBindings } = schemaFor(handle.db)
    const bindings = await handle.db.select().from(mapScenarioBindings)
    expect(bindings.some((row) => row.basis === 'accepted_proposal' && row.stepId === extraId)).toBe(true)
    await expect(
      upsertMapScenarioBinding(handle.db, targetId, {
        scenarioId: scenario.id,
        stepId: extraId,
        assetRef,
        expectedDraftRevision: draft.revision + 1,
        basis: 'accepted_proposal',
        scopeKind: 'draft',
      }, actor()),
    ).rejects.toThrow(/explicit_user/)
  })
  it('创建术语的同键重试跨更新仍回放原始结果，完整请求参与比较', async () => {
    const targetId = await freshTarget('receipt')
    const body = { idempotencyKey: `term:${newId()}`, canonicalName: '客户', meaning: '客户标识', conditionSnapshot: condition(targetId) }
    const first = await createTerminology(handle.db, targetId, body, actor())
    expect(await createTerminology(handle.db, targetId, body, actor())).toEqual(first)
    await updateTerminology(handle.db, targetId, first.termId, { expectedRevision: 1, meaning: '新的含义' }, actor())
    expect(await createTerminology(handle.db, targetId, body, actor())).toEqual(first)
    await expect(createTerminology(handle.db, targetId, { ...body, conditionSnapshot: undefined }, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_IDEMPOTENCY_CONFLICT' })
    const current = await getTerminology(handle.db, targetId, first.termId)
    expect(current.revision).toBe(2)
    await retireTerminology(handle.db, targetId, first.termId, { expectedRevision: 2, reason: '合并' }, actor())
    const { mapTerminologyRevisions } = schemaFor(handle.db)
    const revisions = await handle.db.select().from(mapTerminologyRevisions)
    expect(revisions.find(row => row.termId === first.termId && row.revision === 3)?.payload).toMatchObject({ meaning: '新的含义', conditionSnapshot: condition(targetId), termStatus: 'retired' })
  })

  it('中文术语分页保持相同排序规则，更新后旧游标失效', async () => {
    const targetId = await freshTarget('pages')
    for (const canonicalName of ['中订单', 'A订单', '阿订单', 'Z订单']) await createTerminology(handle.db, targetId, { idempotencyKey: `page:${newId()}`, canonicalName, meaning: '含义' }, actor())
    let cursor: string | undefined
    const ids: string[] = []
    do {
      const page = await listTerminology(handle.db, targetId, { limit: 1, cursor })
      ids.push(...page.items.map(item => item.termId)); cursor = page.nextCursor
    } while (cursor)
    expect(new Set(ids).size).toBe(4)
    const first = await listTerminology(handle.db, targetId, { limit: 1 })
    await updateTerminology(handle.db, targetId, ids[0]!, { expectedRevision: 1, canonicalName: '改名' }, actor())
    await expect(listTerminology(handle.db, targetId, { limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'MAP_CURSOR_EXPIRED' })
  })

  it('来源拒绝跨目标资产、错误条件和不存在的执行尝试', async () => {
    const a = await freshTarget('source-a'); const b = await freshTarget('source-b')
    const assetRef = await seedObject(a)
    await expect(createTerminology(handle.db, b, { idempotencyKey: `src:${newId()}`, canonicalName: '错误来源', meaning: '含义', sources: [{ kind: 'map_asset', assetRef }] }, actor())).rejects.toBeInstanceOf(DomainError)
    await expect(createTerminology(handle.db, b, { idempotencyKey: `src:${newId()}`, canonicalName: '错误条件', meaning: '含义', conditionSnapshot: condition(a) }, actor())).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
    await expect(validateKnowledgeSources(handle.db, a, [{ kind: 'attempt', attemptId: newId() }])).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
  })

  it('生成请求同键不会重复执行，草稿与配置更新后仍回放；异体拒绝', async () => {
    const targetId = await freshTarget('replay')
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `重试-${newId()}`, actor: { id: actorId }, steps: [echoStep(newId(), '基线')] })
    const document = asFlatDocument(scenario.draft!.document)
    const body = { idempotencyKey: `prop:${newId()}`, question: '查询', expectedDraftRevision: scenario.draft!.revision, documentDigest: await scenarioDocumentDigest(document) }
    const extras = { selectedTermRevisions: [], platformAiConfigRevision: 0 }
    const first = await startKnowledgeProposal(handle.db, scenario.id, body, actor(), extras)
    const replay = await startKnowledgeProposal(handle.db, scenario.id, body, actor(), extras)
    expect(replay.replay).toBe(true); expect(replay.proposal.proposalId).toBe(first.proposal.proposalId)
    await saveScenarioDraft(handle.db, scenario.id, { revision: scenario.draft!.revision, actor: { id: actorId }, document })
    expect((await startKnowledgeProposal(handle.db, scenario.id, body, actor(), { ...extras, platformAiConfigRevision: 9 })).replay).toBe(true)
    await expect(startKnowledgeProposal(handle.db, scenario.id, { ...body, attemptId: newId() }, actor(), extras)).rejects.toMatchObject({ code: 'KNOWLEDGE_IDEMPOTENCY_CONFLICT' })
  })

  it('生成结果必须通过编译且绑定步骤存在，失败不会改草稿', async () => {
    const targetId = await freshTarget('compile')
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `编译-${newId()}`, actor: { id: actorId }, steps: [echoStep(newId(), '基线')] })
    const document = asFlatDocument(scenario.draft!.document)
    const first = await startKnowledgeProposal(handle.db, scenario.id, { idempotencyKey: `prop:${newId()}`, question: '查询', expectedDraftRevision: scenario.draft!.revision, documentDigest: await scenarioDocumentDigest(document) }, actor(), { selectedTermRevisions: [], platformAiConfigRevision: 0 })
    const result = { status: 'proposed' as const, question: '查询', diffs: [], diagnostics: [], sources: [], unknowns: [], termCandidates: [], suggestedModules: [], suggestedBindings: [], document: { ...document, steps: [...document.steps, { ...echoStep(newId(), '引用', 'next'), input: { from: 'missingKey' } }] } }
    await expect(completeKnowledgeProposal(handle.db, scenario.id, first.proposal.proposalId, result)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_PROPOSAL' })
    await expect(completeKnowledgeProposal(handle.db, scenario.id, first.proposal.proposalId, { ...result, document, suggestedBindings: [{ stepId: newId(), assetRef: { targetId, objectId: newId() } }] })).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' })
    expect((await getScenario(handle.db, scenario.id)).draft!.revision).toBe(scenario.draft!.revision)
  })

  it('接受键在场景内唯一，不能重用于另一份建议', async () => {
    const targetId = await freshTarget('accept-key')
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `幂等-${newId()}`, actor: { id: actorId }, steps: [echoStep(newId(), '基线')] })
    const acceptKey = `accept:${newId()}`
    for (let index = 0; index < 2; index++) {
      const draft = (await getScenario(handle.db, scenario.id)).draft!
      const document = asFlatDocument(draft.document)
      const body = { idempotencyKey: `prop:${newId()}`, question: '查询', expectedDraftRevision: draft.revision, documentDigest: await scenarioDocumentDigest(document) }
      const started = await startKnowledgeProposal(handle.db, scenario.id, body, actor(), { selectedTermRevisions: [], platformAiConfigRevision: 0 })
      await completeKnowledgeProposal(handle.db, scenario.id, started.proposal.proposalId, { status: 'proposed', question: '查询', document, diffs: [], diagnostics: [], sources: [], unknowns: [], termCandidates: [], suggestedModules: [], suggestedBindings: [] })
      const result = acceptKnowledgeProposal(handle.db, scenario.id, started.proposal.proposalId, { expectedDraftRevision: body.expectedDraftRevision, documentDigest: body.documentDigest, idempotencyKey: acceptKey }, actor())
      if (index === 0) await result
      else await expect(result).rejects.toMatchObject({ code: 'KNOWLEDGE_IDEMPOTENCY_CONFLICT' })
    }
  })

  it('过期生成的 GET 不写库，迟到生成不能覆盖失败状态', async () => {
    const targetId = await freshTarget('expired')
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `过期-${newId()}`, actor: { id: actorId }, steps: [echoStep(newId(), '基线')] })
    const document = asFlatDocument(scenario.draft!.document)
    const started = await startKnowledgeProposal(handle.db, scenario.id, { idempotencyKey: `prop:${newId()}`, question: '查询', expectedDraftRevision: scenario.draft!.revision, documentDigest: await scenarioDocumentDigest(document) }, actor(), { selectedTermRevisions: [], platformAiConfigRevision: 0 })
    const { mapAuthoringProposals } = schemaFor(handle.db)
    await handle.db.update(mapAuthoringProposals).set({ updatedAt: new Date(Date.now() - 180_000) }).where(eq(mapAuthoringProposals.id, started.proposal.proposalId))
    expect((await getKnowledgeProposal(handle.db, scenario.id, started.proposal.proposalId)).proposalStatus).toBe('failed')
    const [row] = await handle.db.select().from(mapAuthoringProposals).where(eq(mapAuthoringProposals.id, started.proposal.proposalId))
    expect(row!.proposalStatus).toBe('generating')
    const late = await completeKnowledgeProposal(handle.db, scenario.id, started.proposal.proposalId, { status: 'proposed', question: '查询', document, diffs: [], diagnostics: [], sources: [], unknowns: [], termCandidates: [], suggestedModules: [], suggestedBindings: [] })
    expect(late.proposalStatus).toBe('failed')
  })

})
