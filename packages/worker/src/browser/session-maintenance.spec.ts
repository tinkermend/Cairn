import { beforeEach, expect, it, vi } from 'vitest'
import {
  claimSessionUse,
  createSession,
  invalidateSessionProfile,
  loadTargetForExecution,
  occupyAutoLoginBudget,
  recordAutoLoginOutcome,
  setSessionAuthSummary,
  setSessionStatus,
  transitionSessionUse,
} from '@cairn/db'
import { BrowserSessionManager } from './session-manager'
import { createBrowserPort } from './port'
import { currentOccupancyGrant, submitLoginCredentials } from './runtime'
import { verifyAuthProfile } from './session-auth'
vi.mock('@cairn/db', async (load) => ({
  ...(await load<typeof import('@cairn/db')>()),
  invalidateSessionProfile: vi.fn(),
  getSessionOperation: vi.fn(async () => ({ id: 'op', status: 'RUNNING', attemptNo: 1, kindParams: {} })),
  getSessionById: vi.fn(async () => ({ id: 's', status: 'OPEN', version: 1, generation: 1 })),
  readLiveSessionAuth: vi.fn(async () => ({ revision: 1, sessionAuth: {} })),
  loadAccountForExecution: vi.fn(async () => ({ id: 'a' })),
  loadTargetForExecution: vi.fn(async () => ({ id: 't', entryUrl: 'https://example.com', authMethod: 'password', captchaMode: 'none' })),
  occupyAutoLoginBudget: vi.fn(async () => ({ ok: false })),
  recordAutoLoginOutcome: vi.fn(async () => {}),
  freezeAuthVerificationForRun: vi.fn(async () => ({ capability: 'IDENTITY_VERIFIED', profileRevision: 1 })),
  loadAuthProfileRevision: vi.fn(async () => ({ definition: { renew: 'verify_slides' } })),
  transitionSessionUse: vi.fn(async () => null),
  markSessionOperationWaitingForAuth: vi.fn(async () => true),
  appendSessionEvent: vi.fn(async () => {}),
  finishSessionOperation: vi.fn(async () => true),
  setSessionStatus: vi.fn(async () => true),
  setSessionAuthSummary: vi.fn(async () => true),
  createSession: vi.fn(),
  claimSessionUse: vi.fn(),
  adoptSessionRetention: vi.fn(async () => {}),
}))
vi.mock('./session-auth', () => ({ verifyAuthProfile: vi.fn() }))
vi.mock('./runtime', async (load) => {
  const actual = await load<typeof import('./runtime')>()
  return { ...actual, submitLoginCredentials: vi.fn(async () => true) }
})
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
    'SESSION_STOP_UNCONFIRMED',
  )
  expect(setSessionStatus).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ sessionId: 's', status: 'LOST' }),
  )
})

const maintenanceGrant = {
  sessionId: 's',
  leaseId: 'l',
  generation: 1,
  sessionFencingToken: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  purpose: 'MAINTENANCE' as const,
  ownerKind: 'SESSION_OPERATION' as const,
  operationId: 'op',
}

it('CLOSE 未确认停止时 FAILED、SESSION_STOP_UNCONFIRMED 且会话 LOST', async () => {
  manager.close = vi.fn(async () => 'unconfirmed')
  manager.finishMaintenance = vi.fn(async () => undefined)
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'CLOSE', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1, version: 1 },
    grant: null,
    reusedRunId: null,
  })
  expect(manager.finishMaintenance).toHaveBeenCalledWith(
    'op',
    { targetId: 't', targetAccountId: 'a' },
    'FAILED',
    undefined,
    'SESSION_STOP_UNCONFIRMED',
  )
  expect(setSessionStatus).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ sessionId: 's', status: 'LOST' }),
  )
})

