import { describe, expect, it } from 'vitest'
import {
  faceScreenshot,
  requiredScreenshotRole,
  screenshotSatisfiesRequiredRole,
  writeEvidenceArtifactKey,
} from '../evidence-slots.js'

describe('evidence slots', () => {
  it('按 Attempt 角色生成稳定 artifactKey', () => {
    expect(
      writeEvidenceArtifactKey({
        type: 'screenshot',
        attemptId: '00000000-0000-4000-8000-0000000000a1',
        role: 'after_action',
      }),
    ).toBe('screenshot:00000000-0000-4000-8000-0000000000a1:after_action:0')
    expect(writeEvidenceArtifactKey({ type: 'video' })).toBe('video:run')
  })

  it('失败槽是 on_error，等待成功是 after_condition', () => {
    expect(requiredScreenshotRole({ failed: true, commandType: 'click' })).toBe('on_error')
    expect(requiredScreenshotRole({ failed: false, commandType: 'wait' })).toBe('after_condition')
    expect(requiredScreenshotRole({ failed: false, stepType: 'navigate' })).toBe('after_action')
  })

  it('主图优先失败现场，其次操作后', () => {
    const attemptId = '00000000-0000-4000-8000-0000000000a1'
    const face = faceScreenshot(
      [
        { attemptId, type: 'screenshot', payload: { role: 'before_action', viewport: 'viewport', capturedAt: '2026-09-19T00:00:00.000Z' } },
        { attemptId, type: 'screenshot', payload: { role: 'after_action', viewport: 'viewport', capturedAt: '2026-09-19T00:00:01.000Z' } },
        { attemptId, type: 'screenshot', payload: { role: 'on_error', viewport: 'viewport', capturedAt: '2026-09-19T00:00:02.000Z' } },
      ],
      attemptId,
    )
    expect(face?.payload).toMatchObject({ role: 'on_error' })
  })

  it('同一角色优先有内容的较新一张', () => {
    const attemptId = '00000000-0000-4000-8000-0000000000a1'
    const face = faceScreenshot(
      [
        { attemptId, type: 'screenshot', payload: { role: 'after_action', viewport: 'viewport', capturedAt: '2026-09-19T00:00:01.000Z', seq: 0, diagnosis: 'suspected_blank' } },
        { attemptId, type: 'screenshot', payload: { role: 'after_action', viewport: 'viewport', capturedAt: '2026-09-19T00:00:03.000Z', seq: 1, diagnosis: 'not_flagged' } },
      ],
      attemptId,
    )
    expect(face?.payload).toMatchObject({ seq: 1, diagnosis: 'not_flagged' })
  })

  it('只有操作前图不能满足操作后角色', () => {
    expect(screenshotSatisfiesRequiredRole({ type: 'screenshot', payload: { role: 'before_action', viewport: 'viewport', capturedAt: '2026-09-19T00:00:00.000Z' } }, 'after_action')).toBe(false)
    expect(screenshotSatisfiesRequiredRole({ type: 'screenshot', artifactKey: 'screenshot:attempt:after_action:1', payload: { role: 'after_action', viewport: 'viewport', capturedAt: '2026-09-19T00:00:00.000Z', seq: 1 } }, 'after_action')).toBe(true)
  })
})
