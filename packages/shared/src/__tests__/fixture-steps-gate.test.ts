import { describe, expect, it } from 'vitest'
import {
  FACTORY_PLATFORM_CONFIG,
  FIXTURE_STEPS_DISABLED_CODE,
  FIXTURE_STEP_TYPES,
  executableStepTypesFor,
  isFixtureStepType,
  scenarioCapabilitiesFor,
} from '../index.js'

/**
 * 夹具步骤（echo / delay / fail）不访问目标系统，成败由入参直接决定。
 * 它们与真实运行共用 Run / Outcome / 证据与总览口径，所以出厂必须关闭，
 * 且闸门要和「浏览器 AI 是否启用」互相独立。
 */
describe('调试夹具闸门', () => {
  it('出厂关闭', () => {
    expect(FACTORY_PLATFORM_CONFIG.fixtureStepsEnabled).toBe(false)
  })

  it('未开放时编写清单不含夹具类型，且与 AI 开关无关', () => {
    for (const browserAi of [true, false]) {
      const types = executableStepTypesFor(browserAi, false)
      for (const fixture of FIXTURE_STEP_TYPES) expect(types).not.toContain(fixture)
      expect(types).toContain('navigate')
    }
  })

  it('开放后夹具类型才进入编写清单', () => {
    const types = executableStepTypesFor(false, true)
    for (const fixture of FIXTURE_STEP_TYPES) expect(types).toContain(fixture)
    expect(types).not.toContain('ai_action')
  })

  it('未开放时逐类型给出可读的不可用原因', () => {
    const capabilities = scenarioCapabilitiesFor({ browserAiEnabled: false })
    const fixtureReasons = capabilities.unavailableReasons.filter(
      (item) => item.code === FIXTURE_STEPS_DISABLED_CODE,
    )
    expect(fixtureReasons.map((item) => item.type).sort()).toEqual([...FIXTURE_STEP_TYPES].sort())
    for (const reason of fixtureReasons) expect(reason.message).toContain('不构成业务事实')
  })

  it('开放后不再报不可用', () => {
    const capabilities = scenarioCapabilitiesFor({
      browserAiEnabled: false,
      fixtureStepsEnabled: true,
    })
    expect(
      capabilities.unavailableReasons.some((item) => item.code === FIXTURE_STEPS_DISABLED_CODE),
    ).toBe(false)
  })

  it('isFixtureStepType 只认这三种', () => {
    expect(FIXTURE_STEP_TYPES.every((type) => isFixtureStepType(type))).toBe(true)
    for (const other of ['navigate', 'click', 'ai_action', 'map_observe']) {
      expect(isFixtureStepType(other)).toBe(false)
    }
  })
})