it('RESTART 未确认停止时不创建、不启动，并按 CLOSE 收口', async () => {
  manager.close = vi.fn(async () => 'unconfirmed')
  manager.finishMaintenance = vi.fn(async () => undefined)
  manager.launchAndOpen = vi.fn()
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'RESTART', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1, version: 1 },
    grant: null,
    reusedRunId: null,
  })
  expect(createSession).not.toHaveBeenCalled()
  expect(manager.launchAndOpen).not.toHaveBeenCalled()
  expect(manager.finishMaintenance).toHaveBeenCalledWith(
    'op',
    { targetId: 't', targetAccountId: 'a' },
    'FAILED',
    undefined,
    'SESSION_STOP_UNCONFIRMED',
  )
})

it('LOGIN 加 grant 时验证码路径转入 AUTH_WAIT，不取凭据', async () => {
  vi.mocked(loadTargetForExecution).mockResolvedValue({
    id: 't',
    entryUrl: 'https://example.com',
    authMethod: 'password',
    captchaMode: 'manual',
  } as any)
  vi.mocked(verifyAuthProfile).mockResolvedValue({
    observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' },
  } as any)
  vi.mocked(transitionSessionUse).mockResolvedValue({ ...maintenanceGrant, leaseId: 'wait' } as any)
  manager.ensureRunPage = vi.fn(() => ({ page: { url: () => 'https://example.com/login', goto: vi.fn() } }))
  expect(
    await manager.runMaintenanceAuth(
      { id: 's', generation: 1 },
      { id: 'op', kind: 'LOGIN', targetId: 't', targetAccountId: 'a' },
      maintenanceGrant,
      'ensure',
    ),
  ).toBe('waiting')
  expect(transitionSessionUse).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ fromPurpose: 'MAINTENANCE', toPurpose: 'AUTH_WAIT' }),
  )
  expect(manager.resolveAccountCredential).not.toHaveBeenCalled()
  expect(occupyAutoLoginBudget).not.toHaveBeenCalled()
})

it('登录已提交后核验抛错记 OUTCOME_UNKNOWN，并写未知失败 outcome', async () => {
  vi.mocked(occupyAutoLoginBudget).mockResolvedValue({ ok: true } as any)
  vi.mocked(verifyAuthProfile)
    .mockResolvedValueOnce({ observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' } } as any)
    .mockRejectedValueOnce(new Error('verify down'))
  manager.finishMaintenance = vi.fn(async () => undefined)
  manager.abandonOccupancy = vi.fn(async () => undefined)
  manager.bindOccupancy = vi.fn()
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'LOGIN', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1 },
    grant: maintenanceGrant,
    reusedRunId: null,
  })
  expect(occupyAutoLoginBudget).toHaveBeenCalled()
  expect(submitLoginCredentials).toHaveBeenCalled()
  expect(recordAutoLoginOutcome).toHaveBeenCalled()
  expect(setSessionAuthSummary).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ authState: 'UNKNOWN' }),
  )
  expect(manager.finishMaintenance).toHaveBeenCalledWith(
    'op',
    { targetId: 't', targetAccountId: 'a' },
    'FAILED',
    expect.anything(),
    'OUTCOME_UNKNOWN',
  )
  expect(manager.finishMaintenance.mock.calls.some((call: unknown[]) => call.includes('OPERATION_INTERRUPTED'))).toBe(
    false,
  )
})

it('verify_slides 核验失败不改走提交密码（CD12）', async () => {
  vi.mocked(verifyAuthProfile).mockResolvedValue({
    observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' },
  } as any)
  expect(
    await manager.runMaintenanceAuth(
      { id: 's' },
      { id: 'op', kind: 'RENEW_AUTH', targetId: 't', targetAccountId: 'a' },
      maintenanceGrant,
      'ensure',
    ),
  ).toMatchObject({ ok: false })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
  expect(occupyAutoLoginBudget).not.toHaveBeenCalled()
})

