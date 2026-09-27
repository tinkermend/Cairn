import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSessionManager, SessionLeaseError } from './session-manager.js'
import type { FrozenAuthVerification, RunGrant, RunSnapshot, SessionPolicy } from '@cairn/shared'
import type { SessionRecord } from '@cairn/db'

const dbMock = vi.hoisted(() => ({
  assertLiveAuthConfiguration: vi.fn(async () => ({ ok: true })),
  loadAuthProfileRevision: vi.fn(async () => ({
    definition: {
      verify: { mode: 'http', success: { status: 200 } },
      identity: { source: 'json', jsonPath: '$.user' },
      scope: { origins: ['https://example.com'] },
    },
    digest: 'profile-digest',
  })),
  loadTargetForExecution: vi.fn(async () => ({
    id: 'target-1',
    entryUrl: 'https://example.com',
    loginUrl: 'https://example.com/login',
  })),
  readSessionStateSnapshotContent: vi.fn(async () => null),
  resolveAccountAuthMaterials: vi.fn(async () => null),
  occupyAutoLoginBudget: vi.fn(async () => ({ ok: true })),
  recordAuthAttemptStarted: vi.fn(async () => {}),
  appendSessionEvent: vi.fn(async () => {}),
  setSessionStatus: vi.fn(async () => true),
  setSessionProbe: vi.fn(async () => true),
  getSessionById: vi.fn(async (db, id) => ({
    id,
    version: 1,
    generation: 1,
    status: 'ACTIVE',
    authState: 'AUTHENTICATED',
    identityState: 'MATCH',
  })),
  recordAutoLoginOutcome: vi.fn(async () => {}),
  readLiveSessionAuth: vi.fn(async () => ({ sessionAuth: {} })),
}))

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    assertLiveAuthConfiguration: dbMock.assertLiveAuthConfiguration,
    loadAuthProfileRevision: dbMock.loadAuthProfileRevision,
    loadTargetForExecution: dbMock.loadTargetForExecution,
    readSessionStateSnapshotContent: dbMock.readSessionStateSnapshotContent,
    resolveAccountAuthMaterials: dbMock.resolveAccountAuthMaterials,
    occupyAutoLoginBudget: dbMock.occupyAutoLoginBudget,
    recordAuthAttemptStarted: dbMock.recordAuthAttemptStarted,
    recordAutoLoginOutcome: dbMock.recordAutoLoginOutcome,
    appendSessionEvent: dbMock.appendSessionEvent,
    setSessionStatus: dbMock.setSessionStatus,
    setSessionProbe: dbMock.setSessionProbe,
    getSessionById: dbMock.getSessionById,
    readLiveSessionAuth: dbMock.readLiveSessionAuth,
  }
})

const runtimeMock = vi.hoisted(() => ({
  submitLoginCredentials: vi.fn(async () => true),
  probeAuth: vi.fn(async () => 'EXPIRED'),
  probeHealth: vi.fn(async () => ({ alive: true, responsive: true })),
  isAuthEvidenceFresh: vi.fn(() => false),
  planAuthEnsure: vi.fn(() => ({ action: 'verify' })),
  shouldSubmitStoredCredentials: vi.fn(() => true),
  pageLooksLikeLogin: vi.fn(() => false),
}))

vi.mock('./runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime')>()
  return {
    ...actual,
    submitLoginCredentials: runtimeMock.submitLoginCredentials,
    probeAuth: runtimeMock.probeAuth,
    probeHealth: runtimeMock.probeHealth,
    isAuthEvidenceFresh: runtimeMock.isAuthEvidenceFresh,
    planAuthEnsure: runtimeMock.planAuthEnsure,
    shouldSubmitStoredCredentials: runtimeMock.shouldSubmitStoredCredentials,
    pageLooksLikeLogin: runtimeMock.pageLooksLikeLogin,
  }
})

