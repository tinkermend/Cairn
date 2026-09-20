import { describe, expect, it } from 'vitest'
import { contentRangeHeader, parseHttpRange } from '../http-range.js'

describe('parseHttpRange', () => {
  it('无头返回 null；越界或非法返回 unsatisfiable', () => {
    expect(parseHttpRange(undefined, 100)).toBeNull()
    expect(parseHttpRange('bytes=0-10', 0)).toBe('unsatisfiable')
    expect(parseHttpRange('bytes=50-10', 100)).toBe('unsatisfiable')
    expect(parseHttpRange('bytes=100-120', 100)).toBe('unsatisfiable')
    expect(parseHttpRange('items=0-1', 100)).toBe('unsatisfiable')
  })

  it('解析首中尾与后缀', () => {
    expect(parseHttpRange('bytes=0-0', 100)).toEqual({ start: 0, end: 0 })
    expect(parseHttpRange('bytes=20-29', 100)).toEqual({ start: 20, end: 29 })
    expect(parseHttpRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseHttpRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(contentRangeHeader({ start: 20, end: 29 }, 100)).toBe('bytes 20-29/100')
  })
})
