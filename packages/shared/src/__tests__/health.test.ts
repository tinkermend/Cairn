import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from '../health.js'

describe('healthResponseSchema', () => {
  const valid = {
    status: 'ok',
    service: 'cairn-api',
    uptimeSeconds: 12.5,
    checks: { database: 'up' },
  }

  it('接受合法响应', () => {
    expect(healthResponseSchema.parse(valid)).toEqual({
      ...valid,
      checks: { database: 'up', changeHint: 'unused' },
    })
  })

  it('拒绝未知的 status', () => {
    expect(() => healthResponseSchema.parse({ ...valid, status: 'fine' })).toThrow()
  })

  it('拒绝负的 uptime', () => {
    expect(() => healthResponseSchema.parse({ ...valid, uptimeSeconds: -1 })).toThrow()
  })

  it('拒绝缺失的 checks', () => {
    expect(() => healthResponseSchema.parse({ ...valid, checks: undefined })).toThrow()
  })
})
