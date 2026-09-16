import { describe, expect, it } from 'vitest'
import {
  applicabilityReason,
  canEnterCandidateBranch,
  chooseUniqueLocatedCandidate,
  isStepEligibleForMapConsumption,
  operableBindingsForStep,
  preserveConsumptionScope,
} from '../consumption.js'
import { FACTORY_MAP_CONSUMPTION_POLICY, mapConsumptionPolicySchema, type MapConditionSnapshot, type MapFrozenBinding } from '@cairn/shared'

const targetId = '00000000-0000-4000-8000-000000000010'
const stepId = '00000000-0000-4000-8000-000000000011'
const objectA = '00000000-0000-4000-8000-000000000012'
const objectB = '00000000-0000-4000-8000-000000000013'
const digest = 'b'.repeat(64)

const policy = mapConsumptionPolicySchema.parse({
  ...FACTORY_MAP_CONSUMPTION_POLICY,
  mode: 'shadow',
})

const binding = (objectId: string, step = stepId): MapFrozenBinding => ({
  stepId: step,
  slotKey: `step:${step.slice(0, 8)}`,
  assetRef: {
    targetId,
    objectId,
    implementationKey: 'desktop-zh',
    descriptorVersion: 1,
  },
  bindingDigest: digest,
})

describe('OM-F 选择纯函数', () => {
  it('OMF07 click/fill/AI 与写入步骤不可消费', () => {
    expect(isStepEligibleForMapConsumption({ type: 'click', effectType: 'SIDE_EFFECT' }, policy).ok).toBe(false)
    expect(isStepEligibleForMapConsumption({ type: 'fill', effectType: 'SIDE_EFFECT' }, policy).ok).toBe(false)
    expect(isStepEligibleForMapConsumption({ type: 'ai_extract', effectType: 'READ_ONLY' }, policy)).toEqual({
      ok: false,
      reasonCode: 'STEP_NOT_ELIGIBLE',
    })
    expect(isStepEligibleForMapConsumption({ type: 'extract', effectType: 'READ_ONLY' }, policy).ok).toBe(true)
  })

  it('OMF03 原定位成功不进候选', () => {
    expect(canEnterCandidateBranch({ baselineOk: true, remainingMs: 1_000 })).toEqual({
      enter: false,
      reasonCode: 'BASELINE_FOUND',
    })
  })

  it('OMF05 多对象命中记歧义，不按顺序任选', () => {
    const descriptor = { framePath: [], candidates: [{ by: 'role' as const, value: 'button', name: '保存' }] }
    const chosen = chooseUniqueLocatedCandidate([
      { binding: binding(objectA), descriptor, objectId: objectA, matches: 1, outcome: 'FOUND' },
      { binding: binding(objectB), descriptor, objectId: objectB, matches: 1, outcome: 'FOUND' },
    ])
    expect(chosen.selected).toBeUndefined()
    expect(chosen.reasonCode).toBe('AMBIGUOUS_CANDIDATES')
  })

  it('OMF06 条件未知不得当作满足', () => {
    const required: MapConditionSnapshot = {
      targetId,
      accountBinding: { presence: 'anonymous' as const },
      locale: 'zh-CN',
      unknownFields: [],
    }
    const observed: MapConditionSnapshot = {
      targetId,
      accountBinding: { presence: 'anonymous' as const },
      unknownFields: ['locale'],
    }
    expect(applicabilityReason(required, observed)).toEqual({
      match: 'unknown',
      reasonCode: 'CONDITION_UNKNOWN',
    })
  })

  it('仅 page 绑定不可操作', () => {
    const pageOnly: MapFrozenBinding = {
      stepId,
      slotKey: 'step:page',
      assetRef: { targetId, pageId: objectA },
      bindingDigest: digest,
    }
    const found = operableBindingsForStep([pageOnly], stepId)
    expect(found.operable).toEqual([])
    expect(found.pageOnly).toBe(true)
  })

  it('只有 TARGET_NOT_FOUND 才进候选，预算用尽则跳过', () => {
    expect(
      canEnterCandidateBranch({ baselineOk: false, errorCode: 'TARGET_AMBIGUOUS', remainingMs: 800 }),
    ).toEqual({ enter: false, reasonCode: 'BASELINE_AMBIGUOUS' })
    expect(canEnterCandidateBranch({ baselineOk: false, errorCode: 'TARGET_NOT_FOUND', remainingMs: 0 })).toEqual({
      enter: false,
      reasonCode: 'BUDGET_EXHAUSTED',
    })
    expect(canEnterCandidateBranch({ baselineOk: false, errorCode: 'TARGET_NOT_FOUND', remainingMs: 200 })).toEqual({
      enter: true,
    })
  })
  it('保留原记录 anchor，跨 Frame 或指定其他行的候选被拒绝', () => {
    const original = { framePath: [], candidates: [{ by: 'text' as const, value: 'old' }], anchor: { scope: 'row' as const, withinText: 'order-A' } }
    const candidate = { framePath: [], candidates: [{ by: 'text' as const, value: 'new' }] }
    expect(preserveConsumptionScope(original, candidate)?.anchor).toEqual(original.anchor)
    expect(preserveConsumptionScope(original, { ...candidate, anchor: { scope: 'row', withinText: 'order-B' } })).toBeUndefined()
    expect(preserveConsumptionScope(original, { ...candidate, framePath: [{ name: 'other-frame' }] })).toBeUndefined()
  })
  it('同一对象的两个实现命中仍不能随意选第一项', () => {
    const item = { binding: binding(objectA), descriptor: { framePath: [], candidates: [{ by: 'text' as const, value: 'name' }] }, objectId: objectA, matches: 1, outcome: 'FOUND' as const }
    expect(chooseUniqueLocatedCandidate([item, { ...item }]).selected).toBeUndefined()
  })

})
