import { compileScenarioDocument, type ScenarioDocument } from '@cairn/shared'
import { describe, expect, it } from 'vitest'
import { applyFlowgramOrder, toFlowgram } from './adapter'

const document: ScenarioDocument = {
  schemaVersion: 1,
  inputs: [{ key: 'customer', label: '客户' }],
  steps: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'AI 提取',
      type: 'ai_extract',
      effectType: 'READ_ONLY',
      outputKey: 'order',
      policy: { timeoutMs: 90000, retryLimit: 0 },
      input: {
        instruction: '读取单号',
        outputSchema: {
          kind: 'object',
          fields: [{ name: 'id', type: 'string', required: true }],
        },
      },
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: '填写单号',
      type: 'fill',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '#order' }] },
        from: 'order',
        fromField: 'id',
      },
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'AI 判断',
      type: 'ai_assert',
      effectType: 'READ_ONLY',
      input: { instruction: '确认登记成功' },
    },
  ],
}

describe('FlowGram 与 Structured Step 边界', () => {
  it('往返保留 ID、输入、输出契约、策略和场景输入，投影与源对象不共享数据', () => {
    const graph = toFlowgram(document)
    expect(applyFlowgramOrder(document, graph)).toEqual(document)
    graph.nodes[0]!.data!.step.name = '画布内部修改'
    expect(document.steps[0]!.name).toBe('AI 提取')
    expect(applyFlowgramOrder(document, graph)).toEqual(document)
  })
  it('接收顺序时使用最新字段，拒绝旧画布数据覆盖属性编辑', () => {
    const graph = toFlowgram(document)
    graph.nodes = [graph.nodes[0]!, graph.nodes[2]!, graph.nodes[1]!]
    const latest = structuredClone(document)
    latest.steps[0]!.name = '已编辑的业务意图'
    const result = applyFlowgramOrder(latest, graph)
    expect(result.steps).toEqual([
      latest.steps[0],
      latest.steps[2],
      latest.steps[1],
    ])
    expect(result.inputs).toEqual(document.inputs)
  })
  it('把消费步骤移到输出之前，由原 Compiler 阻断执行', () => {
    expect(compileScenarioDocument(document, { mode: 'save' }).ok).toBe(true)
    const graph = toFlowgram(document)
    graph.nodes.reverse()
    const result = compileScenarioDocument(
      applyFlowgramOrder(document, graph),
      { mode: 'save' }
    )
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics.some(
        (item) =>
          item.stepId === document.steps[1]!.id && item.severity === 'error'
      )
    ).toBe(true)
  })
  it.each(['duplicate', 'unknown', 'missing', 'branch', 'type'])(
    '拒绝不受支持的结构：%s',
    (kind) => {
      const graph = toFlowgram(document)
      if (kind === 'duplicate') graph.nodes[1]!.id = graph.nodes[0]!.id
      if (kind === 'unknown') graph.nodes[0]!.id = 'unknown'
      if (kind === 'missing') graph.nodes.pop()
      if (kind === 'branch')
        graph.nodes[0]!.blocks = [{ id: 'hidden', type: 'branch' }]
      if (kind === 'type') graph.nodes[0]!.type = 'other'
      expect(() => applyFlowgramOrder(document, graph)).toThrow(
        '画布结构与场景不一致'
      )
    }
  )
  it('V2 往返保留调用节点与绑定，不另存图结构事实', () => {
    const v2 = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1 as const,
      inputs: [{ key: 'customer', label: '客户' }],
      nodes: [
        { kind: 'step' as const, step: document.steps[0]! },
        {
          kind: 'module' as const,
          invocationId: '44444444-4444-4444-8444-444444444444',
          name: '统一登录',
          moduleId: '55555555-5555-4555-8555-555555555555',
          moduleVersionId: '66666666-6666-4666-8666-666666666666',
          implementationKey: 'default',
          inputBindings: { user: { kind: 'from' as const, key: 'order', field: 'id' } },
          outputBindings: { token: 'sessionToken' },
        },
        { kind: 'step' as const, step: document.steps[2]! },
      ],
    }
    const graph = toFlowgram(v2)
    expect(graph.nodes.map((node) => node.id)).toEqual([
      document.steps[0]!.id,
      '44444444-4444-4444-8444-444444444444',
      document.steps[2]!.id,
    ])
    expect(graph.nodes[1]!.data?.nodeKind).toBe('module')
    const roundtrip = applyFlowgramOrder(v2, graph)
    expect(roundtrip).toEqual(v2)
    graph.nodes = [graph.nodes[2]!, graph.nodes[1]!, graph.nodes[0]!]
    const reordered = applyFlowgramOrder(v2, graph)
    expect(reordered.nodes.map((node) => (node.kind === 'step' ? node.step.id : node.invocationId))).toEqual([
      document.steps[2]!.id,
      '44444444-4444-4444-8444-444444444444',
      document.steps[0]!.id,
    ])
    expect(reordered.nodes[1]).toEqual(v2.nodes[1])
  })
})
