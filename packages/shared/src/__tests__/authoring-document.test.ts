import { describe, expect, it } from 'vitest'
import {
  authoringNodeId,
  authoringSteps,
  insertNodeAfter,
  insertNodeAt,
  isAuthoringDocumentV2,
  locateNode,
  moveNodeWithin,
  nodesBefore,
  normalizeAuthoringDocument,
  removeNode,
  replaceNode,
  replaceNodeWithMany,
  unwrapBlock,
  wrapNodesInIfBlock,
  saveScenarioDraftBodySchema,
  scenarioAuthoringDocumentV2Schema,
  walkAuthoringNodes,
  authoringStepOriginSchema,
  CANDIDATE_GROUPS_PROTOCOL,
  MODULE_MANIFEST_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
  type ScenarioDocument,
} from '../index.js'

describe('ScenarioAuthoringDocument V2', () => {
  it('声明正确的 Worker 协议常量', () => {
    expect(MODULE_MANIFEST_PROTOCOL).toBe('snapshot.moduleManifest@1')
    expect(CANDIDATE_GROUPS_PROTOCOL).toBe('snapshot.candidateGroups@1')
    expect(RUNTIME_INVARIANT_MANIFEST_PROTOCOL).toBe('snapshot.runtimeInvariantManifest@1')
  })

  it('能校验合法的 V2 编写文档（含普通步骤与动作模块调用）', () => {
    const doc = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'orderNo', label: '订单编号' }],
      nodes: [
        {
          kind: 'step',
          step: {
            id: '11111111-1111-4111-8111-111111111111',
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
        },
        {
          kind: 'module',
          invocationId: '22222222-2222-4222-8222-222222222222',
          name: '查询订单',
          moduleId: '33333333-3333-4333-8333-333333333333',
          moduleVersionId: '44444444-4444-4444-8444-444444444444',
          implementationKey: 'default',
          inputBindings: {
            orderId: { kind: 'from', key: 'orderNo' },
          },
          outputBindings: {
            orderStatus: 'status',
          },
        },
      ],
    }

    const parsed = scenarioAuthoringDocumentV2Schema.parse(doc)
    expect(parsed.nodes).toHaveLength(2)
    expect(isAuthoringDocumentV2(parsed)).toBe(true)
  })

  it('模块调用节点必须提供 moduleVersionId 或 moduleDraft', () => {
    const doc = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId: '22222222-2222-4222-8222-222222222222',
          moduleId: '33333333-3333-4333-8333-333333333333',
          // 缺少 moduleVersionId 和 moduleDraft
        },
      ],
    }
    expect(() => scenarioAuthoringDocumentV2Schema.parse(doc)).toThrow(
      /必须提供 moduleVersionId 或 moduleDraft/,
    )
  })

  it('normalizeAuthoringDocument 能无损将 V1 场景转换为 V2 文档', () => {
    const v1Doc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [{ key: 'userId', label: '用户ID' }],
      steps: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: '延时等待',
          type: 'delay',
          effectType: 'READ_ONLY',
          input: { durationMs: 1000 },
        },
      ],
    }

    expect(isAuthoringDocumentV2(v1Doc)).toBe(false)
    const normalized = normalizeAuthoringDocument(v1Doc)
    expect(normalized.authoringSchemaVersion).toBe(2)
    expect(normalized.inputs).toEqual(v1Doc.inputs)
    expect(normalized.nodes).toHaveLength(1)
    expect(normalized.nodes[0]).toEqual({
      kind: 'step',
      step: v1Doc.steps[0],
    })
  })

  it('保存草稿契约同时接受 V1 与 V2', () => {
    const v1 = saveScenarioDraftBodySchema.parse({
      revision: 1,
      document: {
        schemaVersion: 1,
        inputs: [],
        steps: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: '延时等待',
            type: 'delay',
            effectType: 'READ_ONLY',
            input: { durationMs: 1000 },
          },
        ],
      },
    })
    expect('steps' in v1.document).toBe(true)

    const v2 = saveScenarioDraftBodySchema.parse({
      revision: 2,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '22222222-2222-4222-8222-222222222222',
            moduleId: '33333333-3333-4333-8333-333333333333',
            moduleVersionId: '44444444-4444-4444-8444-444444444444',
          },
        ],
      },
    })
    expect(isAuthoringDocumentV2(v2.document)).toBe(true)
    expect(authoringSteps(v1.document).map((step) => step.type)).toEqual(['delay'])
    expect(authoringSteps(v2.document)).toEqual([])
  })

  it('运行期约束与成功条件 id 不能重复', () => {
    expect(() =>
      scenarioAuthoringDocumentV2Schema.parse({
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: '11111111-1111-4111-8111-111111111111',
              name: '打开页面',
              type: 'navigate',
              effectType: 'READ_ONLY',
              input: { url: 'https://example.com' },
            },
          },
        ],
        scenarioOutcomes: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            scope: 'scenario',
            meaning: '页面打开',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            rule: { kind: 'deterministic', expect: { kind: 'visible' } },
          },
        ],
        runtimeInvariants: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            meaning: '不得离开允许的访问范围',
            kind: 'navigation_boundary',
            severity: 'MUST',
            onViolation: 'halt',
            evaluateAt: 'step_boundary',
          },
        ],
      }),
    ).toThrow(/成功条件 id 不能重复/)
  })
})

