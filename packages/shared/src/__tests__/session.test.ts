import { describe, expect, it } from 'vitest'
import { workerEnvSchema } from '../env.js'
import {
  DEFAULT_SESSION_AUTH_WAIT_SECONDS,
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_LEASE_TTL_SECONDS,
  DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  DEFAULT_SESSION_POLICY,
  DEFAULT_SESSION_REUSE_POLICY,
  isPlacementYieldCode,
  isSessionConfigErrorCode,
  resolveSessionPolicy,
  resolveSessionPolicyLayers,
  sessionErrorCodeSchema,
  sessionGrantSchema,
  sessionPolicySchema,
  sessionReusePolicySchema,
  sessionStatusSchema,
  SESSION_ERROR_CODES,
  SESSION_REUSE_POLICIES,
  SESSION_STATUSES,
} from '../session.js'

describe('session 词表', () => {
  it('生命周期状态闭枚举', () => {
    expect(SESSION_STATUSES).toEqual(['CREATING', 'OPEN', 'CLOSING', 'CLOSED', 'LOST'])
    expect(sessionStatusSchema.parse('OPEN')).toBe('OPEN')
    expect(() => sessionStatusSchema.parse('READY')).toThrow()
    expect(() => sessionStatusSchema.parse('BUSY')).toThrow()
  })

  it('复用档位三值，不含 NEW_CONTEXT', () => {
    expect(SESSION_REUSE_POLICIES).toEqual(['REUSE_PAGE', 'NEW_PAGE', 'RECREATE_SESSION'])
    expect(sessionReusePolicySchema.parse('NEW_PAGE')).toBe('NEW_PAGE')
    expect(() => sessionReusePolicySchema.parse('NEW_CONTEXT')).toThrow()
  })

  it('错误码闭枚举', () => {
    expect(SESSION_ERROR_CODES).toContain('SESSION_LEASE_LOST')
    expect(SESSION_ERROR_CODES).toContain('BROWSER_UNAVAILABLE')
    expect(SESSION_ERROR_CODES).toContain('SESSION_TARGET_MISSING')
    expect(SESSION_ERROR_CODES).toContain('SESSION_POLICY_INVALID')
    expect(SESSION_ERROR_CODES).toContain('SESSION_STOP_UNCONFIRMED')
    expect(SESSION_ERROR_CODES).toContain('SESSION_KEEPALIVE_ABANDONED')
    expect(sessionErrorCodeSchema.parse('SESSION_BUSY')).toBe('SESSION_BUSY')
    expect(() => sessionErrorCodeSchema.parse('UNKNOWN')).toThrow()
  })

  it('回交码与配置错误码互斥', () => {
    expect(isPlacementYieldCode('BROWSER_UNAVAILABLE')).toBe(true)
    expect(isPlacementYieldCode('SESSION_TARGET_MISSING')).toBe(false)
    expect(isSessionConfigErrorCode('SESSION_POLICY_INVALID')).toBe(true)
    expect(isSessionConfigErrorCode('SESSION_BUSY')).toBe(false)
  })
})

describe('sessionPolicySchema', () => {
  it('接受完整策略', () => {
    expect(sessionPolicySchema.parse(DEFAULT_SESSION_POLICY)).toEqual(DEFAULT_SESSION_POLICY)
  })

  it('拒绝 maxLifetime ≤ idleTtl', () => {
    expect(() =>
      sessionPolicySchema.parse({
        ...DEFAULT_SESSION_POLICY,
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 600,
      }),
    ).toThrow()
  })

  it('拒绝多余字段', () => {
    expect(() =>
      sessionPolicySchema.parse({
        ...DEFAULT_SESSION_POLICY,
        extra: true,
      }),
    ).toThrow()
  })

  it('旧快照缺新字段时按 IDLE 补齐', () => {
    const legacy = {
      reuse: 'NEW_PAGE' as const,
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 14_400,
      leaseTtlSeconds: 30,
      authWaitSeconds: 300,
    }
    const parsed = sessionPolicySchema.parse(legacy)
    expect(parsed.reclaim).toBe('IDLE')
    expect(parsed.keepAliveSeconds).toBe(3600)
    expect(parsed.authProbeIntervalSeconds).toBe(900)
    expect(parsed.evictionPriority).toBe(0)
    expect(resolveSessionPolicy(legacy)).toEqual(parsed)
    expect(
      resolveSessionPolicy(legacy, { ...DEFAULT_SESSION_POLICY, reclaim: 'AUTH_DRIVEN' }).reclaim,
    ).toBe('AUTH_DRIVEN')
  })

  it('AUTH_DRIVEN 要求保活短于寿命且巡检短于保活', () => {
    expect(() =>
      sessionPolicySchema.parse({
        ...DEFAULT_SESSION_POLICY,
        reclaim: 'AUTH_DRIVEN',
        keepAliveSeconds: 14_400,
      }),
    ).toThrow()
    expect(() =>
      sessionPolicySchema.parse({
        ...DEFAULT_SESSION_POLICY,
        reclaim: 'AUTH_DRIVEN',
        keepAliveSeconds: 600,
        authProbeIntervalSeconds: 600,
      }),
    ).toThrow()
  })
})