const authMock = vi.hoisted(() => ({
  verifyAuthProfile: vi.fn(async () => ({
    observation: {
      authState: 'EXPIRED' as const,
      identityState: 'UNVERIFIED' as const,
    },
  })),
}))

vi.mock('./session-auth', () => ({
  verifyAuthProfile: authMock.verifyAuthProfile,
}))

describe('session-claim 认证与启动完整性', () => {
  let manager: BrowserSessionManager
  let mockHandle: any
  let basePage: any

  beforeAll(() => {
    // clear mocks
  })

  beforeEach(() => {
    vi.clearAllMocks()
    basePage = {
      url: () => 'https://example.com/dashboard',
      goto: vi.fn(async () => {}),
      isClosed: () => false,
      context: () => ({ close: vi.fn(async () => {}) }),
    }
    mockHandle = {
      basePage,
      context: { close: vi.fn(async () => {}) },
    }
    manager = new BrowserSessionManager({} as any, {
      workerId: 'w1',
      workerInstanceId: 'i1',
      headless: true,
      maxSessions: 5,
      profileRoot: '/tmp/test-profiles',
    } as any)
  })

  describe('ensureProfileAuth 凭据解密与空密码', () => {
    const session: SessionRecord = {
      id: 'session-1',
      version: 1,
      generation: 1,
      targetId: 'target-1',
      targetAccountId: 'account-1',
      isolation: 'DEDICATED',
      accountSlot: 1,
      status: 'ACTIVE',
      authState: 'EXPIRED',
      identityState: 'UNVERIFIED',
      lastAuthSuccessAt: null,
      authProfileRevision: 1,
    } as any

    const run: RunSnapshot = {
      runId: 'run-1',
      targetId: 'target-1',
      targetAccountId: 'account-1',
      authVerification: {
        capability: 'IDENTITY_VERIFIED',
        profileRevision: 1,
        profileDigest: 'profile-digest',
        freshnessSeconds: 60,
        verifyRetryBackoffSeconds: [1],
        expectedIdentity: 'alice',
      } as FrozenAuthVerification,
    } as any

    const runGrant: RunGrant = {
      runId: 'run-1',
    } as any

    const policy: SessionPolicy = {} as any
    const occupancy = {
      sessionId: 'session-1',
      leaseId: 'lease-1',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: 'EXECUTION' as const,
      ownerKind: 'RUN' as const,
      runId: 'run-1',
      operationId: null,
    }
    const verification = run.authVerification!

    beforeEach(() => {
      ;(manager as any).lives.set('session-1', {
        handle: mockHandle,
        sessionId: 'session-1',
        generation: 1,
        runPageIds: new Set(),
        runPages: new Map(),
        pages: new Map(),
        currentPageIdByLease: new Map(),
        currentPageIdByRun: new Map(),
        autoInputClosed: false,
        inputAccepting: false,
        serial: Promise.resolve(),
        allowedOrigins: ['https://example.com'],
        receipts: new Map(),
        lastSeq: 0,
        controlEpoch: 0,
        screencasts: new Map(),
        screencastObservers: new Map(),
      })
      manager.loadTargetAuth = vi.fn(async () => ({
        entryUrl: 'https://example.com',
        loginUrl: 'https://example.com/login',
      })) as any
      manager.pageForGrant = vi.fn(() => basePage)
      manager.persistProfileObservation = vi.fn(async () => {})
      manager.settleOccupiedLanding = vi.fn(async () => {}) as any
      manager.enterWaitingForAuth = vi.fn(async () => ({
        ok: false as const,
        waitingForAuth: true,
        code: 'AUTH_CREDENTIAL_MISSING' as const,
        message: '账号未配置密码',
      }))
    })

    it('Run 凭据解密失败返回 AUTH_CREDENTIAL_UNREADABLE 且不进 AUTH_WAIT、不扣预算', async () => {
      manager.resolveLoginCredential = vi.fn(async () => {
        throw new SessionLeaseError('AUTH_CREDENTIAL_UNREADABLE', '主密钥损坏无法解密')
      })

      const res = await manager.ensureProfileAuth(session, run, runGrant, policy, occupancy, verification)

      expect(res).toEqual({
        ok: false,
        code: 'AUTH_CREDENTIAL_UNREADABLE',
        message: '主密钥损坏无法解密',
        waitingForAuth: false,
      })
      expect(manager.enterWaitingForAuth).not.toHaveBeenCalled()
      expect(dbMock.occupyAutoLoginBudget).not.toHaveBeenCalled()
      expect(runtimeMock.submitLoginCredentials).not.toHaveBeenCalled()
    })

    it('Run 凭据解出空密码进 AUTH_WAIT 且错误码为 AUTH_CREDENTIAL_MISSING，未扣预算', async () => {
      manager.resolveLoginCredential = vi.fn(async () => ({
        username: 'alice',
        password: '',
      }))

      await manager.ensureProfileAuth(session, run, runGrant, policy, occupancy, verification)

      expect(manager.enterWaitingForAuth).toHaveBeenCalledWith(
        session,
        runGrant,
        policy,
        occupancy,
        'AUTH_CREDENTIAL_MISSING',
        '账号未配置密码，无法自动登录',
        expect.anything(),
      )
      expect(dbMock.occupyAutoLoginBudget).not.toHaveBeenCalled()
      expect(runtimeMock.submitLoginCredentials).not.toHaveBeenCalled()
    })

    it('凭据有效时扣预算并提交自动登录', async () => {
      manager.resolveLoginCredential = vi.fn(async () => ({
        username: 'alice',
        password: 'valid-password',
      }))

      // 验证成功以跳出循环
      authMock.verifyAuthProfile
        .mockResolvedValueOnce({ observation: { authState: 'EXPIRED', identityState: 'UNVERIFIED' } as any })
        .mockResolvedValueOnce({ observation: { authState: 'AUTHENTICATED', identityState: 'MATCH' } as any })

      runtimeMock.planAuthEnsure
        .mockReturnValueOnce({ action: 'verify' } as any)
        .mockReturnValueOnce({ action: 'reuse' } as any)

      const res = await manager.ensureProfileAuth(session, run, runGrant, policy, occupancy, verification)

      expect(res.ok).toBe(true)
      expect(dbMock.occupyAutoLoginBudget).toHaveBeenCalledTimes(1)
      expect(runtimeMock.submitLoginCredentials).toHaveBeenCalledTimes(1)
    })
  })

  describe('launchAndOpen storageState 处理与自愈', () => {
    const createdSession: SessionRecord = {
      id: 'sess-new',
      version: 1,
      generation: 1,
      targetId: 'target-1',
      targetAccountId: 'account-1',
      isolation: 'DEDICATED',
      accountSlot: 1,
      status: 'CREATING',
      authState: 'UNKNOWN',
      identityState: 'UNVERIFIED',
    } as any

    beforeEach(() => {
      ;(manager as any).attachSessionAuthObserver = vi.fn(async () => {})
    })

    it('用户上传态解密失败时返回 AUTH_CREDENTIAL_UNREADABLE 并关闭会话', async () => {
      dbMock.resolveAccountAuthMaterials.mockResolvedValueOnce({
        storageStateSecretId: 'secret-ss-1',
      } as any)
      manager.resolveAccountSecrets = vi.fn(async () => {
        throw new SessionLeaseError('AUTH_CREDENTIAL_UNREADABLE', '解密 storageState 失败')
      })

      const res = await manager.launchAndOpen(createdSession, {
        targetId: 'target-1',
        targetAccountId: 'account-1',
      })

      expect(res).toEqual({
        ok: false,
        code: 'AUTH_CREDENTIAL_UNREADABLE',
        message: '解密 storageState 失败',
      })
      expect(dbMock.setSessionStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionId: 'sess-new',
          status: 'CLOSED',
          closeReason: 'launch_failed',
        }),
      )
    })

    it('用户上传态注入失败时返回 AUTH_STORAGE_STATE_INVALID 并关闭会话', async () => {
      manager.resolveAccountSecrets = vi.fn(async () => ({
        username: 'alice',
        storageState: { cookies: [{ name: 'bad' }] },
      }))
      dbMock.readSessionStateSnapshotContent.mockResolvedValueOnce(null)

      manager.launchOverride = vi.fn(async () => {
        throw new SessionLeaseError('AUTH_STORAGE_STATE_INVALID', 'Cookie 格式错误')
      })

      const res = await manager.launchAndOpen(createdSession, {
        targetId: 'target-1',
        targetAccountId: 'account-1',
      })

      expect(res).toEqual({
        ok: false,
        code: 'AUTH_STORAGE_STATE_INVALID',
        message: '上传的登录态无法注入，请重新上传',
      })
      expect(dbMock.appendSessionEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'session.state_restored',
          payload: { source: 'uploaded', result: 'inject_failed' },
        }),
      )
      expect(dbMock.setSessionStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionId: 'sess-new',
          status: 'CLOSED',
          closeReason: 'launch_failed',
        }),
      )
    })

    it('平台快照注入失败时记录事件并无状态重试启动成功', async () => {
      manager.resolveAccountSecrets = vi.fn(async () => ({ username: 'alice', storageState: undefined }))
      dbMock.readSessionStateSnapshotContent.mockResolvedValueOnce({
        state: { cookies: [{ name: 'corrupted' }] },
        stale: false,
        capturedAt: new Date().toISOString(),
      } as any)

      let launchCount = 0
      manager.launchOverride = vi.fn(async (_profileDir, opts) => {
        launchCount++
        if (opts.storageState) {
          throw new SessionLeaseError('AUTH_STORAGE_STATE_INVALID', '快照损坏')
        }
        return mockHandle
      })

      const res = await manager.launchAndOpen(createdSession, {
        targetId: 'target-1',
        targetAccountId: 'account-1',
      })

      expect(res.ok).toBe(true)
      expect(launchCount).toBe(2)
      expect(dbMock.appendSessionEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'session.state_restored',
          payload: { source: 'snapshot', result: 'inject_failed' },
        }),
      )
    })

    it('仅密码损坏未配置 storageState 时 launchAndOpen 正常启动', async () => {
      manager.resolveAccountSecrets = vi.fn(async () => ({ username: 'alice', storageState: undefined }))
      dbMock.readSessionStateSnapshotContent.mockResolvedValueOnce(null)
      manager.launchOverride = vi.fn(async () => mockHandle)

      const res = await manager.launchAndOpen(createdSession, {
        targetId: 'target-1',
        targetAccountId: 'account-1',
      })

      expect(res.ok).toBe(true)
    })

    it('SHARED 隔离模式下上传态注入失败释放 context 且关闭会话', async () => {
      const sharedSession: SessionRecord = {
        ...createdSession,
        isolation: 'SHARED',
      }
      manager.resolveAccountSecrets = vi.fn(async () => ({
        username: 'alice',
        storageState: { cookies: [{ name: 'bad' }] },
      }))
      dbMock.readSessionStateSnapshotContent.mockResolvedValueOnce(null)
      const releaseContextSpy = vi.fn(async () => {})
      ;(manager as any).hostPool = {
        acquireContext: vi.fn(async () => {
          throw new SessionLeaseError('AUTH_STORAGE_STATE_INVALID', 'Cookie 格式错误')
        }),
        releaseContext: releaseContextSpy,
      }

      const res = await manager.launchAndOpen(sharedSession, {
        targetId: 'target-1',
        targetAccountId: 'account-1',
      })

      expect(res).toEqual({
        ok: false,
        code: 'AUTH_STORAGE_STATE_INVALID',
        message: '上传的登录态无法注入，请重新上传',
      })
      expect(releaseContextSpy).toHaveBeenCalledWith('sess-new')
      expect(dbMock.setSessionStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionId: 'sess-new',
          status: 'CLOSED',
          closeReason: 'launch_failed',
        }),
      )
    })
  })

  describe('ensureAuth (LEGACY) 凭据解密与空密码', () => {
    const session: SessionRecord = {
      id: 'session-legacy',
      version: 1,
      generation: 1,
      targetId: 'target-1',
      targetAccountId: 'account-1',
      isolation: 'DEDICATED',
      accountSlot: 1,
      status: 'ACTIVE',
      authState: 'UNKNOWN',
      identityState: 'UNVERIFIED',
      lastAuthSuccessAt: null,
    } as any

    const run: RunSnapshot = {
      runId: 'run-legacy',
      targetId: 'target-1',
      targetAccountId: 'account-1',
      authVerification: {
        capability: 'LEGACY',
      } as any,
    } as any

    const runGrant: RunGrant = {
      runId: 'run-legacy',
    } as any

    const policy: SessionPolicy = {} as any
    const occupancy = {
      sessionId: 'session-legacy',
      leaseId: 'lease-legacy',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      purpose: 'EXECUTION' as const,
      ownerKind: 'RUN' as const,
      runId: 'run-legacy',
      operationId: null,
    }

    beforeEach(() => {
      ;(manager as any).lives.set('session-legacy', {
        handle: mockHandle,
        sessionId: 'session-legacy',
        generation: 1,
        runPageIds: new Set(),
        runPages: new Map(),
        pages: new Map(),
        currentPageIdByLease: new Map(),
        currentPageIdByRun: new Map(),
        autoInputClosed: false,
        inputAccepting: false,
        serial: Promise.resolve(),
        allowedOrigins: ['https://example.com'],
        receipts: new Map(),
        lastSeq: 0,
        controlEpoch: 0,
        screencasts: new Map(),
        screencastObservers: new Map(),
      })
      manager.loadTargetAuth = vi.fn(async () => ({
        entryUrl: 'https://example.com',
        loginUrl: 'https://example.com/login',
        authMethod: 'password',
        captchaMode: 'none',
      })) as any
      runtimeMock.probeAuth.mockResolvedValue('EXPIRED')
      manager.enterWaitingForAuth = vi.fn(async () => ({
        ok: false as const,
        waitingForAuth: true,
        code: 'AUTH_CREDENTIAL_MISSING' as const,
        message: '账号未配置密码',
      }))
    })

    it('LEGACY Run 凭据解密失败返回 AUTH_CREDENTIAL_UNREADABLE 且不进 AUTH_WAIT', async () => {
      manager.resolveLoginCredential = vi.fn(async () => {
        throw new SessionLeaseError('AUTH_CREDENTIAL_UNREADABLE', '密文解密失败')
      })

      const res = await manager.ensureAuth(session, run, runGrant, policy, occupancy)

      expect(res).toEqual({
        ok: false,
        code: 'AUTH_CREDENTIAL_UNREADABLE',
        message: '密文解密失败',
        waitingForAuth: false,
      })
      expect(manager.enterWaitingForAuth).not.toHaveBeenCalled()
    })

    it('LEGACY Run 凭据解出空密码进 AUTH_WAIT 且错误码为 AUTH_CREDENTIAL_MISSING', async () => {
      manager.resolveLoginCredential = vi.fn(async () => ({
        username: 'alice',
        password: '',
      }))

      await manager.ensureAuth(session, run, runGrant, policy, occupancy)

      expect(manager.enterWaitingForAuth).toHaveBeenCalledWith(
        session,
        runGrant,
        policy,
        occupancy,
        'AUTH_CREDENTIAL_MISSING',
        '账号未配置密码，无法自动登录',
        expect.anything(),
      )
    })
  })
})