describe('CFA-10 / A5 编写文档统一遍历器与 ID 寻址操作', () => {
  const step1 = {
    kind: 'step' as const,
    step: {
      id: '11111111-1111-4111-8111-111111111111',
      name: '第一步',
      type: 'navigate' as const,
      effectType: 'READ_ONLY' as const,
      input: { url: 'https://example.com' },
    },
  }
  const step2 = {
    kind: 'step' as const,
    step: {
      id: '22222222-2222-4222-8222-222222222222',
      name: '第二步',
      type: 'delay' as const,
      effectType: 'READ_ONLY' as const,
      input: { durationMs: 100 },
    },
  }
  const moduleNode = {
    kind: 'module' as const,
    invocationId: '33333333-3333-4333-8333-333333333333',
    name: '动作模块',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
    implementationKey: 'default',
    inputBindings: {},
    outputBindings: {},
  }

  const sampleDoc = {
    authoringSchemaVersion: 2 as const,
    schemaVersion: 1 as const,
    inputs: [],
    nodes: [step1, step2, moduleNode],
  }

  it('walkAuthoringNodes 先序给出节点元数据，authoringSteps 递归提取步骤', () => {
    const items = walkAuthoringNodes(sampleDoc)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ id: step1.step.id, depth: 0, index: 0 })
    expect(items[1]).toMatchObject({ id: step2.step.id, depth: 0, index: 1 })
    expect(items[2]).toMatchObject({ id: moduleNode.invocationId, depth: 0, index: 2 })

    // authoringSteps 仅收集 StepNode
    const steps = authoringSteps(sampleDoc)
    expect(steps).toHaveLength(2)
    expect(steps.map((s) => s.id)).toEqual([step1.step.id, step2.step.id])
  })

  it('locateNode 依据 ID 精确给出位置信息', () => {
    expect(locateNode(sampleDoc, step1.step.id)).toEqual({ parentId: undefined, branchKey: undefined, index: 0 })
    expect(locateNode(sampleDoc, step2.step.id)).toEqual({ parentId: undefined, branchKey: undefined, index: 1 })
    expect(locateNode(sampleDoc, moduleNode.invocationId)).toEqual({ parentId: undefined, branchKey: undefined, index: 2 })
    expect(locateNode(sampleDoc, 'non-existent-id')).toBeUndefined()
  })

  it('insertNodeAfter 与 insertNodeAt 在指定位置插入节点', () => {
    const newStep = {
      kind: 'step' as const,
      step: {
        id: '99999999-9999-4999-8999-999999999999',
        name: '插入步',
        type: 'delay' as const,
        effectType: 'READ_ONLY' as const,
        input: { durationMs: 200 },
      },
    }

    // 在第一步后插入
    const afterFirst = insertNodeAfter(sampleDoc, step1.step.id, newStep)
    expect(afterFirst.nodes).toHaveLength(4)
    expect(afterFirst.nodes[1]?.kind === 'step' && afterFirst.nodes[1].step.id).toBe(newStep.step.id)

    // anchorId 为空插入到开头
    const atStart = insertNodeAfter(sampleDoc, null, newStep)
    expect(atStart.nodes[0]?.kind === 'step' && atStart.nodes[0].step.id).toBe(newStep.step.id)

    // insertNodeAt
    const atIndex2 = insertNodeAt(sampleDoc, { index: 2 }, newStep)
    expect(atIndex2.nodes[2]?.kind === 'step' && atIndex2.nodes[2].step.id).toBe(newStep.step.id)
  })

  it('removeNode、replaceNode 与 moveNodeWithin 纯函数正确变更节点', () => {
    // 移除第二步
    const removed = removeNode(sampleDoc, step2.step.id)
    expect(removed.nodes).toHaveLength(2)
    expect(removed.nodes.map(authoringNodeId)).toEqual([step1.step.id, moduleNode.invocationId])

    // 替换第二步
    const replacedStep = {
      ...step2,
      step: { ...step2.step, name: '替换后的第二步' },
    }
    const replaced = replaceNode(sampleDoc, step2.step.id, replacedStep)
    expect(replaced.nodes).toHaveLength(3)
    expect(replaced.nodes[1]?.kind === 'step' && replaced.nodes[1].step.name).toBe('替换后的第二步')

    // 向后移动第一步 delta = +1
    const moved = moveNodeWithin(sampleDoc, step1.step.id, 1)
    expect(moved.nodes.map(authoringNodeId)).toEqual([step2.step.id, step1.step.id, moduleNode.invocationId])
  })

  it('nodesBefore 返回某节点之前、执行上可见的节点', () => {
    expect(nodesBefore(sampleDoc, step1.step.id)).toEqual([])
    expect(nodesBefore(sampleDoc, step2.step.id).map(authoringNodeId)).toEqual([step1.step.id])
    expect(nodesBefore(sampleDoc, moduleNode.invocationId).map(authoringNodeId)).toEqual([
      step1.step.id,
      step2.step.id,
    ])
  })
})


