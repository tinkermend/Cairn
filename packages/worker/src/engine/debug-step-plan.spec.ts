import { describe, expect, it } from 'vitest'
import type { RunSnapshot, Step } from '@cairn/shared'
import { snapshotForDebugStep } from './debug-step-plan.js'

const stepId = '00000000-0000-4000-8000-0000000000c1'
const frozen = {
  resolution: {
    protocol: 'snapshot.resolution@2',
    allowed: ['rule', 'text_ai'],
    steps: {
      [stepId]: { requested: ['text_ai'], actual: ['text_ai'], skipped: [], source: 'step' },
    },
  },
  aiExecution: { platformAi: { model: 'text' }, visionEnabled: false },
} as unknown as RunSnapshot

function edited(order: Array<'rule' | 'text_ai' | 'vision_ai'>): Step {
  return {
    id: stepId,
    name: '查看实例',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: { target: { framePath: [], candidates: [{ by: 'text', value: 'Mysql50.33' }] } },
    policy: { locatorPlan: { v: 2, order } },
  }
}

describe('调试重试定位计划', () => {
  it('本次尝试使用用户编辑的顺序，冻结快照保持原样', () => {
    const attempt = snapshotForDebugStep(frozen, stepId, edited(['rule']))
    expect(attempt.resolution?.protocol).toBe('snapshot.resolution@2')
    if (attempt.resolution?.protocol !== 'snapshot.resolution@2') return
    expect(attempt.resolution.steps[stepId]?.actual).toEqual(['rule'])
    expect(attempt.resolution.steps[stepId]?.source).toBe('step')
    expect(frozen.resolution?.protocol === 'snapshot.resolution@2' && frozen.resolution.steps[stepId]?.actual).toEqual(['text_ai'])
  })

  it('拒绝本次运行未冻结的视觉路线', () => {
    expect(() => snapshotForDebugStep(frozen, stepId, edited(['vision_ai']))).toThrow('不允许所选路线')
  })
})
