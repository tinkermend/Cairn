import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import {
  MODULE_MANIFEST_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import {
  createActionModule,
  publishActionModule,
  saveActionModuleDraft,
  listActionModuleVersions,
  createScenarioWithVersion,
  saveScenarioDraft,
  publishScenarioDraft,
  prepareTrialVersion,
  createRunWithSnapshot,
  getScenario,
  listScenarios,
  previewScenarioExpansion,
  inlineScenarioModuleInvocation,
  getActionModule,
  getOrCreateModuleVerificationScenario,
  prepareModuleDraftTrial,
  createTrialRunFromDraft,
  claimRun,
  registerWorker,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { computeContentDigest } from '../action-modules/digest.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_v2refs`

describe.each(DRIVERS)('%s 场景 V2 动作模块引用与展开（集成）', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let consoleAccounts = schemaFor({}).consoleAccounts
  let targets = schemaFor({}).targets
  let scenarioModuleRefs = schemaFor({}).scenarioModuleRefs
  let actionModuleVersions = schemaFor({}).actionModuleVersions

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, targets, scenarioModuleRefs, actionModuleVersions } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester-v2',
      email: `v2refs-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `v2-${SCHEMA.slice(-6)}`,
      name: 'V2引用夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('草稿保存、模块引用维护、发布展开与外键 restrict 保护', async () => {
    // 1. 创建并发布动作模块
    const assertStepId = newId()
    const moduleContent: ModuleContent = {
      contract: {
        inputs: [
          { key: 'keyword', label: '搜索词', valueType: 'string', required: true },
        ],
        outputs: [
          { key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } },
        ],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          {
            meaning: '验证结果存在',
            verification: { kind: 'output_required', outputKey: 'result' },
          },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: newId(),
              name: '回显关键词',
              type: 'echo',
              effectType: 'READ_ONLY',
              input: {
                from: 'keyword',
              },
              outputKey: 'internal_result',
            },
            {
              id: assertStepId,
              name: '断言回显有效',
              type: 'assert',
              effectType: 'READ_ONLY',
              input: {
                expect: {
                  kind: 'text_contains',
                  value: 'hello',
                },
              },
            },
          ],
          outputMapping: {
            result: 'internal_result',
          },
        },
      ],
    }

    const createdModule = await createActionModule(handle.db, {
      targetId,
      key: 'search.box',
      name: '搜索框模块',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })

    await saveActionModuleDraft(handle.db, createdModule.id, {
      baseRevision: 0,
      content: moduleContent,
      actor: { id: actorId },
    })

    await publishActionModule(handle.db, createdModule.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const modVersions = await listActionModuleVersions(handle.db, createdModule.id)
    const modVerId = modVersions.items[0]!.id

    // 2. 创建场景
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '使用搜索模块的场景',
      steps: [
        {
          id: newId(),
          name: '导航',
          type: 'navigate',
          effectType: 'IDEMPOTENT',
          input: {
            url: 'https://example.com',
          },
        },
      ],
      actor: { id: actorId },
    })

    // 3. 保存 V2 草稿：引用该模块
    const invocationId = newId()
    const v2Draft: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: newId(),
            name: '准备导航',
            type: 'navigate',
            effectType: 'IDEMPOTENT',
            input: {
              url: 'https://example.com/start',
            },
          },
        },
        {
          kind: 'module',
          invocationId,
          moduleId: createdModule.id,
          moduleVersionId: modVerId,
          implementationKey: 'default',
          inputBindings: {
            keyword: { kind: 'literal', value: 'hello' },
          },
          outputBindings: {
            result: 'search_res',
          },
        },
      ],
    }

    const saved = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: v2Draft,
      actor: { id: actorId },
    })
    expect(saved.draft?.revision).toBe(2)

    // 验证草稿引用落库
    const draftRefs = await handle.db
      .select()
      .from(scenarioModuleRefs)
      .where(and(eq(scenarioModuleRefs.scenarioId, scenario.id), isNull(scenarioModuleRefs.scenarioVersionId)))
    expect(draftRefs.length).toBe(1)
    expect(draftRefs[0]!.moduleId).toBe(createdModule.id)
    expect(draftRefs[0]!.moduleVersionId).toBe(modVerId)
    expect(draftRefs[0]!.invocationId).toBe(invocationId)

    // 4. 展开预览验证
    const preview = await previewScenarioExpansion(handle.db, scenario.id)
    expect(preview.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['SCENARIO_NO_OUTCOME']),
    )
    expect(preview.definition.steps).toHaveLength(3) // 1 nav + 2 module steps
    expect(preview.manifest?.entries).toHaveLength(1)
    expect(preview.manifest?.entries[0]!.moduleKey).toBe('search.box')

    // 5. 发布场景草稿
    const publishedScenario = await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    const pubVersion = publishedScenario.published!
    expect(pubVersion.versionNo).toBe(2)
    expect(pubVersion.moduleManifest?.entries).toHaveLength(1)
    expect(pubVersion.definition.steps).toHaveLength(3)

    // 验证发布引用落库
    const pubRefs = await handle.db
      .select()
      .from(scenarioModuleRefs)
      .where(and(eq(scenarioModuleRefs.scenarioId, scenario.id), eq(scenarioModuleRefs.scenarioVersionId, pubVersion.versionId)))
    expect(pubRefs.length).toBe(1)
    expect(pubRefs[0]!.moduleId).toBe(createdModule.id)
    expect(pubRefs[0]!.moduleVersionId).toBe(modVerId)

    // 6. 外键 restrict 保护：直接从数据库尝试删除被引用的模块版本，必定失败
    await expect(
      handle.db.delete(actionModuleVersions).where(eq(actionModuleVersions.id, modVerId)),
    ).rejects.toThrow()
  })

  it('创建 Run 带 moduleManifest，协议闸门拦截无协议能力 Worker', async () => {
    const assertStepId = newId()
    const moduleContent: ModuleContent = {
      contract: {
        inputs: [],
        outputs: [],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          {
            meaning: '等待并检查',
            verification: { kind: 'step', stepId: assertStepId },
          },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            { id: newId(), name: '等待', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 50 } },
            {
              id: assertStepId,
              name: '断言状态',
              type: 'assert',
              effectType: 'READ_ONLY',
              input: {
                expect: {
                  kind: 'text_contains',
                  value: 'ok',
                },
              },
            },
          ],
          outputMapping: {},
        },
      ],
    }
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'gate.test',
      name: '闸门模块',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, {
      baseRevision: 0,
      content: moduleContent,
      actor: { id: actorId },
    })
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const modVerId2 = (await listActionModuleVersions(handle.db, mod.id)).items[0]!.id

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '闸门场景',
      steps: [{ id: newId(), name: '初始', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })

    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            moduleId: mod.id,
            moduleVersionId: modVerId2,
            inputBindings: {},
          },
        ],
      },
      actor: { id: actorId },
    })

    const published = await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })

    // 创建 Run
    const runResult = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: published.published!.versionId,
      actor: { id: actorId },
    })
    expect(runResult.detail.snapshot.moduleManifest?.entries).toHaveLength(1)

    // 注册 Worker A：仅具备 SESSION_OCCUPANCY_PROTOCOL，缺少 MODULE_MANIFEST_PROTOCOL
    const workerAId = newId()
    const instAId = newId()
    await registerWorker(handle.db, {
      workerId: workerAId,
      instanceId: instAId,
      capacity: 2,
      maxSessions: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })

    // 注册 Worker B：具备 MODULE_MANIFEST_PROTOCOL
    const workerBId = newId()
    const instBId = newId()
    await registerWorker(handle.db, {
      workerId: workerBId,
      instanceId: instBId,
      capacity: 2,
      maxSessions: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, MODULE_MANIFEST_PROTOCOL],
    })

    // Worker A 领不到带有 moduleManifest 的 Run
    const claimA = await claimRun(handle, {
      workerId: workerAId,
      instanceId: instAId,
      leaseTtlSeconds: 30,
    })
    expect(claimA).toBeNull()

    // Worker B 成功领走该 Run
    const claimB = await claimRun(handle, {
      workerId: workerBId,
      instanceId: instBId,
      leaseTtlSeconds: 30,
    })
    expect(claimB?.runId).toBe(runResult.detail.id)
  })

  it('模块验证场景隔离与内联展开', async () => {
    const echoStepId = newId()
    const moduleContent: ModuleContent = {
      contract: {
        inputs: [{ key: 'msg', label: '消息', valueType: 'string', required: true }],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          {
            meaning: '验证输出',
            verification: { kind: 'output_required', outputKey: 'out' },
          },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [{ id: echoStepId, name: '步骤A', type: 'echo', effectType: 'READ_ONLY', input: { from: 'msg' }, outputKey: 'echo_msg' }],
          outputMapping: {
            out: 'echo_msg',
          },
        },
      ],
    }
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'verify.target',
      name: '内联与验证测试',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, {
      baseRevision: 0,
      content: moduleContent,
      actor: { id: actorId },
    })

    // 1. 获取或创建验证场景
    const verification = await getOrCreateModuleVerificationScenario(handle.db, {
      moduleId: mod.id,
      actor: { id: actorId },
    })
    expect(verification.scenarioId).toBeDefined()

    // 验证普通列表默认过滤
    const normalList = await listScenarios(handle.db, { targetId })
    expect(normalList.items.some((item) => item.id === verification.scenarioId)).toBe(false)

    // 显式查询 module_verification 能查到
    const verList = await listScenarios(handle.db, { targetId, purpose: 'module_verification' })
    expect(verList.items.some((item) => item.id === verification.scenarioId)).toBe(true)

    // 2. 准备带模块调用的普通场景进行内联展开
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const modVerId3 = (await listActionModuleVersions(handle.db, mod.id)).items[0]!.id

    const testScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '内联测试场景',
      steps: [{ id: newId(), name: '前置', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })

    const invId = newId()
    await saveScenarioDraft(handle.db, testScenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: invId,
            moduleId: mod.id,
            moduleVersionId: modVerId3,
            inputBindings: { msg: { kind: 'literal', value: 'inlined-msg' } },
          },
        ],
      },
      actor: { id: actorId },
    })

    // 执行内联展开
    const inlined = await inlineScenarioModuleInvocation(handle.db, testScenario.id, invId, {
      revision: 2,
      actor: { id: actorId },
    })
    expect(inlined.draft?.revision).toBe(3)
    const inlinedDoc = inlined.draft!.document as ScenarioAuthoringDocumentV2
    expect(inlinedDoc.nodes).toHaveLength(1)
    expect(inlinedDoc.nodes[0]!.kind).toBe('step')
    if (inlinedDoc.nodes[0]!.kind === 'step') {
      expect(inlinedDoc.nodes[0]!.step.name).toBe('步骤A')
      expect((inlinedDoc.nodes[0]!.step as any).input).toEqual({ value: 'inlined-msg' })
      expect(inlinedDoc.nodes[0]!.origin).toEqual({
        moduleVersionId: modVerId3,
        invocationId: invId,
      })
    }

    await expect(
      inlineScenarioModuleInvocation(handle.db, testScenario.id, invId, {
        revision: 2,
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
  })

  it('AMB-09: 不含模块调用的版本不落 manifest，快照里也不出现该字段', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '纯步骤场景',
      steps: [{ id: newId(), name: '前置', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          { kind: 'step', step: { id: newId(), name: '等待', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 20 } } },
        ],
      },
      actor: { id: actorId },
    })
    const published = await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    // 空 manifest 也会让严格解析快照的旧 Worker 失败，所以根本不写
    expect(published.published!.moduleManifest).toBeUndefined()

    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: published.published!.versionId,
      actor: { id: actorId },
    })
    expect(Object.hasOwn(run.detail.snapshot as object, 'moduleManifest')).toBe(false)
  })

  it('AMB-11: 内联展开按整篇文档的调用序号取步骤，私有输出键不与后续调用相撞', async () => {
    const stepA = newId()
    const stepB = newId()
    // 输出不暴露时会落到 `m{序号}_` 私有命名空间；内部第二步引用第一步的输出
    const content: ModuleContent = {
      contract: {
        inputs: [{ key: 'msg', label: '消息', valueType: 'string', required: true }],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          { meaning: '验证输出', verification: { kind: 'output_required', outputKey: 'out' } },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            { id: stepA, name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { from: 'msg' }, outputKey: 'echoed' },
            { id: stepB, name: '再回显', type: 'echo', effectType: 'READ_ONLY', input: { from: 'echoed' }, outputKey: 'again' },
          ],
          outputMapping: { out: 'again' },
        },
      ],
    }
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'inline.ordinal',
      name: '内联序号测试',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, { baseRevision: 0, content, actor: { id: actorId } })
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const versionId = (await listActionModuleVersions(handle.db, mod.id)).items[0]!.id

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '内联序号场景',
      steps: [{ id: newId(), name: '前置', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })
    const invocationIds = [newId(), newId(), newId()]
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: invocationIds.map((invocationId) => ({
          kind: 'module' as const,
          invocationId,
          moduleId: mod.id,
          moduleVersionId: versionId,
          inputBindings: { msg: { kind: 'literal' as const, value: 'hi' } },
        })),
      },
      actor: { id: actorId },
    })

    // 内联中间那个调用：展开出来的步骤必须是整篇文档里属于它的那两步
    const inlined = await inlineScenarioModuleInvocation(handle.db, scenario.id, invocationIds[1]!, {
      revision: 2,
      actor: { id: actorId },
    })
    const doc = inlined.draft!.document as ScenarioAuthoringDocumentV2
    expect(doc.nodes.map((node) => node.kind)).toEqual(['module', 'step', 'step', 'module'])
    const inlinedSteps = doc.nodes.flatMap((node) => (node.kind === 'step' ? [node.step] : []))
    // 内部级联引用必须仍然指向同一批步骤产出的键
    expect((inlinedSteps[1]!.input as { from?: string }).from).toBe(inlinedSteps[0]!.outputKey)
    expect(inlinedSteps.every((step) => !step.outputKey?.startsWith('m'))).toBe(true)

    // 剩下两个调用重新编号后仍能整体展开，不出现输出键重复
    const preview = await previewScenarioExpansion(handle.db, scenario.id)
    expect(preview.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const outputKeys = preview.definition.steps.flatMap((step) => (step.outputKey ? [step.outputKey] : []))
    expect(new Set(outputKeys).size).toBe(outputKeys.length)
  })

  it('同一草稿里同时引用模块草稿与已发布版本时，两者各自解析到自己的内容', async () => {
    const stepId = newId()
    const makeContent = (value: string): ModuleContent => ({
      contract: {
        inputs: [],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [
          { meaning: '验证输出', verification: { kind: 'output_required', outputKey: 'out' } },
        ],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [{ id: stepId, name: `回显${value}`, type: 'echo', effectType: 'READ_ONLY', input: { value }, outputKey: 'echoed' }],
          outputMapping: { out: 'echoed' },
        },
      ],
    })
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'mixed.ref',
      name: '草稿与版本混引',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, {
      baseRevision: 0,
      content: makeContent('v1'),
      actor: { id: actorId },
    })
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const publishedVersion = (await listActionModuleVersions(handle.db, mod.id)).items[0]!
    const draftContent = makeContent('draft')
    await saveActionModuleDraft(handle.db, mod.id, {
      baseRevision: 1,
      content: draftContent,
      actor: { id: actorId },
    })
    const draftDetail = await getActionModule(handle.db, mod.id)

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '混引场景',
      steps: [{ id: newId(), name: '前置', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })
    // 草稿引用排在版本引用之前，确保加载顺序不会让后者覆盖前者
    const preview = await previewScenarioExpansion(handle.db, scenario.id, {
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            moduleId: mod.id,
            moduleDraft: {
              moduleId: mod.id,
              revision: draftDetail.draftRevision!,
              contentDigest: computeContentDigest(draftContent),
            },
            inputBindings: {},
            outputBindings: { out: 'fromDraft' },
          },
          {
            kind: 'module',
            invocationId: newId(),
            moduleId: mod.id,
            moduleVersionId: publishedVersion.id,
            inputBindings: {},
            outputBindings: { out: 'fromVersion' },
          },
        ],
      },
    })
    expect(preview.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const byOutput = new Map(
      preview.definition.steps.map((step) => [step.outputKey, (step.input as { value?: string }).value]),
    )
    expect(byOutput.get('fromDraft')).toBe('draft')
    expect(byOutput.get('fromVersion')).toBe('v1')
  })

  it('AMB-01: 模块发布 v2 后旧 Scenario 版本的 definition/manifest/引用不变', async () => {
    const echoId = newId()
    const v1Content: ModuleContent = {
      contract: {
        inputs: [{ key: 'msg', label: '消息', valueType: 'string', required: true }],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '验证输出', verification: { kind: 'output_required', outputKey: 'out' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [{ id: echoId, name: '回显v1', type: 'echo', effectType: 'READ_ONLY', input: { from: 'msg' }, outputKey: 'echo_msg' }],
          outputMapping: { out: 'echo_msg' },
        },
      ],
    }
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'pin.version',
      name: '固定版本',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, {
      baseRevision: 0,
      content: v1Content,
      actor: { id: actorId },
    })
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const v1Id = (await listActionModuleVersions(handle.db, mod.id)).items[0]!.id

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '钉死 v1 的场景',
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            moduleId: mod.id,
            moduleVersionId: v1Id,
            inputBindings: { msg: { kind: 'literal', value: 'hello' } },
            outputBindings: { out: 'pinned' },
          },
        ],
      },
      actor: { id: actorId },
    })
    const published = await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    const frozenDefinition = JSON.stringify(published.published!.definition)
    const frozenManifest = JSON.stringify(published.published!.moduleManifest)
    const frozenVersionId = published.published!.versionId

    const v2Content: ModuleContent = {
      ...v1Content,
      implementations: [
        {
          ...v1Content.implementations[0]!,
          steps: [
            { id: echoId, name: '回显v2', type: 'echo', effectType: 'READ_ONLY', input: { from: 'msg' }, outputKey: 'echo_msg' },
          ],
        },
      ],
    }
    await saveActionModuleDraft(handle.db, mod.id, {
      baseRevision: 1,
      content: v2Content,
      actor: { id: actorId },
    })
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 2,
      actor: { id: actorId },
    })

    const after = await getScenario(handle.db, scenario.id)
    expect(after.published!.versionId).toBe(frozenVersionId)
    expect(JSON.stringify(after.published!.definition)).toBe(frozenDefinition)
    expect(JSON.stringify(after.published!.moduleManifest)).toBe(frozenManifest)
    expect(after.published!.definition.steps.some((step) => step.name === '回显v1')).toBe(true)
    expect(after.published!.definition.steps.some((step) => step.name === '回显v2')).toBe(false)

    const refs = await handle.db
      .select()
      .from(scenarioModuleRefs)
      .where(and(eq(scenarioModuleRefs.scenarioId, scenario.id), eq(scenarioModuleRefs.scenarioVersionId, frozenVersionId)))
    expect(refs).toHaveLength(1)
    expect(refs[0]!.moduleVersionId).toBe(v1Id)
  })

  it('AMB-12: 已有模块调用的草稿拒绝 V1 覆盖', async () => {
    const echoId = newId()
    const content: ModuleContent = {
      contract: {
        inputs: [{ key: 'msg', label: '消息', valueType: 'string', required: true }],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '验证输出', verification: { kind: 'output_required', outputKey: 'out' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [{ id: echoId, name: '回显', type: 'echo', effectType: 'READ_ONLY', input: { from: 'msg' }, outputKey: 'echo_msg' }],
          outputMapping: { out: 'echo_msg' },
        },
      ],
    }
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'legacy.block',
      name: '拒绝旧客户端',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, { baseRevision: 0, content, actor: { id: actorId } })
    await publishActionModule(handle.db, mod.id, {
      idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: actorId },
    })
    const versionId = (await listActionModuleVersions(handle.db, mod.id)).items[0]!.id
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '含调用后拒绝 V1',
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            moduleId: mod.id,
            moduleVersionId: versionId,
          },
        ],
      },
      actor: { id: actorId },
    })

    await expect(
      saveScenarioDraft(handle.db, scenario.id, {
        revision: 2,
        document: {
          schemaVersion: 1,
          inputs: [],
          steps: [{ id: newId(), name: '旧客户端覆盖', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
        },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORING_SCHEMA_UNSUPPORTED' })
  })

  it('AMB-10: 模块草稿试跑写入验证场景，发布引用草稿被阻断，验证场景不进普通列表', async () => {
    const echoId = newId()
    const content: ModuleContent = {
      contract: {
        inputs: [{ key: 'msg', label: '消息', valueType: 'string', required: true }],
        outputs: [{ key: 'out', label: '输出', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '验证输出', verification: { kind: 'output_required', outputKey: 'out' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [{ id: echoId, name: '回显草稿', type: 'echo', effectType: 'READ_ONLY', input: { from: 'msg' }, outputKey: 'echo_msg' }],
          outputMapping: { out: 'echo_msg' },
        },
      ],
    }
    const mod = await createActionModule(handle.db, {
      targetId,
      key: 'draft.trial',
      name: '草稿试跑',
      idempotencyKey: newId(),
      actor: { id: actorId },
    })
    await saveActionModuleDraft(handle.db, mod.id, { baseRevision: 0, content, actor: { id: actorId } })

    const prepared = await prepareModuleDraftTrial(handle.db, mod.id, {
      inputs: { msg: 'hello-draft' },
      actor: { id: actorId },
    })
    const trial = await createTrialRunFromDraft(handle.db, prepared.scenarioId, {
      revision: prepared.revision,
      actor: { id: actorId },
    })
    expect(trial.created).toBe(true)
    const entry = trial.detail.snapshot.moduleManifest?.entries[0]
    expect(entry?.moduleDraftRevision).toBe(1)
    expect(entry?.contentDigest).toBeTruthy()
    expect(trial.detail.snapshot.steps.some((step) => step.name === '回显草稿')).toBe(true)

    const listed = await listScenarios(handle.db, { targetId })
    expect(listed.items.some((item) => item.id === prepared.scenarioId)).toBe(false)

    const userScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '引用模块草稿的用户场景',
      steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, userScenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            moduleId: mod.id,
            moduleDraft: {
              moduleId: mod.id,
              revision: 1,
              contentDigest: entry!.contentDigest,
            },
            inputBindings: { msg: { kind: 'literal', value: 'no-publish' } },
          },
        ],
      },
      actor: { id: actorId },
    })
    await expect(
      publishScenarioDraft(handle.db, userScenario.id, { revision: 2, actor: { id: actorId } }),
    ).rejects.toMatchObject({
      code: 'SCENARIO_COMPILE_BLOCKED',
      details: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE' }),
        ]),
      },
    })
  })
})