describe('resolveSessionPolicy', () => {
  it('无覆盖时返回平台默认', () => {
    expect(resolveSessionPolicy()).toEqual(DEFAULT_SESSION_POLICY)
    expect(resolveSessionPolicy(null)).toEqual(DEFAULT_SESSION_POLICY)
  })

  it('部分覆盖与默认合并', () => {
    const resolved = resolveSessionPolicy({ reuse: 'REUSE_PAGE', leaseTtlSeconds: 45 })
    expect(resolved.reuse).toBe('REUSE_PAGE')
    expect(resolved.leaseTtlSeconds).toBe(45)
    expect(resolved.idleTtlSeconds).toBe(DEFAULT_SESSION_POLICY.idleTtlSeconds)
  })

  it('平台默认与 workerEnvSchema 空配置默认逐字对齐', () => {
    const env = workerEnvSchema.parse({})
    expect(DEFAULT_SESSION_IDLE_TTL_SECONDS).toBe(env.CAIRN_SESSION_IDLE_TTL_SECONDS)
    expect(DEFAULT_SESSION_MAX_LIFETIME_SECONDS).toBe(env.CAIRN_SESSION_MAX_LIFETIME_SECONDS)
    expect(DEFAULT_SESSION_LEASE_TTL_SECONDS).toBe(env.CAIRN_SESSION_LEASE_TTL_SECONDS)
    expect(DEFAULT_SESSION_AUTH_WAIT_SECONDS).toBe(env.CAIRN_SESSION_AUTH_WAIT_SECONDS)
    expect(DEFAULT_SESSION_REUSE_POLICY).toBe('NEW_PAGE')
    expect(DEFAULT_SESSION_POLICY).toEqual({
      reuse: 'NEW_PAGE',
      idleTtlSeconds: env.CAIRN_SESSION_IDLE_TTL_SECONDS,
      maxLifetimeSeconds: env.CAIRN_SESSION_MAX_LIFETIME_SECONDS,
      leaseTtlSeconds: env.CAIRN_SESSION_LEASE_TTL_SECONDS,
      authWaitSeconds: env.CAIRN_SESSION_AUTH_WAIT_SECONDS,
      reclaim: 'IDLE',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
      evictionPriority: 0,
    })
  })

  it('三级覆盖按 平台 → Target → Run', () => {
    const resolved = resolveSessionPolicyLayers({
      platformDefault: DEFAULT_SESSION_POLICY,
      targetOverride: { reclaim: 'AUTH_DRIVEN', keepAliveSeconds: 1800 },
      runOverride: { leaseTtlSeconds: 20 },
    })
    expect(resolved.reclaim).toBe('AUTH_DRIVEN')
    expect(resolved.keepAliveSeconds).toBe(1800)
    expect(resolved.leaseTtlSeconds).toBe(20)
    expect(resolved.idleTtlSeconds).toBe(DEFAULT_SESSION_POLICY.idleTtlSeconds)
  })
})

describe('sessionGrantSchema', () => {
  it('接受合法 grant', () => {
    const grant = sessionGrantSchema.parse({
      sessionId: '00000000-0000-4000-8000-000000000001',
      leaseId: '00000000-0000-4000-8000-000000000002',
      generation: 1,
      sessionFencingToken: 3,
      expiresAt: '2026-09-10T08:00:30.000Z',
    })
    expect(grant.generation).toBe(1)
  })

  it('拒绝 generation ≤ 0', () => {
    expect(() =>
      sessionGrantSchema.parse({
        sessionId: '00000000-0000-4000-8000-000000000001',
        leaseId: '00000000-0000-4000-8000-000000000002',
        generation: 0,
        sessionFencingToken: 1,
        expiresAt: '2026-09-10T08:00:30.000Z',
      }),
    ).toThrow()
  })
})
