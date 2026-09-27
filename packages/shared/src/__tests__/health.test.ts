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
describe('platformHealthResponseSchema', () => {
  const now = new Date().toISOString()
  const valid = {
    overall: 'healthy' as const,
    asOf: now,
    validUntil: now,
    freshForMs: 25000,
    checks: {
      api: { status: 'healthy' as const, code: 'OK', message: 'API 服务正常' },
      database: { status: 'healthy' as const, code: 'OK', message: '数据库连接正常' },
      worker: {
        status: 'healthy' as const,
        code: 'OK',
        message: '已有 2 个健康执行节点在服',
        healthyNodes: 2,
        affectedActiveRuns: 0,
        affectedActiveSessions: 0,
      },
      changeHint: { status: 'unused' as const, code: 'UNUSED', message: '变更提示链路未启用' },
    },
  }

  it('接受合法的平台健康响应', async () => {
    const { platformHealthResponseSchema } = await import('../health.js')
    expect(platformHealthResponseSchema.parse(valid)).toEqual(valid)
  })

  it('允许 degraded / critical / unknown / unused 枚举', async () => {
    const { platformHealthResponseSchema } = await import('../health.js')
    const degraded = {
      ...valid,
      overall: 'degraded' as const,
      checks: {
        ...valid.checks,
        worker: {
          ...valid.checks.worker,
          status: 'degraded' as const,
          code: 'WORKER_DEGRADED',
          message: '部分执行节点心跳过期',
        },
        changeHint: {
          status: 'degraded' as const,
          code: 'DOWN',
          message: '变更提示链路异常',
        },
      },
    }
    expect(platformHealthResponseSchema.parse(degraded).overall).toBe('degraded')
  })

  it('拒绝非法 overall 状态', async () => {
    const { platformHealthResponseSchema } = await import('../health.js')
    expect(() => platformHealthResponseSchema.parse({ ...valid, overall: 'good' })).toThrow()
  })
})
