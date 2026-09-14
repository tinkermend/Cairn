import { describe, expect, it } from 'vitest'
import { dateRange, dayKey, rangeToDayKeys } from './range'

describe('审计日期范围', () => {
  it('结束日按次日零点作为开区间', () => {
    const { from, to } = dateRange('2026-09-01', '2026-09-13')
    expect(from).toEqual(new Date('2026-09-01T00:00:00'))
    expect(to).toEqual(new Date('2026-09-14T00:00:00'))
  })

  it('把日历选中的起止日收成本地日期键', () => {
    expect(
      rangeToDayKeys({
        from: new Date(2026, 8, 1, 15, 30),
        to: new Date(2026, 8, 13, 8),
      }),
    ).toEqual({ fromDay: '2026-09-01', toDay: '2026-09-13' })
    expect(dayKey(new Date(2026, 0, 2))).toBe('2026-01-02')
  })
})
