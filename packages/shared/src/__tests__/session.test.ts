import { describe, expect, it } from 'vitest'
import { DEV_CREDENTIAL_KEY, DEV_INTERNAL_AUTH_SECRET, workerEnvSchema } from '../env.js'
import {
  DEFAULT_SESSION_AUTH_WAIT_SECONDS,
  DEFAULT_UNATTENDED_AUTH_TIMEOUT_SECONDS,
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_LEASE_TTL_SECONDS,
  DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  DEFAULT_SESSION_POLICY,
  DEFAULT_SESSION_REUSE_POLICY,
  applyTargetSessionPolicyPatch,
  isPlacementYieldCode,
  isSessionConfigErrorCode,
  resolveSessionPolicy,
  resolveSessionPolicyLayers,
  sessionErrorCodeSchema,
  sessionGrantSchema,
  sessionPolicyOverrideSchema,
  sessionPolicySchema,
  targetSessionPolicyOverrideSchema,
  sessionReusePolicySchema,
  sessionStatusSchema,
  SESSION_ERROR_CODES,
  SESSION_REUSE_POLICIES,
  SESSION_STATUSES,
  effectiveAccountSessionCap,
  profileKeyForAccountSlot,
} from '../session.js'

/** 密钥必填、无默认值，parse 时必须带上。 */
const WORKER_SECRETS = {
  CAIRN_CREDENTIAL_KEY: DEV_CREDENTIAL_KEY,
  CAIRN_INTERNAL_AUTH_SECRET: DEV_INTERNAL_AUTH_SECRET,
}

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
    expect(SESSION_ERROR_CODES).toContain('SESSION_INSTANCE_REQUIRED')
    expect(SESSION_ERROR_CODES).toContain('SESSION_ACCOUNT_CAP_EXCEEDED')
    expect(SESSION_ERROR_CODES).toContain('SESSION_CONCURRENCY_UNSUPPORTED')
    expect(SESSION_ERROR_CODES).toContain('LOGIN_PAGE_UNREACHABLE')
    expect(SESSION_ERROR_CODES).toContain('PLATFORM_CONFIG_UNREADABLE')
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
    expect(parsed.lostDisposition).toBe('MANUAL')
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
    const env = workerEnvSchema.parse({ ...WORKER_SECRETS })
    expect(DEFAULT_SESSION_IDLE_TTL_SECONDS).toBe(env.CAIRN_SESSION_IDLE_TTL_SECONDS)
    expect(DEFAULT_SESSION_MAX_LIFETIME_SECONDS).toBe(env.CAIRN_SESSION_MAX_LIFETIME_SECONDS)
    expect(DEFAULT_SESSION_LEASE_TTL_SECONDS).toBe(env.CAIRN_SESSION_LEASE_TTL_SECONDS)
    expect(DEFAULT_SESSION_AUTH_WAIT_SECONDS).toBe(env.CAIRN_SESSION_AUTH_WAIT_SECONDS)
    expect(DEFAULT_UNATTENDED_AUTH_TIMEOUT_SECONDS).toBe(env.CAIRN_SESSION_UNATTENDED_AUTH_TIMEOUT_SECONDS)
    expect(DEFAULT_SESSION_REUSE_POLICY).toBe('NEW_PAGE')
    expect(DEFAULT_SESSION_POLICY).toEqual({
      reuse: 'NEW_PAGE',
      idleTtlSeconds: env.CAIRN_SESSION_IDLE_TTL_SECONDS,
      maxLifetimeSeconds: env.CAIRN_SESSION_MAX_LIFETIME_SECONDS,
      leaseTtlSeconds: env.CAIRN_SESSION_LEASE_TTL_SECONDS,
      authWaitSeconds: env.CAIRN_SESSION_AUTH_WAIT_SECONDS,
      unattendedAuthTimeoutSeconds: env.CAIRN_SESSION_UNATTENDED_AUTH_TIMEOUT_SECONDS,
      notifyOnAuthWait: true,
      reclaim: 'IDLE',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
      evictionPriority: 0,
      lostDisposition: 'MANUAL',
      accountSessionMode: 'exclusive',
      notifyOnAuthWait: true,
      unattendedAuthTimeoutSeconds: 120,
      browserIsolation: 'DEDICATED',
    })
  })

  it('三级覆盖按 平台 → Target → Run', () => {
    const resolved = resolveSessionPolicyLayers({
      platformDefault: DEFAULT_SESSION_POLICY,
      targetOverride: { reclaim: 'AUTH_DRIVEN', keepAliveSeconds: 1800, browserIsolation: 'SHARED' },
      runOverride: { leaseTtlSeconds: 20 },
    })
    expect(resolved.reclaim).toBe('AUTH_DRIVEN')
    expect(resolved.keepAliveSeconds).toBe(1800)
    expect(resolved.leaseTtlSeconds).toBe(20)
    expect(resolved.idleTtlSeconds).toBe(DEFAULT_SESSION_POLICY.idleTtlSeconds)
    expect(resolved.browserIsolation).toBe('SHARED')
  })

  it('目标和Run均可覆盖 browserIsolation，默认回落 DEDICATED', () => {
    expect(targetSessionPolicyOverrideSchema.parse({ browserIsolation: 'SHARED' })).toEqual({
      browserIsolation: 'SHARED',
    })
    expect(sessionPolicyOverrideSchema.parse({ browserIsolation: 'SHARED' })).toEqual({
      browserIsolation: 'SHARED',
    })
    expect(
      resolveSessionPolicyLayers({
        platformDefault: DEFAULT_SESSION_POLICY,
        targetOverride: { browserIsolation: 'SHARED' },
      }).browserIsolation,
    ).toBe('SHARED')
    expect(
      resolveSessionPolicyLayers({
        platformDefault: DEFAULT_SESSION_POLICY,
        targetOverride: { browserIsolation: 'SHARED' },
        runOverride: { browserIsolation: 'DEDICATED' },
      }).browserIsolation,
    ).toBe('DEDICATED')
    expect(
      applyTargetSessionPolicyPatch({ browserIsolation: 'SHARED' }, { browserIsolation: null }),
    ).toBeNull()
    expect(applyTargetSessionPolicyPatch(null, { browserIsolation: 'SHARED' })).toEqual({
      browserIsolation: 'SHARED',
    })
  })

  it('目标可覆盖 lostDisposition，Run 覆盖拒绝该字段', () => {
    expect(targetSessionPolicyOverrideSchema.parse({ lostDisposition: 'AUTO' })).toEqual({
      lostDisposition: 'AUTO',
    })
    expect(() => sessionPolicyOverrideSchema.parse({ lostDisposition: 'AUTO' })).toThrow()
    expect(
      resolveSessionPolicyLayers({
        platformDefault: DEFAULT_SESSION_POLICY,
        targetOverride: { lostDisposition: 'AUTO' },
        runOverride: { leaseTtlSeconds: 20 },
      }).lostDisposition,
    ).toBe('AUTO')
    expect(
      applyTargetSessionPolicyPatch({ lostDisposition: 'AUTO' }, { lostDisposition: null }),
    ).toBeNull()
    expect(applyTargetSessionPolicyPatch(null, { lostDisposition: 'AUTO' })).toEqual({
      lostDisposition: 'AUTO',
    })
  })

  it('目标可覆盖 accountSessionMode，Run 覆盖拒绝该字段', () => {
    expect(targetSessionPolicyOverrideSchema.parse({ accountSessionMode: 'concurrent' })).toEqual({
      accountSessionMode: 'concurrent',
    })
    expect(() => sessionPolicyOverrideSchema.parse({ accountSessionMode: 'concurrent' })).toThrow()
    expect(
      resolveSessionPolicyLayers({
        platformDefault: DEFAULT_SESSION_POLICY,
        targetOverride: { accountSessionMode: 'concurrent' },
      }).accountSessionMode,
    ).toBe('concurrent')
  })
})

describe('账号会话上限与 Profile 键', () => {
  it('exclusive 一律 1；concurrent 夹紧账号上限', () => {
    expect(effectiveAccountSessionCap({ accountSessionMode: 'exclusive', maxConcurrentSessions: 8 })).toBe(1)
    expect(effectiveAccountSessionCap({ accountSessionMode: 'concurrent', maxConcurrentSessions: 3 })).toBe(3)
    expect(effectiveAccountSessionCap({ accountSessionMode: 'concurrent' })).toBe(1)
  })

  it('slot 1 保持存量路径，slot ≥ 2 追加编号', () => {
    expect(profileKeyForAccountSlot('t', 'a', 1)).toBe('t/a')
    expect(profileKeyForAccountSlot('t', 'a', 2)).toBe('t/a/2')
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
