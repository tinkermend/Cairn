import { describe, expect, it } from 'vitest'
import { deterministicStepId } from '@cairn/authoring'
import type { OutcomeManifest, Step } from '@cairn/shared'
import { applyTargetToDraftStep, resolveHoldingDraftStepId } from './holding-writeback'

const clickId = '11111111-1111-4111-8111-111111111111'
const nextId = '22222222-2222-4222-8222-222222222222'
const derivedId = deterministicStepId(clickId, '33333333-3333-4333-8333-333333333333')

const manifest: OutcomeManifest = {
  entries: [
    {
      contractId: '33333333-3333-4333-8333-333333333333',
      scope: 'step',
      meaning: '提交后可见结果',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      stepId: derivedId,
      sourceStepId: clickId,
      rule: { kind: 'deterministic', expect: { kind: 'exists' } },
    },
  ],
}

describe('resolveHoldingDraftStepId', () => {
  it('checkpoint 就是草稿步时直接选中该步', () => {
    expect(resolveHoldingDraftStepId(clickId, manifest, [clickId, nextId])).toBe(clickId)
  })

  it('派生 assert 失败时跳到来源步，找不到才放弃', () => {
    expect(resolveHoldingDraftStepId(derivedId, manifest, [clickId, nextId])).toBe(clickId)
    expect(resolveHoldingDraftStepId(derivedId, manifest, [nextId])).toBeUndefined()
    expect(resolveHoldingDraftStepId(undefined, manifest, [clickId])).toBeUndefined()
  })
})

describe('applyTargetToDraftStep', () => {
  it('只改有 target 的步骤，并保留原语义', () => {
    const click: Step = {
      id: clickId,
      name: '点击查询',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: {
        target: {
          framePath: [],
          semantic: '查询按钮',
          candidates: [{ by: 'label', value: '查询' }],
        },
      },
    }
    const next = applyTargetToDraftStep(click, {
      framePath: [],
      candidates: [{ by: 'role', value: 'button', name: '查询' }],
    })
    expect(next?.input).toMatchObject({
      target: {
        semantic: '查询按钮',
        candidates: [{ by: 'role', value: 'button', name: '查询' }],
      },
    })
    const navigate: Step = {
      id: nextId,
      name: '打开页面',
      type: 'navigate',
      effectType: 'SIDE_EFFECT',
      input: { url: 'https://shop.example.com' },
    }
    expect(applyTargetToDraftStep(navigate, { framePath: [], candidates: [] })).toBeUndefined()
  })
})
