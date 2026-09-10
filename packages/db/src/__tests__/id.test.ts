import { describe, expect, it } from 'vitest'
import { newId } from '../id.js'

describe('newId', () => {
  it('生成 UUIDv7：版本位为 7，variant 位为 RFC 4122', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('单调递增：时间前缀让 ID 按生成顺序排序', () => {
    const ids = Array.from({ length: 500 }, newId)
    expect([...ids].sort()).toEqual(ids)
  })

  it('时间前缀就是当前毫秒', () => {
    const before = Date.now()
    const ms = Number.parseInt(newId().replaceAll('-', '').slice(0, 12), 16)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(Date.now())
  })
})
