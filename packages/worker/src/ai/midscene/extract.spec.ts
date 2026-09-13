import { describe, expect, it } from 'vitest'
import { detectFabrication, takeStringField } from './extract.js'

describe('takeStringField', () => {
  it('只接受字符串字段', () => {
    expect(takeStringField({ orderNo: 'SO-1001' }, 'orderNo')).toEqual({ ok: true, value: 'SO-1001' })
    expect(takeStringField({ orderNo: { n: 1 } }, 'orderNo')).toEqual({ ok: false, reason: 'not_string' })
    expect(takeStringField({}, 'orderNo')).toEqual({ ok: false, reason: 'missing' })
  })

  it('页面没有该值则视为编造', () => {
    expect(detectFabrication('查到 0 条，页面没有单号。', 'SO-9999')).toBe(true)
    expect(detectFabrication('单号 SO-1001', 'SO-1001')).toBe(false)
  })
})
