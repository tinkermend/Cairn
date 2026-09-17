import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  type AuthoringModuleInvocation,
  type ModuleContent,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import {
  deterministicStepId,
  expandAuthoringDocument,
  moduleContentDigest,
  type ExpansionContext,
  type LoadedModuleVersion,
} from '../index.js'

describe('AM-B: 编写展开纯函数 (expandAuthoringDocument)', () => {
  const targetId = '11111111-1111-4111-8111-111111111111'
  const moduleId = '22222222-2222-4222-8222-222222222222'
  const versionId = '33333333-3333-4333-8333-333333333333'
  const priorStepId = '10000000-0000-4000-8000-000000000099'
  const priorOutput = 'priorOrder'

  const dummyContent: ModuleContent = {
    contract: {
      inputs: [
        { key: 'orderId', label: '订单号', valueType: 'string', required: true },
        { key: 'force', label: '强制执行', valueType: 'boolean', required: false },
      ],
      outputs: [
        { key: 'orderStatus', label: '订单状态', shape: { kind: 'scalar', type: 'string' } },
      ],
      preconditions: [],
      postconditions: [
        {
          meaning: '订单状态必须输出',
          verification: { kind: 'output_required', outputKey: 'orderStatus' },
        },
      ],
      effectCeiling: 'SIDE_EFFECT',
    },
    implementations: [
      {
        implementationKey: 'default',
        kind: 'structured_steps',
        steps: [
          {
            id: 'step-fill-id',
            name: '填入订单号',
            type: 'fill',
            effectType: 'READ_ONLY',
            input: {
              target: { framePath: [], candidates: [{ by: 'css', value: '#order-id' }] },
              from: 'orderId',
            },
          },
          {
            id: 'step-click-cancel',
            name: '点击取消',
            type: 'click',
            effectType: 'SIDE_EFFECT',
            input: {
              target: { framePath: [], candidates: [{ by: 'css', value: '#btn-cancel' }] },
            },
          },
          {
            id: 'step-extract-status',
            name: '提取状态',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'orderStatus',
            input: {
              target: { framePath: [], candidates: [{ by: 'css', value: '#status-text' }] },
              as: 'text',
            },
          },
        ],
        outputMapping: {
          // AM-A 语义：{ 模块输出 key: 实现内部步骤的 outputKey }
          orderStatus: 'orderStatus',
        },
      },
    ],
  }

  const dummyLoadedModule: LoadedModuleVersion = {
    moduleId,
    targetId,
    moduleKey: 'order.cancel',
    name: '取消订单',
    versionId,
    versionNo: 1,
    publicationStatus: 'published',
    contentDigest: moduleContentDigest(dummyContent),
    contractDigest: 'sha256:dummycontractdigest',
    implementationDigest: 'sha256:dummyimpldigest',
    content: dummyContent,
  }

  function ctx(overrides: Partial<ExpansionContext> = {}): ExpansionContext {
    return {
      targetId,
      mode: 'publish',
      loadedModules: new Map([[versionId, dummyLoadedModule]]),
      ...overrides,
    }
  }

  function invoke(
    inputBindings: AuthoringModuleInvocation['inputBindings'],
    extra: Partial<ScenarioAuthoringDocumentV2> = {},
  ): ScenarioAuthoringDocumentV2 {
    return {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: extra.inputs ?? [{ key: 'sceneOrderId', label: '场景订单号' }],
      nodes: extra.nodes ?? [
        {
          kind: 'module',
          invocationId: '20000000-0000-4000-8000-000000000001',
          name: '执行取消',
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings,
          outputBindings: { orderStatus: 'sceneStatus' },
        },
      ],
    }
  }

  it('AMB-06: deterministicStepId 跨调用重复生成完全一致且符合 UUID 格式', () => {
    const invId = '44444444-4444-4444-8444-444444444444'
    const stepA = deterministicStepId(invId, 'step-fill-id')
    const stepA2 = deterministicStepId(invId, 'step-fill-id')
    const stepB = deterministicStepId(invId, 'step-click-cancel')

    expect(stepA).toBe(stepA2)
    expect(stepA).not.toBe(stepB)
    expect(stepA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('AMB-01 & AMB-03: 字面量、场景输入、前序输出加字段三种绑定都能正确改写', () => {
    const literal = expandAuthoringDocument(
      invoke({ orderId: { kind: 'literal', value: 'ORD-1' } }),
      ctx(),
    )
    expect(literal.ok).toBe(true)
    expect((literal.definition!.steps[0]!.input as { value?: unknown }).value).toBe('ORD-1')
    expect((literal.definition!.steps[0]!.input as { from?: unknown }).from).toBeUndefined()
    expect(literal.definition!.steps[1]!.type).toBe('click')
    expect(literal.definition!.steps[1]!.effectType).toBe('SIDE_EFFECT')
    expect(literal.definition!.steps[2]!.outputKey).toBe('sceneStatus')

    const fromInput = expandAuthoringDocument(
      invoke({ orderId: { kind: 'from', key: 'sceneOrderId' } }),
      ctx(),
    )
    expect(fromInput.ok).toBe(true)
    expect((fromInput.definition!.steps[0]!.input as { from?: string }).from).toBe('sceneOrderId')

    const fromPrior = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: priorStepId,
              name: '前序提取',
              type: 'ai_extract',
              effectType: 'READ_ONLY',
              outputKey: priorOutput,
              input: {
                instruction: '读取单号',
                outputSchema: {
                  kind: 'object',
                  fields: [{ name: 'id', type: 'string', required: true }],
                },
              },
            },
          },
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            moduleId,
            moduleVersionId: versionId,
            inputBindings: { orderId: { kind: 'from', key: priorOutput, field: 'id' } },
            outputBindings: { orderStatus: 'sceneStatus' },
          },
        ],
      },
      ctx(),
    )
    expect(fromPrior.ok).toBe(true)
    expect((fromPrior.definition!.steps[1]!.input as { from?: string; fromField?: string }).from).toBe(priorOutput)
    expect((fromPrior.definition!.steps[1]!.input as { fromField?: string }).fromField).toBe('id')
  })

  it('AMB-04: 暴露名冲突报诊断；未暴露内部输出不能按原名引用', () => {
    const conflict = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: priorStepId,
              name: '已有输出',
              type: 'echo',
              effectType: 'READ_ONLY',
              outputKey: 'sceneStatus',
              input: { value: 'exists' },
            },
          },
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            moduleId,
            moduleVersionId: versionId,
            inputBindings: { orderId: { kind: 'literal', value: 'ORD-1' } },
            outputBindings: { orderStatus: 'sceneStatus' },
          },
        ],
      },
      ctx(),
    )
    expect(conflict.ok).toBe(false)
    expect(conflict.diagnostics.some((d) => d.code === 'SCENARIO_OUTPUT_KEY_DUPLICATE')).toBe(true)

    const hidden = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            moduleId,
            moduleVersionId: versionId,
            inputBindings: { orderId: { kind: 'literal', value: 'ORD-1' } },
            outputBindings: {},
          },
          {
            kind: 'step',
            step: {
              id: '10000000-0000-4000-8000-000000000088',
              name: '误用内部键',
              type: 'echo',
              effectType: 'READ_ONLY',
              input: { from: 'orderStatus' },
            },
          },
        ],
      },
      ctx(),
    )
    expect(hidden.ok).toBe(false)
    expect(
      hidden.diagnostics.some(
        (d) => d.code === 'SCENARIO_UNRESOLVED_REF' || d.code === 'SCENARIO_FORWARD_REF',
      ),
    ).toBe(true)
    expect(hidden.definition?.steps.find((s) => s.name === '提取状态')?.outputKey).toBe('m0_orderStatus')
  })

  it('AMB-04: 模块输出 key 与内部 outputKey 不同名时，级联改写仍然自洽', () => {
    const aliasedContent: ModuleContent = {
      contract: {
        inputs: [],
        outputs: [{ key: 'orderStatus', label: '状态', shape: { kind: 'scalar', type: 'string' } }],
        preconditions: [],
        postconditions: [
          { meaning: '状态必须输出', verification: { kind: 'output_required', outputKey: 'orderStatus' } },
        ],
        effectCeiling: 'READ_ONLY',
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: 'step-extract-raw',
              name: '提取原始状态',
              type: 'extract',
              effectType: 'READ_ONLY',
              outputKey: 'rawStatus',
              input: {
                target: { framePath: [], candidates: [{ by: 'css', value: '#status' }] },
                as: 'text',
              },
            },
            {
              id: 'step-echo-raw',
              name: '回显原始状态',
              type: 'echo',
              effectType: 'READ_ONLY',
              outputKey: 'echoed',
              input: { from: 'rawStatus' },
            },
          ],
          // 模块输出 key（orderStatus）与内部步骤 outputKey（rawStatus）不同名
          outputMapping: { orderStatus: 'rawStatus' },
        },
      ],
    }
    const aliasedLoaded: LoadedModuleVersion = {
      ...dummyLoadedModule,
      content: aliasedContent,
      contentDigest: moduleContentDigest(aliasedContent),
    }
    const aliasedCtx = ctx({ loadedModules: new Map([[versionId, aliasedLoaded]]) })
    const makeDoc = (outputBindings: Record<string, string>): ScenarioAuthoringDocumentV2 => ({
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId: '20000000-0000-4000-8000-000000000001',
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings: {},
          outputBindings,
        },
      ],
    })

    const exposed = expandAuthoringDocument(makeDoc({ orderStatus: 'sceneStatus' }), aliasedCtx)
    expect(exposed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(exposed.ok).toBe(true)
    expect(exposed.definition!.steps[0]!.outputKey).toBe('sceneStatus')
    // 内部后续步骤的引用必须跟着改写到同一个键，不能指向已消失的原名或另一个私有名
    expect((exposed.definition!.steps[1]!.input as { from?: string }).from).toBe('sceneStatus')

    const hidden = expandAuthoringDocument(makeDoc({}), aliasedCtx)
    expect(hidden.ok).toBe(true)
    expect(hidden.definition!.steps[0]!.outputKey).toBe('m0_orderStatus')
    expect((hidden.definition!.steps[1]!.input as { from?: string }).from).toBe('m0_orderStatus')
  })

  it('AMB-02: 同一场景内两次调用同一模块，生成互不冲突的 StepId 与 OutputKey', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [
        { key: 'order1', label: '订单1' },
        { key: 'order2', label: '订单2' },
      ],
      nodes: [
        {
          kind: 'module',
          invocationId: '20000000-0000-4000-8000-000000000001',
          name: '取消订单1',
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings: { orderId: { kind: 'from', key: 'order1' } },
          outputBindings: { orderStatus: 'status1' },
        },
        {
          kind: 'module',
          invocationId: '20000000-0000-4000-8000-000000000002',
          name: '取消订单2',
          moduleId,
          moduleVersionId: versionId,
          implementationKey: 'default',
          inputBindings: { orderId: { kind: 'from', key: 'order2' } },
          outputBindings: {},
        },
      ],
    }

    const result = expandAuthoringDocument(doc, ctx())
    expect(result.ok).toBe(true)
    expect(result.definition!.steps).toHaveLength(6)

    const stepIds = new Set(result.definition!.steps.map((s) => s.id))
    expect(stepIds.size).toBe(6)

    const call2ExtractStep = result.definition!.steps[5]!
    expect(call2ExtractStep.outputKey).toBe('m1_orderStatus')
  })

  it('AMB-03: 缺必填、类型不符、前向引用和不支持的字段分别报诊断', () => {
    const unbound = expandAuthoringDocument(invoke({}), ctx())
    expect(unbound.ok).toBe(false)
    expect(unbound.diagnostics.some((d) => d.code === 'MODULE_INPUT_UNBOUND')).toBe(true)

    const mismatch = expandAuthoringDocument(
      invoke({ orderId: { kind: 'literal', value: 123456 } }),
      ctx(),
    )
    expect(mismatch.ok).toBe(false)
    expect(mismatch.diagnostics.some((d) => d.code === 'MODULE_INPUT_TYPE_MISMATCH')).toBe(true)

    const forward = expandAuthoringDocument(
      invoke({ orderId: { kind: 'from', key: 'notYet' } }),
      ctx(),
    )
    expect(forward.ok).toBe(false)
    expect(forward.diagnostics.some((d) => d.code === 'SCENARIO_FORWARD_REF')).toBe(true)

    const locateContent: ModuleContent = {
      contract: {
        inputs: [{ key: 'keyword', label: '关键词', valueType: 'string', required: true }],
        outputs: [],
        preconditions: [],
        postconditions: [],
        effectCeiling: 'READ_ONLY',
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: 'step-extract',
              name: '按输入定位',
              type: 'extract',
              effectType: 'READ_ONLY',
              input: {
                from: 'keyword',
                target: { framePath: [], candidates: [{ by: 'css', value: '#grid' }] },
                as: 'text',
              } as never,
            },
          ],
          outputMapping: {},
        },
      ],
    }
    const locateLoaded: LoadedModuleVersion = {
      ...dummyLoadedModule,
      content: locateContent,
      contentDigest: moduleContentDigest(locateContent),
    }
    const unsupported = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            moduleId,
            moduleVersionId: versionId,
            inputBindings: { keyword: { kind: 'literal', value: 'Mysql_主' } },
            outputBindings: {},
          },
        ],
      },
      ctx({ loadedModules: new Map([[versionId, locateLoaded]]) }),
    )
    expect(unsupported.ok).toBe(false)
    expect(unsupported.diagnostics.some((d) => d.code === 'MODULE_BINDING_UNSUPPORTED')).toBe(true)
  })

  it('AMB-05: 展开后恰好 32 步通过，33 步阻断并列出各调用步数', () => {
    const makeContent = (count: number): ModuleContent => ({
      contract: { inputs: [], outputs: [], preconditions: [], postconditions: [], effectCeiling: 'READ_ONLY' },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: Array.from({ length: count }, (_, i) => ({
            id: `step-${i}`,
            name: `步 ${i}`,
            type: 'delay',
            effectType: 'READ_ONLY',
            input: { durationMs: 10 },
          })),
          outputMapping: {},
        },
      ],
    })

    const exactContent = makeContent(32)
    const exactLoaded: LoadedModuleVersion = {
      ...dummyLoadedModule,
      content: exactContent,
      contentDigest: moduleContentDigest(exactContent),
    }
    const exact = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            moduleId,
            moduleVersionId: versionId,
            implementationKey: 'default',
            inputBindings: {},
            outputBindings: {},
          },
        ],
      },
      ctx({ loadedModules: new Map([[versionId, exactLoaded]]) }),
    )
    expect(exact.ok).toBe(true)
    expect(exact.definition!.steps).toHaveLength(32)

    const overContentA = makeContent(16)
    const overContentB = makeContent(17)
    const overLoadedA: LoadedModuleVersion = {
      ...dummyLoadedModule,
      content: overContentA,
      contentDigest: moduleContentDigest(overContentA),
    }
    const overLoadedB: LoadedModuleVersion = {
      ...dummyLoadedModule,
      content: overContentB,
      contentDigest: moduleContentDigest(overContentB),
    }
    const over = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            name: '第一组',
            moduleId,
            moduleVersionId: versionId,
            implementationKey: 'default',
            inputBindings: {},
            outputBindings: {},
          },
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000002',
            name: '第二组',
            moduleId,
            moduleVersionId: '33333333-3333-4333-8333-333333333334',
            implementationKey: 'default',
            inputBindings: {},
            outputBindings: {},
          },
        ],
      },
      ctx({
        loadedModules: new Map([
          [versionId, overLoadedA],
          ['33333333-3333-4333-8333-333333333334', overLoadedB],
        ]),
      }),
    )
    expect(over.ok).toBe(false)
    const limit = over.diagnostics.find((d) => d.code === 'SCENARIO_EXPANDED_STEP_LIMIT')
    expect(limit?.message).toContain('33')
    expect(limit?.message).toContain('第一组')
    expect(limit?.message).toContain('16步')
    expect(limit?.message).toContain('17步')
  })

  it('AMB-06: 同样输入重复编译摘要相同；只改调用顺序得到不同但稳定的结果', () => {
    const doc = invoke({ orderId: { kind: 'literal', value: 'ORD-1' } })
    const first = expandAuthoringDocument(doc, ctx())
    const second = expandAuthoringDocument(structuredClone(doc), ctx())
    expect(first.ok).toBe(true)
    expect(first.sourceDigest).toBe(second.sourceDigest)
    expect(canonicalJson(first.definition)).toBe(canonicalJson(second.definition))
    expect(canonicalJson(first.manifest)).toBe(canonicalJson(second.manifest))

    const reordered: ScenarioAuthoringDocumentV2 = {
      ...doc,
      nodes: [
        {
          kind: 'step',
          step: {
            id: priorStepId,
            name: '前置等待',
            type: 'delay',
            effectType: 'READ_ONLY',
            input: { durationMs: 10 },
          },
        },
        ...doc.nodes,
      ],
    }
    const third = expandAuthoringDocument(reordered, ctx())
    const fourth = expandAuthoringDocument(structuredClone(reordered), ctx())
    expect(third.sourceDigest).not.toBe(first.sourceDigest)
    expect(third.sourceDigest).toBe(fourth.sourceDigest)
  })

  it('AMB-10: 正式发布模式下引用草稿被 MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE 阻断', () => {
    const digest = dummyLoadedModule.contentDigest
    const result = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000001',
            moduleId,
            moduleDraft: {
              moduleId,
              revision: 1,
              contentDigest: digest,
            },
            inputBindings: { orderId: { kind: 'literal', value: 'ORD-123' } },
            outputBindings: {},
          },
        ],
      },
      ctx({ loadedModules: new Map([[moduleId, dummyLoadedModule]]) }),
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === 'MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE')).toBe(true)
  })

  it('AMB-10: 发布模式引用草稿即使未加载模块也报 MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE', () => {
    const result = expandAuthoringDocument(
      {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '20000000-0000-4000-8000-000000000002',
            moduleId,
            moduleDraft: {
              moduleId,
              revision: 1,
              contentDigest: dummyLoadedModule.contentDigest,
            },
            inputBindings: { orderId: { kind: 'literal', value: 'ORD-123' } },
            outputBindings: {},
          },
        ],
      },
      ctx({ loadedModules: new Map() }),
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual(['MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE'])
  })

  it('实现含嵌套调用时报 MODULE_NESTING_FORBIDDEN', () => {
    const nested: ModuleContent = {
      ...dummyContent,
      implementations: [
        {
          ...dummyContent.implementations[0]!,
          steps: [
            {
              ...(dummyContent.implementations[0]!.steps[0]!),
              type: 'module_invocation',
            } as never,
          ],
        },
      ],
    }
    const loaded: LoadedModuleVersion = {
      ...dummyLoadedModule,
      content: nested,
      contentDigest: moduleContentDigest(nested),
    }
    const result = expandAuthoringDocument(
      invoke({ orderId: { kind: 'literal', value: 'ORD-1' } }),
      ctx({ loadedModules: new Map([[versionId, loaded]]) }),
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === 'MODULE_NESTING_FORBIDDEN')).toBe(true)
  })

  it('记录摘要与实际内容不一致时报 MODULE_DIGEST_MISMATCH', () => {
    const loaded: LoadedModuleVersion = {
      ...dummyLoadedModule,
      contentDigest: 'deadbeef',
    }
    const result = expandAuthoringDocument(
      invoke({ orderId: { kind: 'literal', value: 'ORD-1' } }),
      ctx({ loadedModules: new Map([[versionId, loaded]]) }),
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === 'MODULE_DIGEST_MISMATCH')).toBe(true)
  })
})
