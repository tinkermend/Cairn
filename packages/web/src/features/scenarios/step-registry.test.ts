import { describe, expect, it } from 'vitest'
import { EXECUTABLE_STEP_TYPES } from '@cairn/shared'
import { createBlankStep, DETERMINISTIC_STUDIO_TYPES, selectableStudioTypes } from './step-registry'

describe('step-registry', () => {
  it('步骤库不遍历 EXECUTABLE_STEP_TYPES，也不开放未登记类型', () => {
    expect(EXECUTABLE_STEP_TYPES).toEqual(expect.arrayContaining(['ai_action', 'navigate']))
    expect(selectableStudioTypes(undefined)).toEqual([...DETERMINISTIC_STUDIO_TYPES])
    expect(
      selectableStudioTypes({
        executableStepTypes: ['navigate', 'http', 'ai_action'],
        unavailableReasons: [],
      }),
    ).toEqual(['navigate', 'ai_action'])
  })

  it('连续提取使用去重后的默认输出名', () => {
    const first = createBlankStep('extract')
    const second = createBlankStep('extract', first.outputKey ? [first.outputKey] : [])
    expect(first.outputKey).toBe('extracted')
    expect(second.outputKey).toBe('extracted2')
  })
})
