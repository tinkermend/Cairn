import { describe, expect, it } from 'vitest'
import { handoffMessage, viewportMatches } from './managed-helpers'

describe('managed helpers', () => {
  it('视口容差内匹配，超出则拒绝', () => {
    expect(viewportMatches({ width: 1280, height: 720 }, { width: 1280, height: 720 })).toBe(true)
    expect(viewportMatches({ width: 1290, height: 720 }, { width: 1280, height: 720 })).toBe(true)
    expect(viewportMatches({ width: 1400, height: 720 }, { width: 1280, height: 720 })).toBe(false)
  })

  it('交接错误有明确中文说明', () => {
    expect(handoffMessage('PAGE_HANDOFF_NO_POPUP')).toContain('没有')
    expect(handoffMessage('PAGE_HANDOFF_OUT_OF_SCOPE')).toContain('范围')
  })
})
