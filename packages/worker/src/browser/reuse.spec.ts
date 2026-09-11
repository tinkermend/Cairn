import { describe, expect, it } from 'vitest'
import { pageStrategyForReuse, shouldRecreateSession } from './reuse'

describe('D8 复用档位', () => {
  it('REUSE_PAGE 用基准页；NEW_PAGE / RECREATE 新开页', () => {
    expect(pageStrategyForReuse('REUSE_PAGE')).toBe('base')
    expect(pageStrategyForReuse('NEW_PAGE')).toBe('new')
    expect(pageStrategyForReuse('RECREATE_SESSION')).toBe('new')
  })

  it('仅 RECREATE_SESSION 触发关会话重建', () => {
    expect(shouldRecreateSession('RECREATE_SESSION')).toBe(true)
    expect(shouldRecreateSession('NEW_PAGE')).toBe(false)
    expect(shouldRecreateSession('REUSE_PAGE')).toBe(false)
  })
})
