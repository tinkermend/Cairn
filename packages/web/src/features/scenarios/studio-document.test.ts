import { describe, expect, it } from 'vitest'
import type { ScenarioDocument, Step } from '@cairn/shared'
import {
  fieldElementId,
  insertStep,
  isTypingTarget,
  moveStep,
  outputConsumers,
  priorBindings,
  tryReplaceStep,
  uniqueOutputKey,
} from './studio-document'

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
})
