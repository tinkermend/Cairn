import { describe, expect, it } from 'vitest'
import { accountSessionOccupancyText, systemSessionOccupancyHint } from './occupancy-label'

describe('occupancy-label', () => {
  it('cap=1 不露分数', () => {
    expect(accountSessionOccupancyText({ liveCount: 1, effectiveCap: 1 })).toBeNull()
    expect(systemSessionOccupancyHint({ accountCount: 4, liveSessionCount: 4, sessionCapTotal: 4 })).toBeNull()
  })

  it('cap>1 写 live/cap，系统行写会话合计', () => {
    expect(accountSessionOccupancyText({ liveCount: 2, effectiveCap: 3 })).toBe('2/3')
    expect(systemSessionOccupancyHint({ accountCount: 2, liveSessionCount: 5, sessionCapTotal: 8 })).toBe('会话 5/8')
  })
})
