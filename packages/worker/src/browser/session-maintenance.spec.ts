import { beforeEach, expect, it, vi } from 'vitest'
import { BrowserSessionManager } from './session-manager'
import { invalidateSessionProfile, loadTargetForExecution, occupyAutoLoginBudget } from '@cairn/db'
import { verifyAuthProfile } from './session-auth'
vi.mock('@cairn/db', async (load) => ({
  ...(await load<typeof import('@cairn/db')>()),
  invalidateSessionProfile: vi.fn(),
  getSessionOperation: vi.fn(async () => ({ id: 'op', status: 'RUNNING', attemptNo: 1, kindParams: {} })),
  getSessionById: vi.fn(async () => ({ id: 's', status: 'OPEN' })),
  readLiveSessionAuth: vi.fn(async () => ({ revision: 1, sessionAuth: {} })),
  loadAccountForExecution: vi.fn(async () => ({ id: 'a' })),
  loadTargetForExecution: vi.fn(async () => ({ id: 't', entryUrl: 'https://example.com', authMethod: 'password', captchaMode: 'none' })),
  occupyAutoLoginBudget: vi.fn(async () => ({ ok: false })),
  freezeAuthVerificationForRun: vi.fn(async () => ({ capability: 'IDENTITY_VERIFIED', profileRevision: 1 })),
  loadAuthProfileRevision: vi.fn(async () => ({ definition: { renew: 'verify_slides' } })),
  transitionSessionUse: vi.fn(async () => null),
  markSessionOperationWaitingForAuth: vi.fn(async () => true),
  appendSessionEvent: vi.fn(async () => {}),
}))
vi.mock('./session-auth', () => ({ verifyAuthProfile: vi.fn() }))
let manager: any
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadTargetForExecution).mockResolvedValue({ id: 't', entryUrl: 'https://example.com', authMethod: 'password', captchaMode: 'none' } as any)
  manager = new BrowserSessionManager(
    {} as any,
    { workerId: 'w', workerInstanceId: 'i', defaultLeaseTtlSeconds: 60, defaultAuthWaitSeconds: 600 } as any,
  )
  manager.lives.set('s', { handle: {} })
  manager.assertMaintenanceLive = vi.fn(async () => ({ origin: 'USER' }))
  manager.persistProfileObservation = vi.fn(async () => {})
  manager.resolveAccountCredential = vi.fn(async () => ({ username: 'alice', password: 'fixture' }))
  vi.mocked(verifyAuthProfile).mockResolvedValue({
    observation: { authState: 'AUTHENTICATED', identityState: 'MATCH' },
  } as any)
})

it.each([
  { name: '验证码', target: { captchaMode: 'manual' }, authState: 'EXPIRED', identityState: 'UNVERIFIED' },
  { name: '人工认证', target: { authMethod: 'manual' }, authState: 'EXPIRED', identityState: 'UNVERIFIED' },
  { name: '未知结果', target: {}, authState: 'UNKNOWN', identityState: 'UNVERIFIED' },
  { name: '身份不匹配', target: {}, authState: 'AUTHENTICATED', identityState: 'MISMATCH' },
])('$name 时不取凭据、不占自动登录额度', async ({ target, authState, identityState }) => {
  vi.mocked(loadTargetForExecution).mockResolvedValue({ id: 't', entryUrl: 'https://example.com', authMethod: 'password', captchaMode: 'none', ...target } as any)
  vi.mocked(verifyAuthProfile).mockResolvedValue({ observation: { authState, identityState } } as any)
  expect(await manager.runMaintenanceAuth({ id: 's' }, { id: 'op', kind: 'LOGIN', targetId: 't', targetAccountId: 'a' }, null, 'ensure')).toMatchObject({ ok: false })
  expect(manager.resolveAccountCredential).not.toHaveBeenCalled()
  expect(occupyAutoLoginBudget).not.toHaveBeenCalled()
})

it('无可用凭据不消耗自动登录额度', async () => {
  vi.mocked(verifyAuthProfile).mockResolvedValue({ observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' } } as any)
  manager.resolveAccountCredential.mockResolvedValue(null)
  await manager.runMaintenanceAuth({ id: 's' }, { id: 'op', kind: 'LOGIN', targetId: 't', targetAccountId: 'a' }, null, 'ensure')
  expect(occupyAutoLoginBudget).not.toHaveBeenCalled()
})
it('verify_slides 核验通过应完成续登，不占用人工认证', async () => {
  const result = await manager.runMaintenanceAuth(
    { id: 's' },
    { id: 'op', kind: 'RENEW_AUTH', targetId: 't', targetAccountId: 'a' },
    { leaseId: 'l' },
    'ensure',
  )
  expect(result).toEqual({ ok: true })
})
it('RESTART 核验未通过不应报告成功', async () => {
  vi.mocked(verifyAuthProfile).mockResolvedValue({
    observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' },
  } as any)
  expect(
    await manager.runMaintenanceAuth(
      { id: 's' },
      { id: 'op', kind: 'RESTART', targetId: 't', targetAccountId: 'a' },
      null,
      'verify',
    ),
  ).not.toEqual({ ok: true })
})
it('非登录的同源业务页面不应允许刷新', () => {
  expect(
    manager.isSafeLoginRefresh(
      'https://example.com/orders/submit',
      'https://example.com/login',
      'https://example.com/',
    ),
  ).toBe(false)
})

it('登录页路径与 query 发生变化也拒绝安全刷新', () => {
  expect(
    manager.isSafeLoginRefresh('https://example.com/login?result=posted', 'https://example.com/login', null),
  ).toBe(false)
  expect(manager.isSafeLoginRefresh('https://example.com/login', 'https://example.com/login', null)).toBe(
    true,
  )
})
it('VERIFY_AUTH 只读核验不通过时返回失败', async () => {
  vi.mocked(verifyAuthProfile).mockResolvedValue({
    observation: { authState: 'AUTHENTICATED', identityState: 'MISMATCH' },
  } as any)
  expect(
    await manager.runMaintenanceAuth(
      { id: 's' },
      { id: 'op', kind: 'VERIFY_AUTH', targetId: 't', targetAccountId: 'a' },
      null,
      'verify',
    ),
  ).toMatchObject({ ok: false })
})

it('无法确认停止时 RESET 不删除或作废 Profile，不报成功', async () => {
  manager.close = vi.fn(async () => 'unconfirmed')
  manager.finishMaintenance = vi.fn(async () => undefined)
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'RESET_PROFILE', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN' },
    grant: null,
    reusedRunId: null,
  })
  expect(invalidateSessionProfile).not.toHaveBeenCalled()
  expect(manager.finishMaintenance).toHaveBeenCalledWith(
    'op',
    { targetId: 't', targetAccountId: 'a' },
    'FAILED',
    undefined,
    'OPERATION_INTERRUPTED',
  )
})
