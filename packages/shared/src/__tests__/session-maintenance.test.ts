import { describe, expect, it } from 'vitest'
import { SYSTEM_ROLE_DEFINITIONS } from '../rbac.js'
import {
  accountPickerHint,
  accountSessionBucket,
  canCloseAccountSession,
  deriveAccountSessionStatus,
  backgroundVerifyWindowSlot,
  maintenanceIdempotencyKey,
  maintenanceWindowSlot,
  matchesOverviewFilter,
  matchesSystemOverviewFilter,
  requestSessionOperationBodySchema,
  retentionQuota,
  SESSION_EVENT_TYPES,
  SESSION_MAINTENANCE_ERROR_CODES,
  SESSION_MAINTENANCE_ERROR_MESSAGES,
  sessionRetentionBodySchema,
  worstAccountSessionStatus,
} from '../session-maintenance.js'

describe('会话维护契约 C0', () => {
  it('按占用与登录事实推导账号状态', () => {
    expect(
      deriveAccountSessionStatus({
        liveStatus: null,
        authState: null,
        identityState: null,
        leasePurpose: null,
        occupyingRunId: null,
        occupyingOperationId: null,
        holding: false,
      }),
    ).toBe('unprepared')
    expect(
      deriveAccountSessionStatus({
        liveStatus: 'OPEN',
        authState: 'AUTHENTICATED',
        identityState: 'MATCH',
        leasePurpose: 'EXECUTION',
        occupyingRunId: '11111111-1111-4111-8111-111111111111',
        occupyingOperationId: null,
        holding: false,
      }),
    ).toBe('executing')
    expect(
      deriveAccountSessionStatus({
        liveStatus: 'OPEN',
        authState: 'EXPIRED',
        identityState: 'UNVERIFIED',
        leasePurpose: null,
        occupyingRunId: null,
        occupyingOperationId: null,
        holding: false,
      }),
    ).toBe('needs_login')
  })

  it('人工认证占用不能显示成执行中', () => {
    expect(deriveAccountSessionStatus({ liveStatus: 'OPEN', authState: 'UNKNOWN', identityState: 'UNVERIFIED',
      leasePurpose: 'AUTH_WAIT', occupyingRunId: 'run', occupyingOperationId: null, holding: false })).toBe('maintenance')
  })

  it('系统分桶把占用和未准备排除在有问题之外', () => {
    expect(accountSessionBucket('needs_login')).toBe('problem')
    expect(accountSessionBucket('lost')).toBe('problem')
    expect(accountSessionBucket('unprepared')).toBe('unprepared')
    expect(accountSessionBucket('executing')).toBe('busy')
    expect(worstAccountSessionStatus('unprepared', 'lost')).toBe('lost')
    expect(worstAccountSessionStatus('ready', 'needs_check')).toBe('needs_check')
    expect(
      canCloseAccountSession({
        status: 'ready',
        sessionId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(true)
    expect(canCloseAccountSession({ status: 'unprepared', sessionId: null })).toBe(false)
    expect(canCloseAccountSession({ status: 'lost', sessionId: '11111111-1111-4111-8111-111111111111' })).toBe(
      false,
    )
    const mixed = {
      accountTotal: 8,
      readyCount: 1,
      problemCount: 2,
      unpreparedCount: 5,
      busyCount: 0,
      retainedCount: 0,
    }
    expect(matchesSystemOverviewFilter(mixed, 'problem')).toBe(true)
    expect(matchesSystemOverviewFilter(mixed, 'ready')).toBe(false)
    expect(
      matchesSystemOverviewFilter({ ...mixed, readyCount: 8, problemCount: 0, unpreparedCount: 0 }, 'ready'),
    ).toBe(true)
  })

  it('保留是筛选叠加而不是互斥状态', () => {
    expect(matchesOverviewFilter('ready', true, 'retained')).toBe(true)
    expect(matchesOverviewFilter('ready', true, 'available')).toBe(true)
    expect(matchesOverviewFilter('needs_login', false, 'retained')).toBe(false)
  })

  it('后台幂等键带窗口，配额按登记容量计算', () => {
    expect(maintenanceWindowSlot(1_800_000, 300)).toBe(6)
    expect(backgroundVerifyWindowSlot(1_800_000, 900, 300)).toBe(maintenanceWindowSlot(1_800_000, 900))
    expect(backgroundVerifyWindowSlot(1_800_000, null, 300)).toBe(maintenanceWindowSlot(1_800_000, 300))
    expect(maintenanceIdempotencyKey('bg-verify', 'acc', 6)).toBe('bg-verify:acc:6')
    expect(retentionQuota(4, 1)).toBe(3)
    expect(retentionQuota(1, 1)).toBe(0)
  })

  it('账号选择不再被口令门禁', () => {
    expect(accountPickerHint({ hasLiveSession: true, hasPassword: false, capability: 'LOGIN_VERIFIED' })).toEqual({
      reuse: true,
      manualLikely: true,
    })
  })

  it('session:manage 默认给管理员和执行者，不给编写者', () => {
    expect(SYSTEM_ROLE_DEFINITIONS.admin.permissions).toContain('session:manage')
    expect(SYSTEM_ROLE_DEFINITIONS.operator.permissions).toContain('session:manage')
    expect(SYSTEM_ROLE_DEFINITIONS.author.permissions).not.toContain('session:manage')
  })

  it('维护错误码与事件含保活收口', () => {
    expect(SESSION_MAINTENANCE_ERROR_CODES).toContain('AUTH_PROFILE_REQUIRED')
    expect(SESSION_MAINTENANCE_ERROR_CODES).toContain('SESSION_KEEPALIVE_ABANDONED')
    expect(SESSION_MAINTENANCE_ERROR_MESSAGES.AUTH_PROFILE_REQUIRED).toMatch(/认证画像/)
    expect(SESSION_MAINTENANCE_ERROR_MESSAGES.SESSION_KEEPALIVE_ABANDONED).toMatch(/保活/)
    expect(SESSION_EVENT_TYPES).toContain('auth.signal_observed')
    expect(SESSION_EVENT_TYPES).toContain('session.keepalive_extended')
    expect(SESSION_EVENT_TYPES).toContain('session.evicted')
  })

  it('RESET 必须确认账号；保留秒数受上限', () => {
    expect(() =>
      requestSessionOperationBodySchema.parse({
        kind: 'RESET_PROFILE',
        idempotencyKey: '12345678',
        confirmAccountId: '11111111-1111-4111-8111-111111111111',
      }),
    ).not.toThrow()
    expect(() =>
      sessionRetentionBodySchema.parse({ action: 'set', retainSeconds: 30 }),
    ).toThrow()
  })
})
