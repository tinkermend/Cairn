import { describe, expect, it } from 'vitest'
import {
  durationMsSchema,
  entityIdSchema,
  jsonValueSchema,
  leaseExpiresAtSchema,
  utcInstantSchema,
} from '../wire.js'

describe('entityIdSchema', () => {
  it('接受 UUID', () => {
    expect(entityIdSchema.parse('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  it('拒绝非 UUID 的业务短名', () => {
    expect(() => entityIdSchema.parse('run-1')).toThrow()
  })
})

describe('utcInstantSchema', () => {
  it('只接受带 Z 的 UTC', () => {
    expect(utcInstantSchema.parse('2026-09-10T08:00:00.123Z')).toBe('2026-09-10T08:00:00.123Z')
  })

  it('拒绝本地偏移——存储不得再夹一层时区', () => {
    expect(() => utcInstantSchema.parse('2026-09-10T16:00:00+08:00')).toThrow()
  })

  it('拒绝没有时区的裸日期时间', () => {
    expect(() => utcInstantSchema.parse('2026-09-10T08:00:00')).toThrow()
  })
})

describe('leaseExpiresAtSchema', () => {
  it('线格式与 utcInstant 相同，语义留给调用方用库钟比较', () => {
    const instant = '2026-09-10T08:00:30.000Z'
    expect(leaseExpiresAtSchema.parse(instant)).toBe(utcInstantSchema.parse(instant))
  })
})

describe('durationMsSchema', () => {
  it('接受 0 和一天以内的整数毫秒', () => {
    expect(durationMsSchema.parse(0)).toBe(0)
    expect(durationMsSchema.parse(1_000)).toBe(1_000)
  })

  it('拒绝负数与超过一天', () => {
    expect(() => durationMsSchema.parse(-1)).toThrow()
    expect(() => durationMsSchema.parse(86_400_001)).toThrow()
  })
})

describe('jsonValueSchema', () => {
  it('接受嵌套 JSON', () => {
    const value = { a: [1, 'x', false, null], b: { c: 2 } }
    expect(jsonValueSchema.parse(value)).toEqual(value)
  })

  it('拒绝 undefined', () => {
    expect(() => jsonValueSchema.parse(undefined)).toThrow()
  })
})