it('RESTART 成功路径在新实例 MAINTENANCE 占用内核验', async () => {
  const newSession = {
    id: 'new',
    generation: 2,
    reusePolicy: 'NEW_PAGE',
    idleTtlSeconds: 60,
    maxLifetimeSeconds: 3600,
    status: 'OPEN',
  }
  manager.close = vi.fn(async () => 'stopped')
  manager.launchAndOpen = vi.fn(async (session: typeof newSession) => ({ ok: true, session }))
  manager.finishMaintenance = vi.fn(async () => undefined)
  manager.lives.set('new', { handle: {} })
  vi.mocked(createSession).mockResolvedValue({ ok: true, session: newSession } as any)
  vi.mocked(claimSessionUse).mockResolvedValue({
    ok: true,
    grant: {
      sessionId: 'new',
      leaseId: 'ml',
      generation: 2,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: 'MAINTENANCE',
      ownerKind: 'SESSION_OPERATION',
      operationId: 'op',
    },
    session: newSession,
    created: false,
  } as any)
  vi.mocked(verifyAuthProfile).mockImplementation(async () => {
    expect(currentOccupancyGrant()?.purpose).toBe('MAINTENANCE')
    expect(currentOccupancyGrant()?.sessionId).toBe('new')
    return { observation: { authState: 'AUTHENTICATED', identityState: 'MATCH' } } as any
  })
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'RESTART', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1, reusePolicy: 'NEW_PAGE', idleTtlSeconds: 60, maxLifetimeSeconds: 3600 },
    grant: null,
    reusedRunId: null,
  })
  expect(manager.finishMaintenance).toHaveBeenCalledWith(
    'op',
    { targetId: 't', targetAccountId: 'a' },
    'SUCCEEDED',
    expect.objectContaining({ sessionId: 'new' }),
    undefined,
  )
  expect(currentOccupancyGrant()).toBeUndefined()
})

it('维护抛错只写一次 FAILED，不留 RUNNING', async () => {
  manager.finishMaintenance = vi.fn(async () => undefined)
  manager.bindOccupancy = vi.fn()
  manager.abandonOccupancy = vi.fn(async () => undefined)
  manager.runMaintenanceAuth = vi.fn(async () => {
    throw new Error('boom')
  })
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'VERIFY_AUTH', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1 },
    grant: maintenanceGrant,
    reusedRunId: null,
  })
  expect(manager.finishMaintenance).toHaveBeenCalledTimes(1)
  expect(manager.finishMaintenance).toHaveBeenCalledWith(
    'op',
    { targetId: 't', targetAccountId: 'a' },
    'FAILED',
    undefined,
    'OPERATION_INTERRUPTED',
  )
  expect(manager.abandonOccupancy).toHaveBeenCalled()
})

it('登录已提交后再次领取不得自动再提交', async () => {
  vi.mocked(occupyAutoLoginBudget)
    .mockResolvedValueOnce({ ok: true } as any)
    .mockResolvedValueOnce({ ok: false } as any)
  vi.mocked(verifyAuthProfile).mockResolvedValue({
    observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' },
  } as any)
  manager.finishMaintenance = vi.fn(async () => undefined)
  manager.bindOccupancy = vi.fn()
  manager.abandonOccupancy = vi.fn(async () => undefined)
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'LOGIN', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1 },
    grant: maintenanceGrant,
    reusedRunId: null,
  })
  await manager.attachMaintenanceOperation({
    operation: { id: 'op', kind: 'LOGIN', targetId: 't', targetAccountId: 'a' },
    session: { id: 's', status: 'OPEN', generation: 1 },
    grant: maintenanceGrant,
    reusedRunId: null,
  })
  expect(submitLoginCredentials).toHaveBeenCalledTimes(1)
})

it('生产方法与端口面都在', () => {
  const port = createBrowserPort(manager)
  expect(typeof manager.recoverAuth).toBe('function')
  expect(typeof manager.attachMaintenanceOperation).toBe('function')
  expect(typeof manager.runMaintenanceAuth).toBe('function')
  expect(typeof manager.sampleMapConditions).toBe('function')
  expect(typeof manager.restoreAuthGateFromCheckpoint).toBe('function')
  expect(typeof port.restoreAuthGate).toBe('function')
  expect(typeof port.recoverAuth).toBe('function')
  expect(typeof port.sampleMapConditions).toBe('function')
})
