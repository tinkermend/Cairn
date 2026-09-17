import { beforeEach, expect, it, vi } from 'vitest'
import { BrowserSessionManager } from './session-manager'
import { computeContextVersion } from '@cairn/shared'
import { occupyAutoLoginBudget, recordAutoLoginOutcome, enterRunWaitingForAuth } from '@cairn/db'
import { currentOccupancyGrant, submitLoginCredentials } from './runtime'
const db = vi.hoisted(() => ({ run: null as any }))
vi.mock('@cairn/db', async (original) => ({ ...await original<typeof import('@cairn/db')>(),
  getRun: vi.fn(async () => db.run),
  getSessionById: vi.fn(async () => ({ id: 'session', generation: 1 })),
  assertLiveAuthConfiguration: vi.fn(async () => ({ ok: true })),
  occupyAutoLoginBudget: vi.fn(async () => ({ ok: true })),
  readLiveSessionAuth: vi.fn(async () => ({ sessionAuth: {} })),
  recordAutoLoginOutcome: vi.fn(async () => {}),
  setSessionStatus: vi.fn(async () => true),
  touchSessionUsed: vi.fn(async () => true),
  enterRunWaitingForAuth: vi.fn(async () => {
    db.run.status = 'WAITING_FOR_AUTH'
    return {
      sessionId: 'session',
      leaseId: 'wait',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: 'AUTH_WAIT',
      ownerKind: 'RUN',
      runId: 'run',
    }
  }),
}))
vi.mock('./runtime', async (original) => {
  const actual = await original<typeof import('./runtime')>()
  return { ...actual, submitLoginCredentials: vi.fn(async () => {
    expect(actual.currentOccupancyGrant()?.purpose).toBe('EXECUTION')
    return true
  }) }
})
let manager: any, grant: any, snapshot: any, page: any
beforeEach(async () => {
  vi.clearAllMocks()
  manager = new BrowserSessionManager({} as any, { workerId: 'w', workerInstanceId: 'i' } as any)
  grant = { sessionId: 'session', leaseId: 'lease', generation: 1, sessionFencingToken: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), purpose: 'EXECUTION', ownerKind: 'RUN', runId: 'run', operationId: null }
  manager.guard.install(grant)
  let url = 'https://app.example/orders'
  page = {
    goto: vi.fn(async (next: string) => { url = next }),
    url: () => url,
    isClosed: () => false,
    on: vi.fn(),
    off: vi.fn(),
  }
  manager.lives.set('session', {
    handle: { basePage: page },
    sessionId: 'session',
    runPageIds: new Set(),
    runPages: new Map(),
    pages: new Map(),
    currentPageIdByLease: new Map(),
    currentPageIdByRun: new Map(),
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    allowedOrigins: ['https://app.example'],
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    screencasts: new Map(),
    screencastObservers: new Map(),
  })
  manager.leaseToSession.set('lease', 'session')
  manager.leaseToRun.set('lease', 'run')
  manager.pageForGrant = () => page
  manager.loadTargetAuth = vi.fn(async () => ({ entryUrl: 'https://app.example/', authMethod: 'password', captchaMode: 'none' }))
  manager.resolveLoginCredential = vi.fn(async () => ({ username: 'user', password: 'example-test-only' }))
  manager.verifyInRunAuth = vi.fn(async () => ({ authState: 'AUTHENTICATED', identityState: 'MATCH' }))
  manager.startVideoForLease = vi.fn(async () => {})
  manager.retargetVideoForLease = vi.fn(async () => {})
  manager.rebindVideoForLease = vi.fn()
  snapshot = { targetId: 'target', targetAccountId: 'account', authVerification: { capability: 'IDENTITY_VERIFIED', loginTimeoutMs: 1000 }, runAuthRecovery: { maxAutoRecoveriesPerRun: 1, maxManualRecoveriesPerRun: 1 } }
  db.run = { status: 'RUNNING', context: {}, snapshot, stepRuns: [{ stepId: 'step', status: 'RUNNING' }],
    authCheckpoint: { status: 'recovering', contextVersion: await computeContextVersion({}), nextStepId: 'step', sessionGeneration: 1, recoveryKind: 'auto', autoRecoveriesUsed: 1, manualRecoveriesUsed: 0,
      confirmObservation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' }, recoveryRule: { reuse: 'NEW_PAGE', entryUrl: 'https://app.example/', loginUrl: 'https://app.example/login', allowedOrigins: ['https://app.example'] } } }
})
const recover = (extra = {}) => manager.recoverAuth(grant, { kind: 'auto', runGrant: { runId: 'run' }, snapshot, ...extra })
it('自动登录在 EXECUTION 授权内执行，导航后再次核验', async () => {
  expect(await recover()).toEqual({ ok: true })
  expect(submitLoginCredentials).toHaveBeenCalledTimes(1)
  expect(manager.verifyInRunAuth).toHaveBeenCalledTimes(2)
  expect(page.goto).toHaveBeenCalledWith('https://app.example/', expect.anything())
  expect(currentOccupancyGrant()).toBeUndefined()
  expect(manager.startVideoForLease).toHaveBeenCalledWith('lease', 'session', snapshot)
  expect(manager.retargetVideoForLease).toHaveBeenCalled()
})
it('续接已开始的自动恢复仅核验，不再次提交凭据', async () => {
  expect(await recover({ resuming: true })).toEqual({ ok: true })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
})
it('UNKNOWN 不提交密码，交由 Engine 检查人工预算', async () => {
  db.run.authCheckpoint.confirmObservation.authState = 'UNKNOWN'
  expect(await recover()).toMatchObject({ ok: false, manualRequired: true })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
})
it('goto 超时不能伪装成已恢复', async () => {
  page.goto.mockRejectedValue(new Error('timeout'))
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true })
})
it('导航后身份改变不能打开门禁', async () => {
  manager.authGateClosed.add('lease')
  manager.verifyInRunAuth.mockResolvedValueOnce({ authState: 'AUTHENTICATED', identityState: 'MATCH' }).mockResolvedValueOnce({ authState: 'AUTHENTICATED', identityState: 'MISMATCH' })
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true })
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
})
it('没有被动信号时不主动核验（SM41）', async () => {
  manager.runAuth.set('lease', { snapshot, confirmed: false, observer: { inspect: vi.fn(async () => {}) } })
  for (let i = 0; i < 5; i++) expect(await manager.observeInRunAuth(grant, 'not_dispatched')).toBeNull()
  expect(manager.verifyInRunAuth).not.toHaveBeenCalled()
  expect(manager.countInRunVerify('step_boundary')).toBe(0)
})
it('重启发现检查点只关门，不凭身份 MATCH 跳过恢复规则', async () => {
  expect(await manager.restoreAuthGateFromCheckpoint('run', grant)).toBe(true)
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
  expect(manager.verifyInRunAuth).not.toHaveBeenCalled()
})
it('REUSE_PAGE 不接受已变更的文档', async () => {
  db.run.authCheckpoint.recoveryRule.reuse = 'REUSE_PAGE'
  db.run.authCheckpoint.pageRef = { sessionId: 'session', pageId: 'page', documentEpoch: 1 }
  manager.describeHoldPage = vi.fn(async () => ({ pageRef: { sessionId: 'session', pageId: 'page', documentEpoch: 2 } }))
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true })
})
it('REUSE_PAGE 越出冻结 pathPrefix 则不可恢复', async () => {
  db.run.authCheckpoint.recoveryRule.reuse = 'REUSE_PAGE'
  db.run.authCheckpoint.recoveryRule.allowedOrigins = ['https://app.example']
  snapshot.accessPolicy = {
    revision: 1,
    digest: 'a'.repeat(64),
    policy: {
      schemaVersion: 1,
      policyVersion: 1,
      rules: [{ origin: 'https://app.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/app' }],
    },
  }
  page.url = () => 'https://app.example/orders'
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE' })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
  expect(page.goto).not.toHaveBeenCalled()
})
it('REUSE_PAGE origin 已离开 allowedOrigins 则不可恢复', async () => {
  db.run.authCheckpoint.recoveryRule.reuse = 'REUSE_PAGE'
  db.run.authCheckpoint.recoveryRule.allowedOrigins = ['https://app.example']
  page.url = () => 'https://other.example/orders'
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE' })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
  expect(page.goto).not.toHaveBeenCalled()
})
it('续接时 origin 已离开也不可恢复，且不再核验登录', async () => {
  db.run.authCheckpoint.recoveryRule.reuse = 'REUSE_PAGE'
  db.run.authCheckpoint.recoveryRule.allowedOrigins = ['https://app.example']
  page.url = () => 'https://other.example/orders'
  manager.authGateClosed.add('lease')
  expect(await recover({ resuming: true })).toMatchObject({
    ok: false,
    unrecoverable: true,
    code: 'AUTH_CONTEXT_NOT_RECOVERABLE',
  })
  expect(manager.verifyInRunAuth).not.toHaveBeenCalled()
  expect(submitLoginCredentials).not.toHaveBeenCalled()
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
})
it('续接核验未 MATCH 不得开门', async () => {
  manager.authGateClosed.add('lease')
  manager.verifyInRunAuth.mockResolvedValue({ authState: 'AUTHENTICATED', identityState: 'UNVERIFIED' })
  expect(await recover({ resuming: true })).toMatchObject({ ok: false, unrecoverable: true })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
})
it('人工恢复写 AUTH_WAIT', async () => {
  expect(await recover({ kind: 'manual' })).toMatchObject({ ok: false, waitingForAuth: true })
  expect(enterRunWaitingForAuth).toHaveBeenCalled()
  expect(db.run.status).toBe('WAITING_FOR_AUTH')
  expect(manager.startVideoForLease).toHaveBeenCalled()
  expect(manager.rebindVideoForLease).toHaveBeenCalledWith('lease', 'wait')
})
it('自动恢复成功后开门，失败保持关闭', async () => {
  manager.authGateClosed.add('lease')
  expect(await recover()).toEqual({ ok: true })
  expect(() => manager.assertAuthGate('lease')).not.toThrow()
  manager.authGateClosed.add('lease')
  manager.verifyInRunAuth.mockResolvedValue({ authState: 'AUTHENTICATED', identityState: 'MISMATCH' })
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true })
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
})
it('续接核验未通过不得报成功', async () => {
  manager.authGateClosed.add('lease')
  manager.verifyInRunAuth.mockResolvedValue({ authState: 'EXPIRED', identityState: 'UNVERIFIED' })
  expect(await recover({ resuming: true })).toMatchObject({ ok: false, unrecoverable: true })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
})
it('自动登录预算占用失败不提交凭据', async () => {
  vi.mocked(occupyAutoLoginBudget).mockResolvedValueOnce({ ok: false, code: 'AUTH_AUTO_LOGIN_PAUSED', message: 'paused' } as any)
  expect(await recover()).toMatchObject({ waitingForAuth: true })
  expect(submitLoginCredentials).not.toHaveBeenCalled()
})
it('提交登录后抛错：预算已计次，必须补记一次失败 outcome 并保持门禁关闭', async () => {
  vi.mocked(submitLoginCredentials).mockRejectedValueOnce(new Error('login page crashed'))
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE' })
  expect(occupyAutoLoginBudget).toHaveBeenCalledTimes(1)
  expect(recordAutoLoginOutcome).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ targetAccountId: 'account', result: 'verify_failed' }),
  )
  expect(() => manager.assertAuthGate('lease')).toThrow('AUTH_GATE_CLOSED')
})
it('拿不到凭据不占自动登录额度', async () => {
  manager.resolveLoginCredential = vi.fn(async () => null)
  expect(await recover()).toMatchObject({ ok: false, unrecoverable: true })
  expect(occupyAutoLoginBudget).not.toHaveBeenCalled()
  expect(submitLoginCredentials).not.toHaveBeenCalled()
})
it('采样无页面或无占用都不 evaluate', async () => {
  const evaluate = vi.fn()
  manager.pageForGrant = () => undefined
  expect(await manager.sampleMapConditions(grant)).toEqual({ pageFrameObserved: false })
  const bare = {
    sessionId: 'session',
    leaseId: 'missing',
    generation: 1,
    sessionFencingToken: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  manager.pageForGrant = () => ({ evaluate, viewportSize: () => ({ width: 1440, height: 900 }) })
  expect(await manager.sampleMapConditions(bare)).toEqual({ pageFrameObserved: false })
  expect(evaluate).not.toHaveBeenCalled()
})
it('采样成功不写 lastUsedAt', async () => {
  const { setSessionStatus, touchSessionUsed } = await import('@cairn/db')
  manager.pageForGrant = () => ({
    evaluate: vi.fn(async () => 'en-US'),
    viewportSize: () => ({ width: 1440, height: 900 }),
  })
  expect(await manager.sampleMapConditions(grant)).toMatchObject({ pageFrameObserved: true, locale: 'en-US' })
  expect(vi.mocked(setSessionStatus)).not.toHaveBeenCalled()
  expect(vi.mocked(touchSessionUsed)).not.toHaveBeenCalled()
})
