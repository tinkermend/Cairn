import { describe, expect, it } from 'vitest'
import { FACTORY_PLATFORM_CONFIG, scenarioDocumentSchema } from '@cairn/shared'
import { compileScenarioDocument } from '../compiler.js'

const id = '00000000-0000-4000-8000-000000000101'
const base = {
  schemaVersion: 1,
  locatorProtocol: 2,
  inputs: [],
  steps: [{
    id, name: '查询按钮', type: 'click', effectType: 'SIDE_EFFECT',
    input: { target: { semantic: '查询按钮', candidates: [{ by: 'text', value: '查询' }] } },
  }],
}
const platform = {
  ...FACTORY_PLATFORM_CONFIG,
  locator: { defaultPlan: { v: 2 as const, order: ['rule' as const, 'text_ai' as const] }, limits: { v: 2 as const, allowed: ['rule' as const, 'text_ai' as const] } },
}
const compile = (raw: unknown, config = platform) => compileScenarioDocument(scenarioDocumentSchema.parse(raw), {
  mode: 'release', target: { exists: true, status: 'active' },
  resolution: { ceiling: config.browserAi.resolutionCeiling, default: config.browserAi.defaultResolution, locatorDocument: config, locatorProtocol: 2 },
})

describe('v2 定位编排诊断', () => {
  it('视觉未就绪时明确指出显式 AI 步骤的视觉依赖', () => {
    for (const type of ['ai_action', 'ai_extract', 'ai_assert'] as const) {
      const result = compile({
        ...base,
        steps: [{ id, name: '模型步骤', type, effectType: type === 'ai_action' ? 'SIDE_EFFECT' : 'READ_ONLY',
          input: { instruction: '检查页面', ...(type === 'ai_extract' ? { outputSchema: { kind: 'scalar', type: 'string' } } : {}) },
          ...(type === 'ai_extract' ? { outputKey: 'found' } : {}),
        }],
      })
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SCENARIO_AI_UNAVAILABLE', severity: 'error', stepId: id }),
      ]))
    }
  })

  it('继承的未就绪文本路线有跳过提示，步骤显式选文本则阻断', () => {
    const inherited = compile(base)
    expect(inherited.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_LOCATOR_SKIPPED', severity: 'warning', stepId: id })]))
    const explicit = compile({ ...base, steps: [{ ...base.steps[0], policy: { locatorPlan: { v: 2, order: ['text_ai'] } } }] })
    expect(explicit.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_LOCATOR_UNAVAILABLE', severity: 'error', stepId: id })]))
  })

  it('模型路线只有 CSS 而没有元素描述时阻断', () => {
    const ready = { ...platform, platformAi: { ...platform.platformAi, enabled: true, secretRef: { provider: 'local' as const, secretId: '00000000-0000-4000-8000-000000000099' } } }
    const result = compile({ ...base, steps: [{ ...base.steps[0], input: { target: { candidates: [{ by: 'css', value: '#search' }] } }, policy: { locatorPlan: { v: 2, order: ['text_ai'] } } }] }, ready)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_MODEL_DESCRIPTION_REQUIRED', severity: 'error', stepId: id })]))
  })
})
