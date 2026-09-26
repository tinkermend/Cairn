import { describe, expect, it } from 'vitest'
import { LOCATOR_PRESETS, locatorLimitsSchema, locatorPlanSchema, locatorPlanPreset } from '../locator-plan.js'
import { FACTORY_PLATFORM_CONFIG } from '../platform-config.js'
import { legacyPolicyRoutes, resolveLocatorPlan, upgradeAuthoringLocatorDocument, upgradePlatformLocatorConfig } from '../locator-resolution.js'

const platform = {
  defaultPolicy: 'prefer_deterministic' as const,
  ceiling: 'prefer_ai' as const,
  plan: locatorPlanPreset('rule_text_vision'),
  limits: { v: 2 as const, allowed: ['rule', 'text_ai', 'vision_ai'] as ('rule' | 'text_ai' | 'vision_ai')[] },
}

describe('定位计划 v2', () => {
  it('路线非空去重，能力上限与尝试顺序分开', () => {
    expect(() => locatorPlanSchema.parse({ v: 2, order: ['rule', 'rule'] })).toThrow()
    expect(() => locatorPlanSchema.parse({ v: 2, order: [] })).toThrow()
    expect(locatorLimitsSchema.parse({ v: 2, allowed: ['rule', 'vision_ai'] }).allowed).toEqual(['rule', 'vision_ai'])
  })

  it('完整上限下保留文本优先的真实顺序', () => {
    const result = resolveLocatorPlan({
      platform,
      step: { plan: locatorPlanPreset('text_rule') },
      textReady: true,
      visionReady: true,
    })
    expect(result.actual).toEqual(['text_ai', 'rule'])
    expect(result.source).toBe('step')
  })

  it('继承计划裁掉未就绪路线并给原因，显式选择则阻断', () => {
    const inherited = resolveLocatorPlan({ platform, textReady: false, visionReady: true })
    expect(inherited.actual).toEqual(['rule', 'vision_ai'])
    expect(inherited.skipped).toEqual([{ route: 'text_ai', reason: 'TEXT_NOT_READY' }])
    expect(() => resolveLocatorPlan({
      platform,
      step: { plan: locatorPlanPreset('text_only') },
      textReady: false,
      visionReady: true,
    })).toThrow(/平台 AI 文本模型未就绪/)
  })

  it('目标系统只能收紧平台上限，显式冲突给上限来源', () => {
    const target = { limits: { v: 2 as const, allowed: ['rule'] as ('rule' | 'text_ai' | 'vision_ai')[] } }
    expect(resolveLocatorPlan({ platform, target, textReady: true, visionReady: true }).actual).toEqual(['rule'])
    expect(() => resolveLocatorPlan({
      platform, target, step: { plan: locatorPlanPreset('vision_only') }, textReady: true, visionReady: true,
    })).toThrow(/目标系统定位能力上限/)
  })

  it('旧版转换按当时文本就绪状态映射实际调用路线', () => {
    expect(legacyPolicyRoutes('prefer_ai', true)).toEqual(['text_ai', 'vision_ai', 'rule'])
    expect(legacyPolicyRoutes('prefer_ai', false)).toEqual(['vision_ai', 'rule'])
    expect(legacyPolicyRoutes('prefer_deterministic', false)).toEqual(['rule', 'vision_ai'])
  })

  it('九种预设的执行顺序与用户选择完全一致', () => {
    for (const preset of Object.values(LOCATOR_PRESETS)) {
      const actual = resolveLocatorPlan({ platform, step: { plan: { v: 2, order: [...preset.order] } }, textReady: true, visionReady: true })
      expect(actual.actual).toEqual(preset.order)
    }
  })

  it('新配置和旧草稿升级保留继承，并按旧有效档位转换显式步骤', () => {
    const oldPlatform = { ...FACTORY_PLATFORM_CONFIG, locator: undefined, browserAi: {
      ...FACTORY_PLATFORM_CONFIG.browserAi, enabled: true, resolutionCeiling: 'prefer_deterministic' as const,
    } }
    expect(upgradePlatformLocatorConfig(oldPlatform).locator).toMatchObject({
      defaultPlan: { order: ['rule', 'vision_ai'] },
      limits: { allowed: ['rule', 'text_ai', 'vision_ai'] },
    })
    const step = { id: '00000000-0000-4000-8000-000000000101', name: '查询', type: 'click' as const,
      effectType: 'SIDE_EFFECT' as const, input: { target: { candidates: [{ by: 'text' as const, value: '查询' }] } },
      policy: { resolution: 'prefer_ai' as const } }
    const upgraded = upgradeAuthoringLocatorDocument({
      document: { authoringSchemaVersion: 2, schemaVersion: 1, inputs: [], nodes: [{ kind: 'step', step }] },
      platform: oldPlatform,
    })
    expect(upgraded.locatorProtocol).toBe(2)
    expect(upgraded.locatorPlan).toBeUndefined()
    expect(upgraded.nodes[0]?.kind === 'step' && upgraded.nodes[0].step.policy?.locatorPlan?.order).toEqual(['rule', 'vision_ai'])
    expect(upgraded.nodes[0]?.kind === 'step' && upgraded.nodes[0].step.policy?.resolution).toBeUndefined()
  })
})
