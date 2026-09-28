import { describe, expect, it } from 'vitest'
import { reportScreenshotRefs } from './materials.js'

function source(overrides: Record<string, unknown> = {}) {
  return {
    scenarioName: '示例场景',
    runId: 'run-1',
    stepRuns: [{ id: 'step-1', name: '导航-实例', status: 'SUCCEEDED', outcomeStatus: 'PASS', attempts: [] }],
    output: {},
    evidence: [],
    ...overrides,
  } as Record<string, any>
}

describe('reportScreenshotRefs', () => {
  it('still_loading 诊断进标题、且和 suspected_blank 一样在同角色去重时让位给正常画面', () => {
    const refs = reportScreenshotRefs(
      source({
        evidence: [
          {
            evidenceId: 'e-still-loading',
            type: 'screenshot',
            status: 'available',
            stepRunId: 'step-1',
            attemptId: 'attempt-1',
            role: 'after_action',
            seq: 0,
            diagnosis: 'still_loading',
          },
          {
            evidenceId: 'e-clean',
            type: 'screenshot',
            status: 'available',
            stepRunId: 'step-1',
            attemptId: 'attempt-1',
            role: 'after_action',
            seq: 1,
            diagnosis: 'not_flagged',
          },
        ],
      }),
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]?.evidenceId).toBe('e-clean')
  })

  it('只有 still_loading 一张时仍会被选中，标题带上提示文案', () => {
    const refs = reportScreenshotRefs(
      source({
        evidence: [
          {
            evidenceId: 'e-only',
            type: 'screenshot',
            status: 'available',
            stepRunId: 'step-1',
            attemptId: 'attempt-1',
            role: 'after_action',
            seq: 0,
            diagnosis: 'still_loading',
          },
        ],
      }),
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]?.caption).toContain('疑似仍在加载')
  })
})
