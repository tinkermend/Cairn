import { describe, expect, it } from 'vitest'
import type { ScenarioDocument, Step } from '@cairn/shared'
import {
  authoringNodeLabel,
  bindingUiKind,
  documentNodeCount,
  documentUsesBrowser,
  fieldElementId,
  findInsertedModuleInvocationId,
  insertNode,
  insertStep,
  isTypingTarget,
  moveNode,
  moveStep,
  outputConsumers,
  priorBindings,
  priorBindingsV2,
  priorOutputShapesAny,
  removeAuthoringNode,
  tryReplaceInputs,
  tryReplaceNode,
  tryReplaceStep,
  uniqueOutputKey,
} from './studio-document'
import type { ScenarioAuthoringDocumentV2 } from '@cairn/shared'

const navigate: Step = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '打开',
  type: 'navigate',
  effectType: 'SIDE_EFFECT',
  input: { url: 'https://shop.example.com' },
}

const extract: Step = {
  id: '22222222-2222-4222-8222-222222222222',
  name: '提取',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'extracted',
  input: { target: { framePath: [], candidates: [{ by: 'label', value: '单号' }] }, as: 'text' },
}

const echo: Step = {
  id: '33333333-3333-4333-8333-333333333333',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { from: 'extracted' },
}

const later: Step = {
  id: '44444444-4444-4444-8444-444444444444',
  name: '后序提取',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'later',
  input: { target: { framePath: [], candidates: [{ by: 'label', value: '金额' }] }, as: 'text' },
}

function doc(steps: Step[]): ScenarioDocument {
  return { schemaVersion: 1, inputs: [{ key: 'orderId', label: '订单号' }], steps }
}

describe('studio-document', () => {
  it('输出名按已占用键去重', () => {
    expect(uniqueOutputKey('extracted', new Set())).toBe('extracted')
    expect(uniqueOutputKey('extracted', new Set(['extracted']))).toBe('extracted2')
    expect(uniqueOutputKey('extracted', new Set(['extracted', 'extracted2']))).toBe('extracted3')
  })

  it('绑定候选只含场景输入和前序输出，并保留失效引用', () => {
    const document = doc([extract, echo, later])
    const options = priorBindings(document, 1)
    expect(options.map((item) => item.key)).toEqual(['orderId', 'extracted'])
    expect(options.some((item) => item.key === 'later')).toBe(false)

    const stale = priorBindings(
      { ...document, steps: [extract, { ...echo, input: { from: 'gone' } }, later] },
      1,
    )
    expect(stale.some((item) => item.key === 'gone' && item.stale)).toBe(true)
  })

  it('删除确认能列出 from 消费方', () => {
    expect(outputConsumers(doc([extract, echo, later]), 'extracted')).toEqual([{ id: echo.id, name: '回显' }])
  })

  it('在选中步骤后插入，边界移动返回 null', () => {
    const inserted = insertStep(doc([navigate, echo]), extract, 0)
    expect(inserted.steps.map((step) => step.id)).toEqual([navigate.id, extract.id, echo.id])
    expect(moveStep(doc([navigate]), 0, -1)).toBeNull()
    expect(moveStep(doc([navigate, echo]), 0, 1)?.steps.map((step) => step.type)).toEqual(['echo', 'navigate'])
  })

  it('空 URL 不能写入提交候选', () => {
    const document = doc([navigate])
    expect(tryReplaceStep(document, { ...navigate, input: { url: '' } }).ok).toBe(false)
    expect(tryReplaceStep(document, { ...navigate, input: { url: 'https://shop.example.com/x' } }).ok).toBe(true)
  })

  it('字段定位 id 由 fieldPath 组成，输入框视为正在键入', () => {
    expect(fieldElementId('step-1', ['input', 'url'])).toBe('studio-field-step-1-input-url')
    const input = document.createElement('input')
    document.body.append(input)
    expect(isTypingTarget(input)).toBe(true)
    expect(isTypingTarget(document.body)).toBe(false)
    input.remove()
  })

  it('V2 节点插入、移动、删除与绑定候选保持模块暴露名', () => {
    const v2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'orderId', label: '订单号' }],
      nodes: [
        { kind: 'step', step: extract },
        {
          kind: 'module',
          invocationId: '55555555-5555-4555-8555-555555555555',
          name: '查询订单',
          moduleId: '66666666-6666-4666-8666-666666666666',
          moduleVersionId: '77777777-7777-4777-8777-777777777777',
          implementationKey: 'default',
          inputBindings: { orderId: { kind: 'from', key: 'orderId' } },
          outputBindings: { status: 'orderStatus' },
        },
      ],
    }
    expect(documentNodeCount(v2)).toBe(2)
    expect(documentUsesBrowser(v2)).toBe(true)
    expect(authoringNodeLabel(v2.nodes[1]!)).toBe('查询订单')
    expect(priorBindingsV2(v2, 1).map((item) => item.key)).toEqual(['orderId', 'extracted'])
    expect(priorOutputShapesAny(v2, 1).get('extracted')?.kind).toBe('scalar')
    const inserted = insertNode(v2, { kind: 'step', step: echo }, 0)
    expect(inserted.nodes.map((node) => (node.kind === 'step' ? node.step.type : node.kind))).toEqual([
      'extract',
      'echo',
      'module',
    ])
    expect(moveNode(v2, 0, 1)?.nodes[0]?.kind).toBe('module')
    expect(removeAuthoringNode(v2, '55555555-5555-4555-8555-555555555555').nodes).toHaveLength(1)
    expect(tryReplaceInputs(v2, [{ key: 'shop', label: '店铺' }]).ok).toBe(true)
    expect(bindingUiKind({ kind: 'literal', value: 'A' }, ['orderId'])).toBe('literal')
    expect(bindingUiKind({ kind: 'from', key: 'orderId' }, ['orderId'])).toBe('input')
    expect(bindingUiKind({ kind: 'from', key: 'extracted', field: 'id' }, ['orderId'])).toBe('step')
    expect(findInsertedModuleInvocationId(v2, inserted as ScenarioAuthoringDocumentV2)).toBeUndefined()
    const withNewModule: ScenarioAuthoringDocumentV2 = {
      ...v2,
      nodes: [
        ...v2.nodes,
        {
          kind: 'module',
          invocationId: '99999999-9999-4999-8999-999999999999',
          name: '新插入',
          moduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          moduleVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: {},
        },
      ],
    }
    expect(findInsertedModuleInvocationId(v2, withNewModule)).toBe('99999999-9999-4999-8999-999999999999')
  })

  it('替换步骤节点时保留已挂载的成功条件', () => {
    const contractId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const v2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: navigate,
          outcomes: [
            {
              id: contractId,
              scope: 'step',
              meaning: '页面已打开',
              severity: 'MUST',
              onViolation: 'halt',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'exists' } },
            },
          ],
        },
      ],
    }
    const original = v2.nodes[0]!
    if (original.kind !== 'step') throw new Error('fixture must contain a step')
    const replaced = tryReplaceNode(v2, {
      ...original,
      step: { ...navigate, name: '打开首页' },
    })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    const node = replaced.document.nodes[0]
    expect(node?.kind).toBe('step')
    if (node?.kind !== 'step') return
    expect(node.step.name).toBe('打开首页')
    expect(node.outcomes?.[0]?.id).toBe(contractId)
  })
})