describe('包裹为条件块 / 解除包裹（复查修复）', () => {
  const step = (id: string) => ({
    kind: 'step' as const,
    step: { id, name: id.slice(-1), type: 'echo' as const, effectType: 'READ_ONLY' as const, input: { value: 1 } },
  })
  const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003']
  const blockId = '20000000-0000-4000-8000-000000000001'
  const doc = scenarioAuthoringDocumentV2Schema.parse({
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [],
    nodes: ids.map(step),
  })

  it('连续节点包进条件块，位置不变；解除后恢复原样', () => {
    const wrapped = wrapNodesInIfBlock(doc, [ids[1]!, ids[2]!], { blockId })
    expect(wrapped.ok).toBe(true)
    if (!wrapped.ok) return
    expect(wrapped.document.nodes.map((n) => authoringNodeId(n))).toEqual([ids[0], blockId])
    const unwrapped = unwrapBlock(wrapped.document, blockId)
    expect(unwrapped.ok && unwrapped.document.nodes.map((n) => authoringNodeId(n))).toEqual(ids)
  })

  it('不连续或跨层级的选择被拒绝', () => {
    expect(wrapNodesInIfBlock(doc, [ids[0]!, ids[2]!], { blockId }).ok).toBe(false)
    const wrapped = wrapNodesInIfBlock(doc, [ids[1]!], { blockId })
    if (!wrapped.ok) throw new Error(wrapped.reason)
    expect(wrapNodesInIfBlock(wrapped.document, [ids[0]!, ids[1]!], { blockId: '20000000-0000-4000-8000-000000000002' }).ok).toBe(false)
  })

  it('带否则分支的条件块不能直接解除', () => {
    const wrapped = wrapNodesInIfBlock(doc, [ids[1]!], { blockId })
    if (!wrapped.ok) throw new Error(wrapped.reason)
    const withElse = {
      ...wrapped.document,
      nodes: wrapped.document.nodes.map((n) => (authoringNodeId(n) === blockId ? { ...n, else: [step(ids[2]!)] } : n)),
    }
    const withElseDoc = { ...withElse, nodes: withElse.nodes.filter((n, i) => i < 2) } as typeof doc
    const result = unwrapBlock(withElseDoc, blockId)
    expect(result.ok).toBe(false)
  })

  it('replaceNodeWithMany 将单节点替换为序列，并支持嵌套分支', () => {
    const wrapped = wrapNodesInIfBlock(doc, [ids[1]!, ids[2]!], { blockId })
    expect(wrapped.ok).toBe(true)
    if (!wrapped.ok) return

    // 在 if 块的 then 分支中将 ids[1] 替换为两个新步骤
    const repA = step('30000000-0000-4000-8000-00000000000a')
    const repB = step('30000000-0000-4000-8000-00000000000b')
    const replacedNested = replaceNodeWithMany(wrapped.document, ids[1]!, [repA, repB])
    const ifNode = replacedNested.nodes.find((n) => authoringNodeId(n) === blockId) as any
    expect(ifNode?.then.map(authoringNodeId)).toEqual([
      '30000000-0000-4000-8000-00000000000a',
      '30000000-0000-4000-8000-00000000000b',
      ids[2],
    ])
  })

  it('authoringStepOriginSchema 兼容历史无 kind 形状与新 AI 固化来源', () => {
    const legacy = {
      moduleVersionId: '00000000-0000-4000-8000-000000000001',
      invocationId: '00000000-0000-4000-8000-000000000002',
    }
    const parsedLegacy = authoringStepOriginSchema.parse(legacy)
    expect(parsedLegacy.moduleVersionId).toBe(legacy.moduleVersionId)

    const solidification = {
      kind: 'ai_solidification' as const,
      sourceStepId: '00000000-0000-4000-8000-000000000003',
      instruction: '点击登录按钮',
      runId: '00000000-0000-4000-8000-000000000004',
      attemptId: '00000000-0000-4000-8000-000000000005',
    }
    const parsedSolidification = authoringStepOriginSchema.parse(solidification)
    expect(parsedSolidification.kind).toBe('ai_solidification')
  })
})

