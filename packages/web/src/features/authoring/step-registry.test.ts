import {
  EXECUTABLE_STEP_TYPES,
  FACTORY_PLATFORM_CONFIG,
  platformRuntimeDefaultsFrom,
} from '@cairn/shared'
import { describe, expect, it } from 'vitest'
import {
  createBlankStep,
  DETERMINISTIC_STUDIO_TYPES,
  selectableScenarioStudioTypes,
  selectableStudioTypes,
} from './step-registry'

describe('step-registry', () => {
  it('步骤库不遍历 EXECUTABLE_STEP_TYPES，也不开放未登记类型', () => {
    expect(EXECUTABLE_STEP_TYPES).toEqual(
      expect.arrayContaining(['ai_action', 'navigate'])
    )
    expect(selectableStudioTypes(undefined)).toEqual([
      ...DETERMINISTIC_STUDIO_TYPES,
    ])
    expect(DETERMINISTIC_STUDIO_TYPES).toEqual(
      expect.arrayContaining(['select', 'keyboard', 'wait'])
    )
    expect(
      selectableStudioTypes({
        executableStepTypes: ['navigate', 'http', 'ai_action'],
        unavailableReasons: [],
        defaults: platformRuntimeDefaultsFrom(FACTORY_PLATFORM_CONFIG, 1),
        authoringSchemaVersions: [1, 2],
        actionModules: true,
      })
    ).toEqual(['navigate', 'ai_action'])
  })

  it('场景步骤库不再提供断言类型', () => {
    expect(selectableScenarioStudioTypes(undefined)).not.toContain('assert')
    expect(selectableScenarioStudioTypes(undefined)).not.toContain('ai_assert')
    expect(selectableStudioTypes(undefined)).toContain('assert')
  })

  it('连续提取使用去重后的默认输出名', () => {
    const first = createBlankStep('extract')
    const second = createBlankStep(
      'extract',
      first.outputKey ? [first.outputKey] : []
    )
    expect(first.outputKey).toBe('extracted')
    expect(second.outputKey).toBe('extracted2')
  })

  it('支持创建合法的 download 与 upload 步骤', () => {
    const down1 = createBlankStep('download')
    const down2 = createBlankStep('download', down1.outputKey ? [down1.outputKey] : [])
    expect(down1.type).toBe('download')
    expect(down1.outputKey).toBe('downloaded')
    expect(down2.outputKey).toBe('downloaded2')

    const up = createBlankStep('upload')
    expect(up.type).toBe('upload')
    if (up.type === 'upload') {
      const file0 = up.input.files[0]
      expect(file0?.source).toBe('context')
      if (file0?.source === 'context') {
        expect(file0.from).toBe('downloaded')
      }
    }
  })
})
