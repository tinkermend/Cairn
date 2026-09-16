import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import {
  acquireAuthControl,
  adoptSessionRetention,
  appendRunEvents,
  assertLiveAuthConfiguration,
  appendSessionEvent,
  isolateOrphanedSessions,
  claimSessionUse,
  createSession,
  occupancyGrantFromLease,
  conflict,
  enterRunWaitingForAuth,
  expireStaleAuthControl,
  countOpenSessionsForWorker,
  failRunValidation,
  findActiveLeaseRow,
  findAuthWaitLeaseForOperation,
  findAuthWaitLeaseForRun,
  findEvictableSession,
  finishSessionOperation,
  freezeAuthVerificationForRun,
  getSessionOperation,
  invalidateSessionProfile,
  loadAuthProfileRevision,
  markSessionOperationWaitingForAuth,
  occupyAutoLoginBudget,
  readLiveSessionAuth,
  recordAutoLoginOutcome,
  reapSessionLeases,
  expireAuthHold,
  failRunAuthTimeout,
  findLiveSession,
  findSessionByAuthHoldRun,
  getRun,
  loadRunDetail,
  getSessionById,
  getWorkerById,
  hashAuthControlToken,
  heartbeatAuthControl,
  isBoundAuthHold,
  listOwnedLiveSessions,
  listExpiredAuthHolds,
  listReapableSessions,
  listRequestedCloseSessions,
  loadSecretCiphertext,
  markSessionsClosing,
  recordInlineLogEvidence,
  releaseAuthControl,
  releaseAuthHold,
  releaseSessionUse,
  renewSessionUse,
  resumeRunAfterAuth,
  scheduleNextAuthCheck,
  setSessionAuthSummary,
  setSessionProbe,
  setSessionStatus,
  transitionSessionUse,
  updateRunDebugOverlay,
  writeRunAuthCheckpoint,
  loadAccountForExecution,
  loadTargetForExecution,
  type DbHandle,
  type LeaseRecord,
  type SessionRecord,
} from '@cairn/db'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_MANAGED_BROWSER_CAPABILITIES,
  DEFAULT_SESSION_POLICY,
  LOCAL_SECRET_PROVIDER,
  BROWSER_FRAME_MAX_FPS,
  canObserveManagedFrames,
  resolveEvidencePolicy,
  resolveSessionPolicy,
  shouldCaptureEvidence,
  type AcquireAuthControlResponse,
  type AuthControlInputReceipt,
  type AuthCheckpoint,
  type AuthObservation,
  type AuthRecoveryOutcome,
  type AuthSignal,
  type BrowserAuthInputCommand,
  type BrowserCommand,
  type BrowserCommandEvidence,
  type BrowserCommandResult,
  type ExecutionError,
  type FrozenAuthVerification,
  authGateClosedError,
  classifyAuthSignals,
  classifyInterruptedAttempt,
  computeContextVersion,
  deriveRecoveryRule,
  inRunAuthVerifyAllowed,
  isAuthEvidenceFresh,
  isContextRecoverable,
  isSessionMaintenanceKind,
  pageLooksLikeLogin,
  redactAuthUrl,
  planAuthEnsure,
  shouldCloseAuthGate,
  type RecoveryRule,
  type ManagedBrowserCapabilities,
  type ManagedBrowserFrame,
  type ManagedBrowserMeta,
  type ManagedPageSummary,
  type MapViewport,
  type ObserveGrant,
  type ObserveOperation,
  type PageRef,
  type RunGrant,
  type TargetObservation,
  type RunSnapshot,
  type SessionErrorCode,
  type SessionEventType,
  type SessionGrant,
  type SessionPolicy,
} from '@cairn/shared'
import type { LocalSecretProvider } from '@cairn/secret'
import { DB_HANDLE } from '../db/db.module'
import { SessionGuard, GuardError } from './guard'
import { ensureProfileDir, profileDirFor } from './profiles'
import { verifyAuthProfile } from './session-auth'
import { pageStrategyForReuse, shouldRecreateSession } from './reuse'
import {
  BrowserRuntimeError,
  OccupancyRequiredError,
  closePage,
  countPages,
  gotoPage,
  launchSession,
  loginWithCredentials,
  openRunPage,
  probeAuth,
  probeAuthOnPage,
  probeHealth,
  runWithOccupancy,
  runWithSessionRestart,
  submitLoginCredentials,
  waitForPopupsFrom,
  screenshotPage,
  stopSession,
  type BrowserHandle,
  type TargetAuthInfo,
} from './runtime'
import { assertPageTargetScope, hasTargetScope, installTargetScope, TargetScopeError } from './target-scope'
import { executeOnPage } from './surface'
import { highlightOnPage, pickOnPage } from './observe'
import { resolveObserveGrant } from './observe-grant'
import { refreshScreencastIfStale, startScreencast, type ScreencastHandle } from './screencast'
import { applyAuthInput, enqueueSerial, handoffMessage, rememberReceipt, viewportMatches } from './managed-helpers'
import { createManagedPage, originAllowed, pageRefFor, pickPopupHandoff, type ManagedPageEntry } from './page-identity'

export type BrowserSessionManagerOptions = {
  workerId: string
  profileRoot: string
  headless: boolean
  maxSessions: number
  executablePath?: string
  defaultLeaseTtlSeconds: number
  /** 仅兼容旧测试夹具；缺字段的历史快照回落代码默认，不读当前进程 env。 */
  defaultAuthWaitSeconds: number
  heartbeatMs: number
  workerInstanceId?: string
}

export const BROWSER_SESSION_OPTIONS = Symbol('BROWSER_SESSION_OPTIONS')
import { SECRET_PROVIDER } from '../tokens.js'
export { SECRET_PROVIDER }

export type SessionAcquireResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }

export class SessionLeaseError extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.name = 'SessionLeaseError'
    this.code = code
  }
}

type LiveHandle = {
  handle: BrowserHandle
  sessionId: string
  runPageIds: Set<string>
  runPages: Map<string, Awaited<ReturnType<typeof openRunPage>>>
  pages: Map<string, ManagedPageEntry>
  currentPageIdByLease: Map<string, string>
  currentPageIdByRun: Map<string, string>
  autoInputClosed: boolean
  inputAccepting: boolean
  serial: Promise<void>
  allowedOrigins: string[]
  receipts: Map<string, AuthControlInputReceipt>
  lastSeq: number
  controlEpoch: number
  screencasts: Map<string, ScreencastHandle>
  screencastObservers: Map<string, number>
}

@Injectable()
export class BrowserSessionManager {
  private readonly logger = new Logger(BrowserSessionManager.name)
  readonly guard = new SessionGuard()
  private readonly acquiring = new Set<string>()
  private readonly lives = new Map<string, LiveHandle>()
  private readonly leaseToSession = new Map<string, string>()
  private readonly leaseToRun = new Map<string, string>()
  private readonly leaseTtls = new Map<string, number>()
  private readonly tracingByLease = new Map<string, boolean>()
  private readonly observeGrants = new Map<string, { grant: ObserveGrant; expiresAt: number }>()
  private readonly authGateClosed = new Set<string>()
  private readonly inRunVerifyCounts = new Map<string, number>()
  private readonly runAuth = new Map<
    string,
    {
      snapshot?: RunSnapshot
      observer?: { inspect: () => Promise<void> }
      pendingSignal?: boolean
      transient?: boolean
    }
  >()
  private heartbeat: NodeJS.Timeout | undefined
  private reconciled = false
  private browserUnavailable = false
  private browserUnavailableCode: 'BROWSER_UNAVAILABLE' | 'BROWSER_LAUNCH_FAILED' = 'BROWSER_UNAVAILABLE'
  private workerInstanceId: string
  /** 测试钩子：覆盖默认 launch。 */
  launchOverride?: typeof launchSession

  setWorkerInstance(instanceId: string): void {
    this.workerInstanceId = instanceId
  }

  getWorkerInstanceId(): string {
    return this.workerInstanceId
  }

  private ownerScope() {
    return {
      ownerWorkerId: this.options.workerId,
      ownerWorkerInstanceId: this.workerInstanceId,
    }
  }

  private async dropLocalHandle(sessionId: string): Promise<'stopped' | 'unconfirmed'> {
    const live = this.lives.get(sessionId)
    if (!live) return 'unconfirmed'
    live.screencastObservers.clear()
    for (const cast of live.screencasts.values()) {
      await cast.stop().catch(() => undefined)
    }
    for (const page of live.runPages.values()) {
      await closePage(page)
    }
    const stopResult = await stopSession(live.handle)
    this.lives.delete(sessionId)
    for (const [leaseId, mapped] of [...this.leaseToSession.entries()]) {
      if (mapped === sessionId) {
        this.leaseToSession.delete(leaseId)
        this.leaseToRun.delete(leaseId)
        this.leaseTtls.delete(leaseId)
      }
    }
    return stopResult
  }

  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Inject(BROWSER_SESSION_OPTIONS) private readonly options: BrowserSessionManagerOptions,
    @Optional() @Inject(SECRET_PROVIDER) private readonly secrets?: LocalSecretProvider,
  ) {
    this.workerInstanceId = options.workerInstanceId ?? randomUUID()
  }

  startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      void this.renewAll().catch((error) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'lease.renew_cycle_failed',
        )
      })
    }, this.options.heartbeatMs)
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  liveHandleCount(): number {
    return this.lives.size
  }

  /** Worker 启动自愈：旧代次或未知归属的会话隔离为 LOST，不放账号键。 */
  async reconcileOwn(): Promise<{ leasesRevoked: number; sessionsClosed: number }> {
    if (this.reconciled) {
      return { leasesRevoked: 0, sessionsClosed: 0 }
    }
    const db = this.dbHandle
    const sessionsClosed = await isolateOrphanedSessions(db, this.options.workerId, this.workerInstanceId)
    this.reconciled = true
    this.logger.log(
      { workerId: this.options.workerId, instanceId: this.workerInstanceId, sessionsClosed },
      'session.reconcile_own',
    )
    return { leasesRevoked: 0, sessionsClosed }
  }

  async acquire(run: RunSnapshot, runGrant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireResult> {
    const key = `${run.targetId}:${run.targetAccountId ?? ''}`
    if (this.acquiring.has(key)) return { ok: false, code: 'SESSION_BUSY', message: '同一目标账号正在获取会话' }
    this.acquiring.add(key)
    try { return await this.acquireExclusive(run, runGrant, signal) }
    finally { this.acquiring.delete(key) }
  }

  private bindOccupancy(grant: SessionGrant, runId: string, ttlSeconds: number) {
    this.guard.install(grant)
    this.leaseToSession.set(grant.leaseId, grant.sessionId)
    this.leaseToRun.set(grant.leaseId, runId)
    this.leaseTtls.set(grant.leaseId, ttlSeconds)
  }

  private unbindOccupancy(leaseId: string) {
    this.guard.revoke(leaseId)
    this.leaseToSession.delete(leaseId)
    this.leaseToRun.delete(leaseId)
    this.leaseTtls.delete(leaseId)
  }

  private async abandonOccupancy(leaseId: string, reason: string) {
    this.unbindOccupancy(leaseId)
    await releaseSessionUse(this.dbHandle, {
      leaseId,
      holderWorkerId: this.options.workerId,
      reason,
    }).catch(() => {})
  }

  private withHeldOccupancy<T>(
    leaseId: string,
    expected: Partial<SessionGrant> | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> | T {
    return runWithOccupancy(this.guard.assertHeld(leaseId, expected), fn)
  }

  private async acquireExclusive(run: RunSnapshot, runGrant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireResult> {
    if (!run.targetAccountId) {
      return {
        ok: false,
        code: 'SESSION_ACCOUNT_REQUIRED',
        message: '浏览器步骤需要 targetAccountId',
      }
    }

    signal?.throwIfAborted()
    const targetInfo = await this.loadTargetAuth(run)
    if (!targetInfo) {
      return { ok: false, code: 'SESSION_TARGET_MISSING', message: '目标系统不存在' }
    }

    let policy: SessionPolicy
    try {
      policy = resolveSessionPolicy(run.sessionPolicy, this.platformDefaultPolicy())
    } catch {
      return { ok: false, code: 'SESSION_POLICY_INVALID', message: '会话策略非法' }
    }
    const key = { targetId: run.targetId, targetAccountId: run.targetAccountId }
    const db = this.dbHandle

    let live = await findLiveSession(db, key)
    if (live && (live.status === 'CLOSING' || live.status === 'LOST')) {
      return {
        ok: false,
        code: live.closeReason === 'resource_deleted' ? 'SESSION_TARGET_MISSING' : 'SESSION_BUSY',
        message:
          live.closeReason === 'resource_deleted' ? '目标系统或账号不存在' : '会话正在关闭或已失联',
      }
    }

    if (shouldRecreateSession(policy.reuse) && live) {
      if (live.ownerWorkerId === this.options.workerId) {
        await this.close(live.id, 'recreate_session')
        live = null
      } else {
        return {
          ok: false,
          code: 'SESSION_BUSY',
          message: '会话由其他 Worker 持有，无法 RECREATE',
        }
      }
    }

    if (!live) {
      let openCount = await countOpenSessionsForWorker(db, this.options.workerId)
      if (openCount >= this.options.maxSessions) {
        const evictable = await findEvictableSession(db, this.options.workerId, this.workerInstanceId)
        if (evictable) {
          await this.close(evictable.id, 'capacity_evict')
          openCount = await countOpenSessionsForWorker(db, this.options.workerId)
        }
        if (openCount >= this.options.maxSessions) {
          return {
            ok: false,
            code: 'SESSION_CAPACITY_EXCEEDED',
            message: `本 Worker 会话数已达上限 ${this.options.maxSessions}`,
          }
        }
      }

      if (this.browserUnavailable) {
        return {
          ok: false,
          code: this.browserUnavailableCode,
          message: '本机浏览器不可用，已暂停新建会话',
        }
      }
    } else {
      if (live.ownerWorkerId !== this.options.workerId) {
        return {
          ok: false,
          code: 'SESSION_BUSY',
          message: `会话 owner 为 ${live.ownerWorkerId}`,
        }
      }
      if (!live.ownerWorkerInstanceId || live.ownerWorkerInstanceId !== this.workerInstanceId) {
        return {
          ok: false,
          code: 'SESSION_NOT_CLAIMABLE',
          message: '会话归属实例未知或已更换，禁止复用',
        }
      }
      if (live.status !== 'OPEN' || live.health === 'UNHEALTHY') {
        return {
          ok: false,
          code: 'SESSION_NOT_CLAIMABLE',
          message: `会话不可领取 status=${live.status} health=${live.health}`,
        }
      }
      if (!this.lives.has(live.id)) {
        return {
          ok: false,
          code: 'SESSION_NOT_CLAIMABLE',
          message: '本进程无会话句柄，请等待自愈或重建',
        }
      }
    }

    const claimed = await claimSessionUse(db, {
      key,
      owner: { kind: 'RUN', runId: run.runId, runFencingToken: runGrant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: this.options.workerId,
      holderInstanceId: this.workerInstanceId,
      leaseTtlSeconds: policy.leaseTtlSeconds,
      reusePolicy: policy.reuse,
      idleTtlSeconds: policy.idleTtlSeconds,
      maxLifetimeSeconds: policy.maxLifetimeSeconds,
    })
    if (!claimed.ok) {
      return { ok: false, code: claimed.code, message: claimed.message ?? '会话不可领取' }
    }

    const grant = claimed.grant
    this.bindOccupancy(grant, run.runId, policy.leaseTtlSeconds)
    try {
      return await runWithOccupancy(grant, () =>
        this.finishClaimedAcquire(claimed.created, claimed.session, run, runGrant, policy, grant, signal),
      )
    } catch (error) {
      if (error instanceof OccupancyRequiredError) {
        await this.abandonOccupancy(grant.leaseId, 'occupancy_required')
        return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: error.message }
      }
      await this.abandonOccupancy(grant.leaseId, 'acquire_failed')
      throw error
    }
  }

  private async finishClaimedAcquire(
    created: boolean,
    session: SessionRecord,
    run: RunSnapshot,
    runGrant: RunGrant,
    policy: SessionPolicy,
    grant: SessionGrant,
    signal?: AbortSignal,
  ): Promise<SessionAcquireResult> {
    let live = session
    if (created || !this.lives.has(session.id)) {
      const launched = await this.launchAndOpen(session, {
        targetId: run.targetId,
        targetAccountId: run.targetAccountId!,
      })
      if (!launched.ok) {
        await this.abandonOccupancy(grant.leaseId, launched.code.toLowerCase())
        return launched
      }
      live = launched.session
      this.logger.log(
        {
          sessionId: live.id,
          generation: live.generation,
          workerId: this.options.workerId,
          runId: run.runId,
        },
        'session.created',
      )
    } else {
      this.logger.log(
        {
          sessionId: live.id,
          generation: live.generation,
          workerId: this.options.workerId,
          runId: run.runId,
        },
        'session.reused',
      )
    }

    const managed = this.lives.get(live.id)
    if (managed) {
      managed.allowedOrigins = run.allowedOrigins ?? []
      if (run.deadlineAt || hasTargetScope(managed.handle.context)) {
        await installTargetScope(managed.handle.context, managed.allowedOrigins)
      }
    }
    await this.applyReuse(live, policy, grant.leaseId)
    if (managed) this.ensureRunPage(managed, run.runId, grant.leaseId)

    signal?.throwIfAborted()
    const authSessionId = live.id
    let closing: Promise<void> | undefined
    const abortAuth = () => {
      closing = this.close(authSessionId, 'acquire_aborted').then(() => undefined).catch(() => undefined)
    }
    signal?.addEventListener('abort', abortAuth, { once: true })
    try {
      signal?.throwIfAborted()
      const auth = await this.ensureAuth(live, run, runGrant, policy, grant, signal)
      signal?.throwIfAborted()
      if (!auth.ok) {
        if (!auth.waitingForAuth) await this.abandonOccupancy(grant.leaseId, 'auth_failed')
        return auth
      }
      live = auth.session
    } finally {
      signal?.removeEventListener('abort', abortAuth)
      await closing
    }
    const ready = this.lives.get(live.id)
    if (ready) {
      ready.autoInputClosed = false
      ready.inputAccepting = false
    }

    await this.startTracingForLease(grant.leaseId, live.id, run)
    this.logger.log(
      {
        sessionId: grant.sessionId,
        leaseId: grant.leaseId,
        sessionGeneration: grant.generation,
        fencingToken: grant.sessionFencingToken,
        workerId: this.options.workerId,
        runId: run.runId,
      },
      'lease.acquired',
    )
    this.runAuth.set(grant.leaseId, { ...this.runAuth.get(grant.leaseId), snapshot: run })
    return { ok: true, grant: this.guard.assertHeld(grant.leaseId) }
  }

  private liveSessionIdForOwner(ownerId: string): string | undefined {
    const leaseId = [...this.leaseToRun.entries()].find(([, mapped]) => mapped === ownerId)?.[0]
    return leaseId ? this.leaseToSession.get(leaseId) : undefined
  }

  countInRunVerify(phase: string): number {
    return this.inRunVerifyCounts.get(phase) ?? 0
  }

  assertAuthGate(leaseId: string): void {
    if (this.authGateClosed.has(leaseId)) {
      throw new Error('AUTH_GATE_CLOSED')
    }
  }

  private expiredAuthObservation(summary: string, snapshot?: RunSnapshot): AuthObservation {
    return {
      authState: 'EXPIRED',
      identityState: 'UNVERIFIED',
      observedIdentity: null,
      unknownClass: null,
      evidenceSummary: summary,
      authProfileRevision: snapshot?.authVerification?.profileRevision ?? null,
      diagnosticCode: 'verified',
    }
  }

  private async applyRecoveryRule(
    page: { url: () => string },
    rule: RecoveryRule,
  ): Promise<boolean> {
    if (rule.reuse === 'NEW_PAGE') {
      try {
        await gotoPage(page as Parameters<typeof gotoPage>[0], rule.entryUrl)
      } catch {
        return false
      }
      return Boolean(rule.entryUrl) && !pageLooksLikeLogin({ pageUrl: page.url(), loginUrl: rule.loginUrl })
    }
    return isContextRecoverable({ rule, pageUrl: page.url() })
  }

  markTransientPageState(grant: SessionGrant): void {
    const current = this.runAuth.get(grant.leaseId) ?? {}
    this.runAuth.set(grant.leaseId, { ...current, transient: true })
  }

  async restoreAuthGateFromCheckpoint(runId: string, grant: SessionGrant): Promise<boolean> {
    const run = await getRun(this.dbHandle, runId)
    const status = run?.authCheckpoint?.status
    if (status === 'recovering' || status === 'closed') {
      this.authGateClosed.add(grant.leaseId)
      return true
    }
    return false
  }

  async verifyInRunAuth(
    grant: SessionGrant,
    phase?: string,
    snapshot?: RunSnapshot,
  ): Promise<Pick<AuthObservation, 'authState' | 'identityState'>> {
    if (phase) this.inRunVerifyCounts.set(phase, (this.inRunVerifyCounts.get(phase) ?? 0) + 1)
    const snap = snapshot ?? this.runAuth.get(grant.leaseId)?.snapshot
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    const live = this.lives.get(sessionId)
    if (!live || !snap) return { authState: 'UNKNOWN', identityState: 'UNVERIFIED' }
    const verification = snap.authVerification
    if (verification?.profileRevision) {
      const profile = await loadAuthProfileRevision(this.dbHandle, snap.targetId, verification.profileRevision)
      if (profile) {
        const verified = await verifyAuthProfile(live.handle, {
          definition: profile.definition,
          verification,
        })
        return verified.observation
      }
    }
    const target = await this.loadTargetAuth(snap)
    if (!target) return { authState: 'UNKNOWN', identityState: 'UNVERIFIED' }
    const auth = await probeAuth(live.handle, target)
    return {
      authState: auth === 'AUTHENTICATED' || auth === 'EXPIRED' ? auth : 'UNKNOWN',
      identityState: 'UNVERIFIED',
    }
  }

  async observeInRunAuth(
    grant: SessionGrant,
    classification: 'dispatched' | 'not_dispatched',
    _signal?: AbortSignal,
  ): Promise<ExecutionError | null> {
    const state = this.runAuth.get(grant.leaseId)
    if (state?.observer?.inspect) await state.observer.inspect()
    const page = this.pageForGrant(grant)
    const pageUrl = page && typeof page.url === 'function' ? page.url() : ''
    const snapshot = state?.snapshot
    const loginUrl = snapshot?.targetAuth?.loginUrl
    const onLogin = pageLooksLikeLogin({ pageUrl, loginUrl })
    if (!onLogin && !state?.pendingSignal) return null
    const capability = snapshot?.authVerification?.capability ?? 'LEGACY'
    const signals = classifyAuthSignals({
      observation: {
        authState: onLogin ? 'EXPIRED' : 'UNKNOWN',
        identityState: 'UNVERIFIED',
        observedIdentity: null,
        unknownClass: null,
        evidenceSummary: onLogin ? '失效定位可见' : null,
        authProfileRevision: snapshot?.authVerification?.profileRevision ?? null,
        diagnosticCode: null,
      },
      pageUrl,
      loginUrl,
    })
    const runId = this.leaseToRun.get(grant.leaseId)
    if (signals.length > 0 && runId) {
      await appendRunEvents(
        this.dbHandle,
        runId,
        signals.map((signal) => ({ type: 'run.auth_signal' as const, payload: signal })),
      ).catch(() => undefined)
    }
    if (!shouldCloseAuthGate({ capability, signals })) return null
    this.authGateClosed.add(grant.leaseId)
    this.runAuth.set(grant.leaseId, { ...state, pendingSignal: true })
    const observation = await this.verifyInRunAuth(grant, 'signal_confirm', snapshot)
    if (
      observation.authState === 'AUTHENTICATED' &&
      (capability !== 'IDENTITY_VERIFIED' || observation.identityState === 'MATCH')
    ) {
      this.authGateClosed.delete(grant.leaseId)
      return null
    }
    const error = authGateClosedError(
      classification === 'dispatched'
        ? classifyInterruptedAttempt({ effectType: 'IDEMPOTENT', dispatched: true })
        : 'not_dispatched',
    )
    const kind =
      observation.identityState === 'MISMATCH'
        ? 'MISMATCH'
        : onLogin || observation.authState === 'EXPIRED'
          ? 'EXPIRED'
          : 'UNKNOWN'
    if (snapshot?.sessionPolicy?.reuse === 'REUSE_PAGE') {
      const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
      await setSessionAuthSummary(this.dbHandle, {
        sessionId,
        ...this.ownerScope(),
        authState: kind === 'MISMATCH' ? 'AUTHENTICATED' : 'EXPIRED',
        identityState: kind === 'MISMATCH' ? 'MISMATCH' : 'UNVERIFIED',
        lastAuthError: null,
        authProfileRevision: snapshot?.authVerification?.profileRevision ?? null,
        observedTier: capability === 'LEGACY' ? null : capability,
        recordSuccess: false,
      }).catch(() => undefined)
    }
    return { ...error, cause: { ...error.cause, message: kind } }
  }

  async sampleMapConditions(
    grant: SessionGrant,
    _signal?: AbortSignal,
  ): Promise<{ locale?: string; viewport?: MapViewport; pageFrameObserved: boolean }> {
    try {
      return await this.withHeldOccupancy(grant.leaseId, grant, async () => {
        const page = this.pageForGrant(grant)
        if (!page) return { pageFrameObserved: false }
        let locale: string | undefined
        try {
          locale = await page.evaluate(() => navigator.language)
        } catch {
          locale = undefined
        }
        const size = typeof page.viewportSize === 'function' ? page.viewportSize() : null
        const viewport = size
          ? {
              category:
                size.width >= 1024 ? ('desktop' as const) : size.width >= 768 ? ('tablet' as const) : ('mobile' as const),
              widthPx: size.width,
              heightPx: size.height,
            }
          : undefined
        return { locale, viewport, pageFrameObserved: true }
      })
    } catch {
      return { pageFrameObserved: false }
    }
  }

  async recoverAuth(
    grant: SessionGrant,
    input: {
      kind: 'auto' | 'manual'
      runGrant: RunGrant
      snapshot: RunSnapshot
      resuming?: boolean
      signal?: AbortSignal
    },
  ): Promise<AuthRecoveryOutcome> {
    const current = this.runAuth.get(grant.leaseId) ?? {}
    this.runAuth.set(grant.leaseId, { ...current, snapshot: input.snapshot })
    return this.withHeldOccupancy(grant.leaseId, grant, () => this.recoverAuthHeld(grant, input))
  }

  private async recoverAuthHeld(
    grant: SessionGrant,
    input: {
      kind: 'auto' | 'manual'
      runGrant: RunGrant
      snapshot: RunSnapshot
      resuming?: boolean
    },
  ): Promise<AuthRecoveryOutcome> {
    const run = await getRun(this.dbHandle, input.runGrant.runId)
    const checkpoint = run?.authCheckpoint
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    const session = await getSessionById(this.dbHandle, sessionId)
    const live = this.lives.get(sessionId)
    const page = this.pageForGrant(grant) ?? live?.handle.basePage
    const policy = resolveSessionPolicy(input.snapshot.sessionPolicy)
    const target = await this.loadTargetAuth(input.snapshot)
    const waiting = async (
      code: SessionErrorCode,
      message: string,
    ): Promise<AuthRecoveryOutcome> => {
      if (!session) return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      const result = await this.enterWaitingForAuth(session, input.runGrant, policy, grant, code, message, target ?? undefined)
      return result.waitingForAuth
        ? { ok: false, waitingForAuth: true }
        : { ok: false, unrecoverable: true, code: result.code, runStatus: 'FAILED' }
    }
    if (input.resuming) {
      const after = await this.verifyInRunAuth(grant, 'recovery', input.snapshot)
      const passed = after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH'
      if (!passed) {
        this.authGateClosed.add(grant.leaseId)
        return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      }
      this.authGateClosed.delete(grant.leaseId)
      return { ok: true }
    }
    if (checkpoint?.recoveryRule?.reuse === 'REUSE_PAGE') {
      const hold = await this.describeHoldPage(input.runGrant.runId)
      if (checkpoint.pageRef && hold?.pageRef && hold.pageRef.documentEpoch !== checkpoint.pageRef.documentEpoch) {
        return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      }
      const pageUrl = (page && typeof page.url === 'function' ? page.url() : hold?.url) ?? ''
      if (pageUrl && !this.originAllowed(pageUrl, checkpoint.recoveryRule.allowedOrigins ?? [])) {
        return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      }
    }
    if (checkpoint?.recoveryRule?.reuse === 'NEW_PAGE' && page) {
      const entryUrl = checkpoint.recoveryRule.entryUrl
      if (entryUrl) {
        try {
          await gotoPage(page, entryUrl)
        } catch {
          return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
        }
      }
    }
    if (input.kind === 'auto' && checkpoint?.confirmObservation?.authState === 'UNKNOWN') {
      return { ok: false, manualRequired: true, code: 'AUTH_PROBE_UNKNOWN' }
    }
    if (input.kind === 'manual') {
      return waiting('SESSION_AUTH_UNSUPPORTED', '登录已失效，等待人工认证')
    }
    if (!inRunAuthVerifyAllowed('recovery')) {
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    if (!input.snapshot.targetAccountId || input.snapshot.authVerification?.capability !== 'IDENTITY_VERIFIED') {
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    const occupied = await occupyAutoLoginBudget(this.dbHandle, {
      targetId: input.snapshot.targetId,
      targetAccountId: input.snapshot.targetAccountId,
    })
    if (!occupied.ok) {
      return waiting(occupied.code as SessionErrorCode, occupied.message)
    }
    const credential = await this.resolveLoginCredential(input.snapshot)
    if (!credential || !live || !target) {
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    await this.verifyInRunAuth(grant, 'recovery', input.snapshot)
    const submitted = await submitLoginCredentials(
      live.handle,
      target,
      credential,
      input.snapshot.authVerification?.loginTimeoutMs,
    )
    const after = await this.verifyInRunAuth(grant, 'recovery', input.snapshot)
    const passed =
      submitted && after.authState === 'AUTHENTICATED' && after.identityState === 'MATCH'
    const liveAuth = await readLiveSessionAuth(this.dbHandle)
    await recordAutoLoginOutcome(this.dbHandle, {
      targetAccountId: input.snapshot.targetAccountId,
      result: passed ? 'success' : after.identityState === 'MISMATCH' ? 'credential' : 'verify_failed',
      sessionAuth: liveAuth.sessionAuth,
    })
    if (after.identityState === 'MISMATCH') {
      this.authGateClosed.add(grant.leaseId)
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    if (!passed) {
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    const rule =
      checkpoint?.recoveryRule ??
      deriveRecoveryRule({
        reuse: input.snapshot.sessionPolicy?.reuse,
        entryUrl: input.snapshot.targetAuth?.entryUrl,
        loginUrl: input.snapshot.targetAuth?.loginUrl,
        allowedOrigins: input.snapshot.allowedOrigins,
      })
    if (page && !(await this.applyRecoveryRule(page, rule))) {
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    this.authGateClosed.delete(grant.leaseId)
    return { ok: true }
  }

  async attachValidationOperation(input: {
    operation: { id: string; targetId: string; targetAccountId: string }
    grant: SessionGrant
    session: SessionRecord
  }): Promise<void> {
    const db = this.dbHandle
    const key = { targetId: input.operation.targetId, targetAccountId: input.operation.targetAccountId }
    this.bindOccupancy(input.grant, input.operation.id, this.options.defaultLeaseTtlSeconds)
    await runWithOccupancy(input.grant, async () => {
      let session = input.session
      if (!this.lives.has(session.id)) {
        const launched = await this.launchAndOpen(session, key)
        if (!launched.ok) {
          await this.abandonOccupancy(input.grant.leaseId, 'launch_failed')
          throw new SessionLeaseError(launched.code, launched.message)
        }
        session = launched.session
      }
      const live = this.lives.get(session.id)
      if (live) {
        this.ensureRunPage(live, input.operation.id, input.grant.leaseId)
        const target = await loadTargetForExecution(db, input.operation.targetId)
        const loginUrl = target?.loginUrl ?? target?.entryUrl
        if (loginUrl) {
          const page = this.ensureRunPage(live, input.operation.id, input.grant.leaseId).page
          await gotoPage(page, loginUrl).catch(() => undefined)
        }
      }
      const waitGrant = await transitionSessionUse(db, {
        sessionId: session.id,
        fromPurpose: 'MAINTENANCE',
        toPurpose: 'AUTH_WAIT',
        owner: { kind: 'SESSION_OPERATION', operationId: input.operation.id },
        holderWorkerId: this.options.workerId,
        holderInstanceId: this.workerInstanceId,
        leaseTtlSeconds: this.options.defaultLeaseTtlSeconds,
        waitSeconds: this.options.defaultAuthWaitSeconds,
        reason: 'validate_auth_profile',
      })
      if (waitGrant) {
        this.unbindOccupancy(input.grant.leaseId)
        this.bindOccupancy(waitGrant, input.operation.id, this.options.defaultLeaseTtlSeconds)
      }
      if (live) {
        live.autoInputClosed = true
        live.inputAccepting = false
      }
      await markSessionOperationWaitingForAuth(db, {
        operationId: input.operation.id,
        workerId: this.options.workerId,
      })
    })
  }

  async verifyOccupiedOwner(ownerId: string): Promise<AuthObservation> {
    const operation = await getSessionOperation(this.dbHandle, ownerId)
    if (!operation || (operation.kind !== 'VALIDATE_AUTH_PROFILE' && !isSessionMaintenanceKind(operation.kind))) {
      throw conflict('AUTH_VALIDATION_NOT_FOUND', '验收操作不存在')
    }
    const sessionId = this.liveSessionIdForOwner(ownerId)
    const live = sessionId ? this.lives.get(sessionId) : undefined
    const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
    if (!live || !session) throw conflict('SESSION_NOT_CLAIMABLE', '验收会话尚未就绪')
    const liveAuth = await readLiveSessionAuth(this.dbHandle)
    const target = await loadTargetForExecution(this.dbHandle, operation.targetId)
    if (isSessionMaintenanceKind(operation.kind)) {
      const verification = await freezeAuthVerificationForRun(this.dbHandle, {
        targetId: operation.targetId,
        targetAccountId: operation.targetAccountId,
        loginFields: target?.loginFields ?? null,
        platformRevision: liveAuth.revision,
        sessionAuth: liveAuth.sessionAuth,
      })
      if (!verification.profileRevision) throw conflict('AUTH_PROFILE_REQUIRED', '验收修订不存在')
      const profile = await loadAuthProfileRevision(this.dbHandle, operation.targetId, verification.profileRevision)
      if (!profile) throw conflict('AUTH_PROFILE_REQUIRED', '验收修订不存在')
      const result = await verifyAuthProfile(live.handle, { definition: profile.definition, verification })
      await this.persistProfileObservation(session, verification, result)
      return result.observation
    }
    const params = (operation.kindParams ?? {}) as { revision?: number }
    const revision = Number(params.revision)
    const profile = await loadAuthProfileRevision(this.dbHandle, operation.targetId, revision)
    if (!profile) throw conflict('AUTH_PROFILE_REQUIRED', '验收修订不存在')
    const account = await loadAccountForExecution(this.dbHandle, operation.targetAccountId)
    const result = await verifyAuthProfile(live.handle, {
      definition: profile.definition,
      verification: {
        profileRevision: profile.revision,
        profileDigest: profile.digest,
        loginFieldsDigest: profile.digest,
        expectedIdentity: account?.expectedIdentity ?? null,
        capability: 'LOGIN_VERIFIED',
        freshnessSeconds: liveAuth.sessionAuth.freshnessSecondsDefault,
        verifyTimeoutMs: liveAuth.sessionAuth.verifyTimeoutMs,
        loginTimeoutMs: liveAuth.sessionAuth.loginTimeoutMs,
        verifyRetryBackoffSeconds: [...liveAuth.sessionAuth.verifyRetryBackoffSeconds],
        platformConfigRevision: liveAuth.revision,
      },
    })
    return result.observation
  }

  async completeOccupiedAuth(
    ownerId: string,
    _input?: { actorId: string; token?: string },
  ): Promise<AuthObservation> {
    const observation = await this.verifyOccupiedOwner(ownerId)
    const operation = await getSessionOperation(this.dbHandle, ownerId)
    if (operation && isSessionMaintenanceKind(operation.kind) && observation.authState === 'AUTHENTICATED') {
      const sessionId = this.liveSessionIdForOwner(ownerId)
      const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
      await this.finishMaintenance(
        operation.id,
        { targetId: operation.targetId, targetAccountId: operation.targetAccountId },
        'SUCCEEDED',
        { type: 'auth.verified', sessionId: session?.id, generation: session?.generation },
      )
      const leaseId = [...this.leaseToRun.entries()].find(([, mapped]) => mapped === ownerId)?.[0]
      if (leaseId) await this.release(leaseId, 'auth_completed').catch(() => undefined)
      const live = sessionId ? this.lives.get(sessionId) : undefined
      if (live) {
        live.autoInputClosed = false
        live.inputAccepting = false
      }
    }
    return observation
  }

  async attachMaintenanceOperation(input: {
    operation: { id: string; kind: string; targetId: string; targetAccountId: string; kindParams?: Record<string, unknown> | null }
    grant: SessionGrant | null
    session: SessionRecord | null
    reusedRunId: string | null
  }): Promise<void> {
    const db = this.dbHandle
    const key = { targetId: input.operation.targetId, targetAccountId: input.operation.targetAccountId }
    if (input.reusedRunId) {
      await appendSessionEvent(db, {
        key,
        type: 'operation.claimed',
        operationId: input.operation.id,
        runId: input.reusedRunId,
        payload: { kind: input.operation.kind, reusedRunId: input.reusedRunId },
      })
      return
    }
    await appendSessionEvent(db, {
      key,
      type: 'operation.claimed',
      sessionId: input.session?.id ?? input.grant?.sessionId ?? null,
      generation: input.session?.generation ?? input.grant?.generation ?? null,
      operationId: input.operation.id,
      payload: { kind: input.operation.kind },
    })
    const attempt = { loginSubmitted: false }
    let occupiedGrant = input.grant
    try {
      if (input.operation.kind === 'CLOSE') {
        if (!input.session) throw conflict('SESSION_NOT_CLAIMABLE', '没有可关闭的会话')
        const closed = await this.close(input.session.id, 'operator_close')
        if (closed === 'unconfirmed') {
          await this.markSessionLost(input.session.id, 'operator_close')
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'SESSION_STOP_UNCONFIRMED')
          return
        }
        await this.finishMaintenance(input.operation.id, key, 'SUCCEEDED', {
          type: 'session.closed',
          sessionId: input.session.id,
          generation: input.session.generation,
        })
        return
      }
      if (input.operation.kind === 'RESET_PROFILE') {
        if (input.session && (input.session.status === 'OPEN' || input.session.status === 'CREATING')) {
          const closed = await this.close(input.session.id, 'reset_profile')
          if (closed === 'unconfirmed') {
            await this.markSessionLost(input.session.id, 'reset_profile')
            await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'SESSION_STOP_UNCONFIRMED')
            return
          }
        }
        await invalidateSessionProfile(db, key)
        const dir = profileDirFor(this.options.profileRoot, key)
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        await this.finishMaintenance(input.operation.id, key, 'SUCCEEDED', {
          type: 'profile.reset',
          sessionId: input.session?.id,
          generation: input.session?.generation,
        })
        return
      }
      if (input.operation.kind === 'RESTART') {
        if (!input.session) throw conflict('SESSION_NOT_CLAIMABLE', '没有可重启的会话')
        const predecessor = input.session
        const closed = await this.close(predecessor.id, 'operator_restart')
        if (closed === 'unconfirmed') {
          await this.markSessionLost(predecessor.id, 'operator_restart')
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'SESSION_STOP_UNCONFIRMED')
          return
        }
        const created = await createSession(db, {
          key,
          ownerWorkerId: this.options.workerId,
          ownerWorkerInstanceId: this.workerInstanceId,
          reusePolicy: predecessor.reusePolicy,
          idleTtlSeconds: predecessor.idleTtlSeconds,
          maxLifetimeSeconds: predecessor.maxLifetimeSeconds,
        })
        if (!created.ok) {
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, created.code)
          return
        }
        await adoptSessionRetention(db, { fromSessionId: predecessor.id, toSessionId: created.session.id })
        const launched = await runWithSessionRestart(created.session.id, () =>
          this.launchAndOpen(created.session, key),
        )
        if (!launched.ok) {
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, launched.code)
          return
        }
        await appendSessionEvent(db, {
          key,
          type: 'session.restarted',
          sessionId: launched.session.id,
          generation: launched.session.generation,
          operationId: input.operation.id,
          payload: { predecessorSessionId: predecessor.id },
        })
        const claimed = await claimSessionUse(db, {
          key,
          owner: { kind: 'SESSION_OPERATION', operationId: input.operation.id },
          purpose: 'MAINTENANCE',
          holderWorkerId: this.options.workerId,
          holderInstanceId: this.workerInstanceId,
          leaseTtlSeconds: this.options.defaultLeaseTtlSeconds,
          reusePolicy: launched.session.reusePolicy,
          idleTtlSeconds: launched.session.idleTtlSeconds,
          maxLifetimeSeconds: launched.session.maxLifetimeSeconds,
        })
        if (!claimed.ok) {
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'SESSION_NOT_CLAIMABLE')
          return
        }
        occupiedGrant = claimed.grant
        this.bindOccupancy(claimed.grant, input.operation.id, this.options.defaultLeaseTtlSeconds)
        const auth = await runWithOccupancy(claimed.grant, () =>
          this.runMaintenanceAuth(launched.session, input.operation, claimed.grant, 'verify', attempt),
        )
        if (auth === 'waiting') return
        await this.abandonOccupancy(claimed.grant.leaseId, auth.ok ? 'restart_verified' : 'restart_failed')
        await this.finishMaintenance(
          input.operation.id,
          key,
          auth.ok ? 'SUCCEEDED' : 'FAILED',
          {
            type: auth.ok ? 'auth.verified' : 'auth.unknown',
            sessionId: launched.session.id,
            generation: launched.session.generation,
          },
          auth.ok ? undefined : auth.code,
        )
        return
      }

      if (!input.grant || !input.session) {
        await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'SESSION_NOT_CLAIMABLE')
        return
      }
      this.bindOccupancy(input.grant, input.operation.id, this.options.defaultLeaseTtlSeconds)
      await runWithOccupancy(input.grant, async () => {
        let session = input.session!
        if (!this.lives.has(session.id)) {
          const launched = await this.launchAndOpen(session, key)
          if (!launched.ok) {
            await this.abandonOccupancy(input.grant!.leaseId, 'launch_failed')
            throw new SessionLeaseError(launched.code, launched.message)
          }
          session = launched.session
        }
        const live = this.lives.get(session.id)
        if (live) this.ensureRunPage(live, input.operation.id, input.grant!.leaseId)

        if (input.operation.kind === 'REFRESH_LOGIN_PAGE') {
          const target = await loadTargetForExecution(db, key.targetId)
          const loginUrl = target?.loginUrl ?? target?.entryUrl
          const page = live ? this.ensureRunPage(live, input.operation.id, input.grant!.leaseId).page : undefined
          const current = page && typeof page.url === 'function' ? page.url() : ''
          if (!loginUrl || !page || !this.isSafeLoginRefresh(current, loginUrl, target?.entryUrl ?? null)) {
            await this.abandonOccupancy(input.grant!.leaseId, 'refresh_unsafe')
            await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'PAGE_REFRESH_UNSAFE')
            return
          }
          await gotoPage(page, loginUrl).catch(() => undefined)
          await this.abandonOccupancy(input.grant!.leaseId, 'refresh_done')
          await this.finishMaintenance(input.operation.id, key, 'SUCCEEDED', {
            type: 'operation.finished',
            sessionId: session.id,
            generation: session.generation,
          })
          return
        }

        const mode =
          input.operation.kind === 'LOGIN' || input.operation.kind === 'PREPARE' || input.operation.kind === 'RENEW_AUTH'
            ? 'ensure'
            : 'verify'
        const auth = await this.runMaintenanceAuth(session, input.operation, input.grant, mode, attempt)
        if (auth === 'waiting') return
        await this.abandonOccupancy(input.grant!.leaseId, auth.ok ? 'maintenance_done' : 'maintenance_failed')
        if (auth.ok && session.retainUntil && session.retainUntil.getTime() > Date.now()) {
          await scheduleNextAuthCheck(db, session.id)
        }
        await this.finishMaintenance(
          input.operation.id,
          key,
          auth.ok ? 'SUCCEEDED' : 'FAILED',
          {
            type: auth.ok ? 'auth.verified' : 'auth.unknown',
            sessionId: session.id,
            generation: session.generation,
          },
          auth.ok ? undefined : auth.code,
        )
      })
    } catch (error) {
      const code = attempt.loginSubmitted
        ? 'OUTCOME_UNKNOWN'
        : error instanceof SessionLeaseError || error instanceof BrowserRuntimeError
          ? error.code
          : 'OPERATION_INTERRUPTED'
      if (attempt.loginSubmitted && input.session) {
        await this.markMaintenanceOutcomeUnknown(input.session, input.operation)
      }
      if (occupiedGrant) await this.abandonOccupancy(occupiedGrant.leaseId, code).catch(() => undefined)
      await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, code)
    }
  }

  private originAllowed(url: string, origins: string[]): boolean {
    try {
      const origin = new URL(url).origin.replace(/\/$/, '')
      return origins.some((item) => item.replace(/\/$/, '') === origin)
    } catch {
      return false
    }
  }

  private async markSessionLost(sessionId: string, reason: string): Promise<void> {
    const latest = await getSessionById(this.dbHandle, sessionId)
    if (!latest || latest.status === 'LOST' || latest.status === 'CLOSED') return
    await setSessionStatus(this.dbHandle, {
      sessionId,
      expectedVersion: latest.version,
      status: 'LOST',
      closeReason: reason,
      ...this.ownerScope(),
    }).catch(() => undefined)
  }

  private async markMaintenanceOutcomeUnknown(
    session: SessionRecord,
    operation: { targetId: string; targetAccountId: string },
  ): Promise<void> {
    await setSessionAuthSummary(this.dbHandle, {
      sessionId: session.id,
      ...this.ownerScope(),
      authState: 'UNKNOWN',
      identityState: 'UNVERIFIED',
      lastAuthError: 'OUTCOME_UNKNOWN',
      authProfileRevision: null,
      observedTier: null,
      recordSuccess: false,
    }).catch(() => undefined)
    const liveAuth = await readLiveSessionAuth(this.dbHandle).catch(() => null)
    if (liveAuth) {
      await recordAutoLoginOutcome(this.dbHandle, {
        targetAccountId: operation.targetAccountId,
        result: 'verify_failed',
        sessionAuth: liveAuth.sessionAuth,
      }).catch(() => undefined)
    }
  }

  isSafeLoginRefresh(currentUrl: string, loginUrl: string, entryUrl: string | null): boolean {
    try {
      const current = new URL(currentUrl)
      return [loginUrl, entryUrl].filter((value): value is string => Boolean(value)).some((value) => {
        const allowed = new URL(value)
        return (
          allowed.origin === current.origin &&
          allowed.pathname === current.pathname &&
          allowed.search === current.search
        )
      })
    } catch {
      return false
    }
  }

  async finishMaintenance(
    operationId: string,
    key: { targetId: string; targetAccountId: string },
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    event?: {
      type: SessionEventType
      sessionId?: string | null
      generation?: number | null
    },
    errorCode?: string,
  ): Promise<void> {
    await finishSessionOperation(this.dbHandle, {
      operationId,
      workerId: this.options.workerId,
      workerInstanceId: this.workerInstanceId,
      status,
      errorCode,
    })
    await appendSessionEvent(this.dbHandle, {
      key,
      type: event?.type ?? 'operation.finished',
      sessionId: event?.sessionId,
      generation: event?.generation,
      operationId,
      payload: { status, errorCode: errorCode ?? null },
    })
  }

  async runMaintenanceAuth(
    session: SessionRecord,
    operation: { id: string; kind: string; targetId: string; targetAccountId: string },
    grant: SessionGrant | null,
    mode: 'verify' | 'ensure',
    attempt?: { loginSubmitted: boolean },
  ): Promise<{ ok: true } | { ok: false; code?: SessionErrorCode } | 'waiting'> {
    const db = this.dbHandle
    const live = this.lives.get(session.id)
    if (!live) return { ok: false, code: 'SESSION_NOT_CLAIMABLE' }
    const liveAuth = await readLiveSessionAuth(db)
    const target = await loadTargetForExecution(db, operation.targetId)
    if (!target) return { ok: false, code: 'SESSION_TARGET_MISSING' }
    const verification = await freezeAuthVerificationForRun(db, {
      targetId: operation.targetId,
      targetAccountId: operation.targetAccountId,
      loginFields: target.loginFields,
      platformRevision: liveAuth.revision,
      sessionAuth: liveAuth.sessionAuth,
    })
    if (verification.capability === 'LEGACY' || !verification.profileRevision) {
      return { ok: false, code: 'AUTH_PROFILE_REQUIRED' }
    }
    const profile = await loadAuthProfileRevision(db, operation.targetId, verification.profileRevision)
    if (!profile) return { ok: false, code: 'AUTH_PROFILE_REQUIRED' }

    const verifyOnce = async () => {
      const verified = await verifyAuthProfile(live.handle, { definition: profile.definition, verification })
      await this.persistProfileObservation(session, verification, verified)
      return verified.observation
    }

    const observation = await verifyOnce()
    const passed =
      observation.authState === 'AUTHENTICATED' &&
      (verification.capability !== 'IDENTITY_VERIFIED' || observation.identityState === 'MATCH')

    if (operation.kind === 'RENEW_AUTH' && profile.definition.renew === 'verify_slides') {
      return passed ? { ok: true } : { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    }
    if (mode === 'verify') {
      return passed ? { ok: true } : { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    }
    const needsManual =
      target.authMethod === 'manual' ||
      target.captchaMode !== 'none' ||
      observation.authState === 'UNKNOWN' ||
      observation.identityState === 'MISMATCH'
    if (needsManual) {
      if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    } else if (passed) {
      return { ok: true }
    } else {
    const shouldLogin =
      operation.kind === 'LOGIN' ||
      operation.kind === 'PREPARE' ||
      (operation.kind === 'RENEW_AUTH' && profile.definition.renew === 'relogin')
    if (shouldLogin) {
      const credential = await this.resolveAccountCredential(operation.targetAccountId)
      if (!credential) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
      const occupied = await occupyAutoLoginBudget(db, {
        targetId: operation.targetId,
        targetAccountId: operation.targetAccountId,
      })
      if (occupied.ok) {
        if (attempt) attempt.loginSubmitted = true
        try {
          const submitted = await submitLoginCredentials(
            live.handle,
            {
              entryUrl: target.entryUrl,
              loginUrl: target.loginUrl,
              loginFields: target.loginFields,
            },
            credential,
            verification.loginTimeoutMs,
          )
          const after = await verifyOnce()
          const liveAfter = await readLiveSessionAuth(db)
          await recordAutoLoginOutcome(db, {
            targetAccountId: operation.targetAccountId,
            result:
              after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH'
                ? 'success'
                : after.identityState === 'MISMATCH'
                  ? 'credential'
                  : 'verify_failed',
            sessionAuth: liveAfter.sessionAuth,
          })
          if (submitted && after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH') return { ok: true }
        } catch {
          await this.markMaintenanceOutcomeUnknown(session, operation)
          return { ok: false, code: 'OUTCOME_UNKNOWN' }
        }
      }
    }
    }

    if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    const waitGrant = await transitionSessionUse(db, {
      sessionId: session.id,
      fromPurpose: 'MAINTENANCE',
      toPurpose: 'AUTH_WAIT',
      owner: { kind: 'SESSION_OPERATION', operationId: operation.id },
      holderWorkerId: this.options.workerId,
      holderInstanceId: this.workerInstanceId,
      leaseTtlSeconds: this.options.defaultLeaseTtlSeconds,
      waitSeconds: this.options.defaultAuthWaitSeconds,
      reason: 'maintenance_auth',
    })
    if (waitGrant) {
      this.unbindOccupancy(grant.leaseId)
      this.bindOccupancy(waitGrant, operation.id, this.options.defaultLeaseTtlSeconds)
    }
    live.autoInputClosed = true
    live.inputAccepting = false
    const loginUrl = target.loginUrl ?? target.entryUrl
    if (loginUrl) {
      const page = this.ensureRunPage(live, operation.id, waitGrant?.leaseId ?? grant.leaseId).page
      await gotoPage(page, loginUrl).catch(() => undefined)
    }
    await markSessionOperationWaitingForAuth(db, {
      operationId: operation.id,
      workerId: this.options.workerId,
    })
    await appendSessionEvent(db, {
      key: { targetId: operation.targetId, targetAccountId: operation.targetAccountId },
      type: 'operation.waiting_for_auth',
      sessionId: session.id,
      generation: session.generation,
      operationId: operation.id,
      payload: { kind: operation.kind },
    })
    return 'waiting'
  }

  async persistProfileObservation(
    session: SessionRecord,
    verification: FrozenAuthVerification,
    verified: Awaited<ReturnType<typeof verifyAuthProfile>>,
  ): Promise<void> {
    const observation = verified.observation
    const success =
      observation.authState === 'AUTHENTICATED' &&
      (verification.capability !== 'IDENTITY_VERIFIED' || observation.identityState === 'MATCH')
    await setSessionAuthSummary(this.dbHandle, {
      sessionId: session.id,
      ...this.ownerScope(),
      authState: observation.authState,
      identityState: observation.identityState,
      lastAuthError:
        observation.diagnosticCode === 'verified' ? null : (observation.diagnosticCode ?? observation.unknownClass),
      authProfileRevision: verification.profileRevision,
      observedTier: verification.capability,
      authValidUntil: verified.authValidUntil,
      authExpirySource: verified.authExpirySource,
      recordSuccess: success,
    })
    await setSessionProbe(this.dbHandle, {
      sessionId: session.id,
      ...this.ownerScope(),
      health: 'HEALTHY',
      authState: observation.authState,
    })
  }

  async resolveAccountCredential(
    accountId: string,
  ): Promise<{ username: string; password: string } | null> {
    const account = await loadAccountForExecution(this.dbHandle, accountId)
    if (!account?.secretId || !this.secrets) return null
    const row = await loadSecretCiphertext(this.dbHandle, account.secretId)
    if (!row) return null
    try {
      return { username: account.username ?? '', password: this.secrets.decrypt(row.id, row.ciphertext) }
    } catch {
      return null
    }
  }

  async renew(leaseId: string, leaseTtlSeconds?: number): Promise<'ok' | 'lost'> {
    const ttl =
      leaseTtlSeconds ?? this.leaseTtls.get(leaseId) ?? this.options.defaultLeaseTtlSeconds
    const row = await renewSessionUse(this.dbHandle, {
      leaseId,
      holderWorkerId: this.options.workerId,
      leaseTtlSeconds: ttl,
    })
    if (!row) {
      this.guard.revoke(leaseId)
      this.leaseTtls.delete(leaseId)
      this.logger.warn({ leaseId, workerId: this.options.workerId }, 'lease.renew_failed')
      return 'lost'
    }
    this.guard.refresh(occupancyGrantFromLease(row))
    return 'ok'
  }

  /**
   * 释放租约。行不存在 → SESSION_LEASE_UNKNOWN；已非 ACTIVE 视为幂等成功。
   */
  async release(leaseId: string, reason: string): Promise<void> {
    const sessionId = this.leaseToSession.get(leaseId)
    await this.stopTracingForLease(leaseId, sessionId)
    await this.closeRunPage(leaseId)
    const result = await releaseSessionUse(this.dbHandle, {
      leaseId,
      holderWorkerId: this.options.workerId,
      reason,
    })
    this.guard.revoke(leaseId)
    this.leaseToSession.delete(leaseId)
    this.leaseToRun.delete(leaseId)
    this.leaseTtls.delete(leaseId)
    if (result === 'unknown') {
      throw new SessionLeaseError('SESSION_LEASE_UNKNOWN', `租约不存在: ${leaseId}`)
    }
    this.logger.log(
      { leaseId, sessionId, reason, result, workerId: this.options.workerId },
      'lease.released',
    )
  }

  async close(sessionId: string, reason: string): Promise<'stopped' | 'unconfirmed'> {
    const db = this.dbHandle
    const session = await getSessionById(db, sessionId)
    if (!session) return 'unconfirmed'
    if (session.ownerWorkerId !== this.options.workerId) {
      return this.dropLocalHandle(sessionId)
    }
    if (!session.ownerWorkerInstanceId || session.ownerWorkerInstanceId !== this.workerInstanceId) {
      return this.dropLocalHandle(sessionId)
    }

    this.logger.log(
      { sessionId, generation: session.generation, reason, workerId: this.options.workerId },
      'session.closing',
    )
    await setSessionStatus(db, {
      sessionId,
      expectedVersion: session.version,
      status: 'CLOSING',
      closeReason: reason,
      ...this.ownerScope(),
    })

    const live = this.lives.get(sessionId)
    let stopResult: 'stopped' | 'unconfirmed' = 'stopped'
    if (live) {
      stopResult = await this.dropLocalHandle(sessionId)
    } else {
      // 无本进程句柄：无法确认浏览器是否仍在 → LOST（阻塞键）
      stopResult = 'unconfirmed'
    }

    const latest = await getSessionById(db, sessionId)
    if (!latest || latest.ownerWorkerInstanceId !== this.workerInstanceId) return stopResult
    if (stopResult === 'stopped') {
      await setSessionStatus(db, {
        sessionId,
        expectedVersion: latest.version,
        status: 'CLOSED',
        closeReason: reason,
        ...this.ownerScope(),
      })
      this.logger.log({ sessionId, reason, workerId: this.options.workerId }, 'session.closed')
    } else {
      await setSessionStatus(db, {
        sessionId,
        expectedVersion: latest.version,
        status: 'LOST',
        closeReason: reason,
        ...this.ownerScope(),
      })
      this.logger.warn({ sessionId, reason, workerId: this.options.workerId }, 'session.lost')
    }
    return stopResult
  }

  async reap(): Promise<{
    leasesExpired: number
    sessionsClosed: number
    authTimeouts: number
  }> {
    this.browserUnavailable = false
    const db = this.dbHandle
    const leasesExpired = await reapSessionLeases(db)
    if (leasesExpired > 0) {
      this.logger.log({ leasesExpired, workerId: this.options.workerId }, 'lease.expired')
    }

    const authTimeouts = await this.reapAuthTimeouts()

    // 控制面可能已处置掉本进程的卡死会话（例如 LOST 后人工放行）。句柄若还在，
    // 必须停掉浏览器——否则旧进程带着同一 profile 活着，正是处置要消除的双开风险。
    const disposedDropped = await this.dropDisposedHandles()

    const reapable = await listReapableSessions(db, this.options.workerId)
    if (reapable.length > 0) {
      await markSessionsClosing(db, {
        workerId: this.options.workerId,
        ownerWorkerInstanceId: this.workerInstanceId,
        sessionIds: reapable.map((s) => s.id),
        reason: 'idle_or_max_lifetime',
      })
    }
    const requestedClose = await listRequestedCloseSessions(db, this.options.workerId)

    let sessionsClosed = 0
    for (const session of reapable) {
      await this.close(session.id, 'idle_or_max_lifetime')
      sessionsClosed += 1
    }
    for (const session of requestedClose) {
      await this.close(session.id, session.closeReason ?? 'resource_deleted')
      sessionsClosed += 1
    }

    // 健康探针：对本进程活句柄探测，不刷新 last_used_at
    for (const [sessionId, live] of this.lives) {
      const health = await probeHealth(live.handle)
      await setSessionProbe(db, {
        sessionId,
        ...this.ownerScope(),
        health,
      })
      if (health === 'UNHEALTHY') {
        await this.close(sessionId, 'unhealthy')
        sessionsClosed += 1
      }
    }

    this.logger.log(
      { leasesExpired, sessionsClosed, authTimeouts, disposedDropped, workerId: this.options.workerId },
      'reap.cycle',
    )
    return { leasesExpired, sessionsClosed, authTimeouts }
  }

  /**
   * 丢弃已不由本进程拥有的会话句柄：行已 CLOSED、已消失，或 owner 换了人。
   *
   * 处置只改库，停不了浏览器；句柄在本进程时由这里收尾。租约映射一并清掉——
   * 处置已经把它们 REVOKED，留着只会让心跳反复判定丢租。
   */
  private async dropDisposedHandles(): Promise<number> {
    const db = this.dbHandle
    let dropped = 0
    for (const [sessionId, live] of [...this.lives]) {
      const row = await getSessionById(db, sessionId)
      const stillOurs =
        row !== null && row.status !== 'CLOSED' && row.ownerWorkerId === this.options.workerId
      if (stillOurs) continue

      for (const page of live.runPages.values()) await closePage(page)
      await stopSession(live.handle)
      this.lives.delete(sessionId)
      for (const [leaseId, mapped] of [...this.leaseToSession]) {
        if (mapped !== sessionId) continue
        this.guard.revoke(leaseId)
        this.leaseToSession.delete(leaseId)
      }
      dropped += 1
      this.logger.warn(
        { sessionId, status: row?.status ?? 'missing', workerId: this.options.workerId },
        'session.disposed_externally',
      )
    }
    return dropped
  }

  /**
   * 认证等待超时：清占用、会话仍 OPEN、auth_state=EXPIRED；
   * 绑定该账号的 WAITING_FOR_AUTH Run → SESSION_AUTH_TIMEOUT 失败。
   */
  async reapAuthTimeouts(): Promise<number> {
    const db = this.dbHandle
    let n = 0
    const expired = await listExpiredAuthHolds(db, this.options.workerId)
    for (const session of expired) {
      const boundRunId = session.authHoldRunId
      await expireAuthHold(db, { sessionId: session.id, workerId: this.options.workerId })
      if (boundRunId) {
        const failed = await failRunAuthTimeout(db, boundRunId)
        if (failed) {
          n += 1
          this.logger.log(
            {
              sessionId: session.id,
              runId: boundRunId,
              workerId: this.options.workerId,
            },
            'session.auth_timeout',
          )
        }
      }
      this.logger.log(
        { sessionId: session.id, authState: 'EXPIRED', workerId: this.options.workerId },
        'session.auth_changed',
      )
    }
    return n
  }

  /** 停机：释放名下租约并关闭浏览器。 */
  async shutdown(): Promise<void> {
    this.stopHeartbeat()
    for (const leaseId of [...this.leaseToSession.keys()]) {
      try {
        await this.release(leaseId, 'worker_shutdown')
      } catch {
        // 停机路径：未知租约也清本地
        this.guard.revoke(leaseId)
        this.leaseToSession.delete(leaseId)
      }
    }
    for (const sessionId of [...this.lives.keys()]) {
      await this.close(sessionId, 'worker_shutdown')
    }
    this.guard.clear()
  }

  assertCommand(leaseId: string): SessionGrant {
    return this.guard.assertHeld(leaseId)
  }

  /**
   * 受管调用范围：guard、Page 解析、Trace chunk、失败截图。
   * 确定性命令与 AI 共用，不得再复制一份。
   */
  async withManagedPage<T>(
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean = () => false,
  ): Promise<
    | { ok: true; value: T; screenshotBytes?: Buffer; tracePath?: string }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        tracePath?: string
      }
  > {
    try {
      this.guard.assertHeld(grant.leaseId, grant)
    } catch (error) {
      if (error instanceof GuardError) {
        return {
          ok: false,
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: error.message,
          },
        }
      }
      throw error
    }
    return this.withHeldOccupancy(grant.leaseId, grant, () =>
      this.runManagedPage(grant, evidence, fn, failed),
    )
  }

  private async runManagedPage<T>(
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean,
  ): Promise<
    | { ok: true; value: T; screenshotBytes?: Buffer; tracePath?: string }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        tracePath?: string
      }
  > {
    const live = this.lives.get(this.leaseToSession.get(grant.leaseId) ?? grant.sessionId)
    if (live?.autoInputClosed) {
      return {
        ok: false,
        error: {
          code: 'SESSION_LEASE_LOST',
          category: 'INFRASTRUCTURE',
          retryable: false,
          safeMessage: '运行正在等待认证，自动输入已关闭',
        },
      }
    }
    const page = this.pageForGrant(grant)
    if (!page) {
      return {
        ok: false,
        error: {
          code: 'SESSION_NOT_CLAIMABLE',
          category: 'INFRASTRUCTURE',
          retryable: true,
          safeMessage: '本进程没有该租约对应的页面',
        },
      }
    }
    const tracing = this.tracingByLease.get(grant.leaseId) === true
    const contextTracing = page.context().tracing
    const tracePath =
      tracing && evidence ? join(tmpdir(), `cairn-trace-${evidence.attemptId}.zip`) : undefined
    if (tracePath && evidence) {
      await contextTracing.startChunk({ title: evidence.attemptId })
    }
    try {
      assertPageTargetScope(page)
      const value = await fn(page)
      assertPageTargetScope(page)
      const wantShot = evidence
        ? shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', failed(value))
        : failed(value)
      const screenshotBytes = wantShot ? await screenshotPage(page).catch(() => undefined) : undefined
      return { ok: true, value, screenshotBytes, tracePath }
    } catch (error) {
      if (error instanceof TargetScopeError) return { ok: false, error: { code: error.code, category: 'VALIDATION', retryable: false, safeMessage: error.message } }
      if (error instanceof OccupancyRequiredError) {
        return {
          ok: false,
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: error.message,
          },
        }
      }
      const screenshotBytes = evidence
        ? await screenshotPage(page).catch(() => undefined)
        : undefined
      if (error instanceof GuardError) {
        return {
          ok: false,
          error: {
            code: 'SESSION_LEASE_LOST',
            category: 'INFRASTRUCTURE',
            retryable: false,
            safeMessage: error.message,
          },
          screenshotBytes,
          tracePath,
        }
      }
      throw error
    } finally {
      if (tracePath) {
        await contextTracing.stopChunk({ path: tracePath }).catch(() => undefined)
      }
    }
  }

  /**
   * 浏览器命令唯一入口：先过受管范围，再走 Surface。Playwright 不离开 runtime.ts。
   */
  async execute(
    grant: SessionGrant,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<BrowserCommandResult & { screenshotBytes?: Buffer; tracePath?: string }> {
    if (this.authGateClosed.has(grant.leaseId)) {
      return { ok: false, error: authGateClosedError('not_dispatched') }
    }
    const scoped = await this.withManagedPage(
      grant,
      evidence,
      (page) => this.runSurfaceCommand(grant, page, command, signal, evidence),
      (result) => !result.ok,
    )
    const authClosed = await this.observeInRunAuth(grant, 'dispatched', signal)
    if (authClosed) {
      return {
        ok: false,
        error: authClosed,
        screenshotBytes: scoped.ok ? scoped.screenshotBytes : scoped.screenshotBytes,
        tracePath: scoped.ok ? scoped.tracePath : scoped.tracePath,
      }
    }
    if (!scoped.ok) {
      return { ok: false, error: scoped.error, screenshotBytes: scoped.screenshotBytes, tracePath: scoped.tracePath }
    }
    return scoped.screenshotBytes || scoped.tracePath
      ? { ...scoped.value, screenshotBytes: scoped.screenshotBytes, tracePath: scoped.tracePath }
      : scoped.value
  }

  async invalidate(grant: SessionGrant, reason: string): Promise<void> {
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    await setSessionProbe(this.dbHandle, {
      sessionId,
      ...this.ownerScope(),
      health: 'UNHEALTHY',
    }).catch(() => undefined)
    await this.close(sessionId, reason).catch(() => undefined)
  }

  private async startTracingForLease(leaseId: string, sessionId: string, run: RunSnapshot): Promise<void> {
    const policy = resolveEvidencePolicy(run.evidencePolicy)
    if (policy.trace === 'off') {
      this.tracingByLease.set(leaseId, false)
      return
    }
    const live = this.lives.get(sessionId)
    if (!live) {
      this.tracingByLease.set(leaseId, false)
      return
    }
    const tracing = live.handle.context.tracing
    if (!tracing?.start) {
      this.tracingByLease.set(leaseId, false)
      return
    }
    await tracing.start({ screenshots: true, snapshots: true })
    this.tracingByLease.set(leaseId, true)
  }

  private async stopTracingForLease(leaseId: string, sessionId: string | undefined): Promise<void> {
    const enabled = this.tracingByLease.get(leaseId)
    this.tracingByLease.delete(leaseId)
    if (!enabled || !sessionId) return
    const live = this.lives.get(sessionId)
    if (!live) return
    await live.handle.context.tracing.stop().catch(() => undefined)
  }

  pageForGrant(grant: SessionGrant) {
    try {
      this.guard.assertHeld(grant.leaseId, grant)
    } catch {
      return undefined
    }
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    const live = this.lives.get(sessionId)
    if (!live) return undefined
    const runId = this.leaseToRun.get(grant.leaseId)
    const pageId =
      live.currentPageIdByLease.get(grant.leaseId) ?? (runId ? live.currentPageIdByRun.get(runId) : undefined)
    const current = pageId ? live.pages.get(pageId)?.page : undefined
    return current ?? live.runPages.get(grant.leaseId) ?? live.handle.basePage
  }

  private async runSurfaceCommand(
    grant: SessionGrant,
    page: import('playwright').Page,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<BrowserCommandResult> {
    if (command.type !== 'click' || command.pageAfter !== 'popup') {
      return executeOnPage(page, command, signal)
    }
    let clickResult: BrowserCommandResult = { ok: false, error: { code: 'PAGE_HANDOFF_NO_POPUP', category: 'EXECUTOR', retryable: false, safeMessage: '点击未完成' } }
    const popped = await waitForPopupsFrom(page, async () => {
      clickResult = await executeOnPage(page, { ...command, pageAfter: 'same' }, signal)
    })
    if (!clickResult.ok) return clickResult
    const sessionId = this.leaseToSession.get(grant.leaseId) ?? grant.sessionId
    const live = this.lives.get(sessionId)
    const runId = this.leaseToRun.get(grant.leaseId) ?? evidence?.runId
    if (!live || !runId) {
      return {
        ok: false,
        error: {
          code: 'PAGE_HANDOFF_NO_POPUP',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: '页面交接缺少会话上下文',
        },
      }
    }
    const urls = await Promise.all(
      popped.map(async (item) => ({
        page: item,
        url:
          item.url() ||
          (await item
            .waitForLoadState('domcontentloaded')
            .then(() => item.url())
            .catch(() => '')),
      })),
    )
    const decided = pickPopupHandoff(urls, live.allowedOrigins)
    if (!decided.ok) {
      return {
        ok: false,
        error: {
          code: decided.code,
          // 点击已经发出，交接结果未知：必须进核查，禁止当普通 EXECUTOR 失败重放点击。
          category: 'UNKNOWN',
          retryable: false,
          safeMessage: handoffMessage(decided.code),
        },
      }
    }
    const fromId = live.currentPageIdByLease.get(grant.leaseId) ?? live.currentPageIdByRun.get(runId)
    const entry = this.adoptPage(live, runId, decided.page, 'popup', grant.leaseId)
    await appendRunEvents(this.dbHandle, runId, [
      {
        type: 'run.page_handoff',
        payload: { fromPageId: fromId ?? null, toPageId: entry.pageId, reason: 'popup' },
        stepRunId: evidence?.stepRunId,
        attemptId: evidence?.attemptId,
      },
    ]).catch(() => undefined)
    await recordInlineLogEvidence(this.dbHandle, {
      runId,
      stepRunId: evidence?.stepRunId,
      attemptId: evidence?.attemptId,
      payload: { kind: 'page_handoff', fromPageId: fromId ?? null, toPageId: entry.pageId, reason: 'popup' },
    }).catch(() => undefined)
    return { ok: true, output: { pageAfter: 'popup', pageId: entry.pageId } }
  }

  private adoptPage(
    live: LiveHandle,
    runId: string,
    page: import('playwright').Page,
    kind: ManagedPageEntry['kind'],
    leaseId?: string,
  ): ManagedPageEntry {
    const entry = createManagedPage({ page, runId, kind })
    live.pages.set(entry.pageId, entry)
    live.currentPageIdByRun.set(runId, entry.pageId)
    if (leaseId) live.currentPageIdByLease.set(leaseId, entry.pageId)
    return entry
  }

  private ensureRunPage(live: LiveHandle, runId: string, leaseId?: string): ManagedPageEntry {
    const existingId = (leaseId ? live.currentPageIdByLease.get(leaseId) : undefined) ?? live.currentPageIdByRun.get(runId)
    const existing = existingId ? live.pages.get(existingId) : undefined
    if (existing && !existing.page.isClosed()) return existing
    const page = (leaseId ? live.runPages.get(leaseId) : undefined) ?? live.handle.basePage
    return this.adoptPage(live, runId, page, live.runPages.has(leaseId ?? '') ? 'run' : 'base', leaseId)
  }

  async describeRunBrowser(input: { runId: string; actorId: string; pageId?: string }): Promise<ManagedBrowserMeta> {
    return this.buildMeta(input.runId, input.actorId, input.pageId)
  }

  invalidateObserveGrant(runId: string): void {
    const current = this.observeGrants.get(runId)
    if (current) this.observeGrants.set(runId, { grant: { ...current.grant, epoch: current.grant.epoch + 1 }, expiresAt: 0 })
    this.observeGrants.delete(runId)
  }

  async describeHoldPage(runId: string): Promise<{
    pageRef?: PageRef
    url?: string
    authSignal?: AuthSignal
    authObservation?: AuthObservation
    contextRecoverable?: boolean
  } | undefined> {
    const sessionId = this.liveSessionIdForRun(runId)
    if (!sessionId) return undefined
    const live = this.lives.get(sessionId)
    const session = await getSessionById(this.dbHandle, sessionId)
    if (!live || !session) return undefined
    const entry = this.ensureRunPage(live, runId)
    if (entry.page.isClosed()) return undefined
    const url = entry.page.url()
    const leaseId = [...this.leaseToRun.entries()].find(([, mapped]) => mapped === runId)?.[0]
    const snapshot = leaseId ? this.runAuth.get(leaseId)?.snapshot : undefined
    const loginUrl = snapshot?.targetAuth?.loginUrl
    const onLogin = pageLooksLikeLogin({ pageUrl: url, loginUrl })
    const rule = snapshot
      ? deriveRecoveryRule({
          reuse: snapshot.sessionPolicy?.reuse,
          entryUrl: snapshot.targetAuth?.entryUrl,
          loginUrl: snapshot.targetAuth?.loginUrl,
          allowedOrigins: snapshot.allowedOrigins,
        })
      : undefined
    return {
      pageRef: pageRefFor(session.id, session.generation, entry),
      url: redactAuthUrl(url) ?? url,
      contextRecoverable: rule ? isContextRecoverable({ rule, pageUrl: url }) : false,
      ...(onLogin
        ? {
            authSignal: {
              kind: 'navigated_to_login' as const,
              at: new Date().toISOString(),
              summary: (redactAuthUrl(url) ?? url).slice(0, 512),
            },
            authObservation: this.expiredAuthObservation('导航到登录页', snapshot),
          }
        : {}),
    }
  }

  async observeRun(input: { runId: string; actorId: string; op: ObserveOperation }): Promise<TargetObservation> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (run.status === 'WAITING_FOR_AUTH') {
      throw conflict('AUTH_CONTROL_HELD', '登录等待时不能指认或校验，请先完成认证')
    }
    if (run.status !== 'HOLDING') {
      throw conflict('RUN_NOT_HOLDING', '只有调试挂起中的运行允许观察页面')
    }
    const detail = await loadRunDetail(this.dbHandle, input.runId)
    if (detail?.stepRuns.some((step) => step.attempts.some((attempt) => attempt.status === 'RUNNING'))) {
      throw conflict('WAITING_FOR_STABLE_HOLD', '在途业务动作尚未停稳，不能签发观察授权')
    }
    const entry = this.ensureRunPage(live, input.runId)
    const pageRef = pageRefFor(session.id, session.generation, entry)
    const now = Date.now()
    const resolved = resolveObserveGrant({
      op: input.op.op,
      existing: this.observeGrants.get(input.runId),
      now,
      pageRef,
      sessionGeneration: session.generation,
      runId: input.runId,
    })
    if (!resolved.ok) {
      throw conflict('OBSERVE_GRANT_EXPIRED', '观察授权已过期，请重新校验或再次点选指认')
    }
    this.observeGrants.set(input.runId, resolved.issued)
    const grantOnly = input.op.op === 'highlight' && !input.op.target && !input.op.clearOverlayStepId
    const url = entry.page.url()
    const title = await entry.page.title().catch(() => undefined)
    const observation = grantOnly
      ? {
          outcome: 'NOT_FOUND' as const,
          page: { url, title, pageRef },
          diagnostics: { outcome: 'NOT_FOUND' as const, candidatesTried: [] },
          source: 'managed' as const,
        }
      : input.op.op === 'pick'
        ? await pickOnPage(entry.page, input.op.x ?? 0, input.op.y ?? 0)
        : input.op.target
          ? await highlightOnPage(entry.page, input.op.target)
          : {
              outcome: 'NOT_FOUND' as const,
              page: { url, title, pageRef },
              diagnostics: { outcome: 'NOT_FOUND' as const, candidatesTried: [] },
              source: 'managed' as const,
            }
    const withPage = { ...observation, page: { ...observation.page, pageRef } }
    if (!grantOnly) {
      await appendRunEvents(this.dbHandle, input.runId, [
        {
          type: input.op.op === 'pick' ? 'observation.picked' : 'observation.highlighted',
          payload: { outcome: observation.outcome, source: observation.source },
        },
      ])
      const stepId = input.op.clearOverlayStepId ?? detail?.checkpoint?.stepId
      if (input.op.clearOverlayStepId && detail) {
        const next = { ...(detail.debugOverlay?.stepOverrides ?? {}) }
        delete next[input.op.clearOverlayStepId]
        await updateRunDebugOverlay(this.dbHandle, input.runId, {
          revision: (detail.debugOverlay?.revision ?? 0) + 1,
          stepOverrides: next,
        })
      } else if (input.op.applyOverlay && observation.target && stepId) {
        await updateRunDebugOverlay(this.dbHandle, input.runId, {
          revision: (detail?.debugOverlay?.revision ?? 0) + 1,
          stepOverrides: {
            ...(detail?.debugOverlay?.stepOverrides ?? {}),
            [stepId]: { target: observation.target },
          },
        })
      }
    }
    return withPage
  }

  async acquireRunAuthControl(input: {
    runId: string
    actor: { id: string }
    pageId?: string
  }): Promise<AcquireAuthControlResponse> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (!live.autoInputClosed || run.status !== 'WAITING_FOR_AUTH') {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '自动执行尚未停止，不能授予输入权')
    }
    const page = this.ensureRunPage(live, input.runId)
    const granted = await acquireAuthControl(this.dbHandle, {
      sessionId: session.id,
      runId: input.runId,
      actor: input.actor,
      workerId: this.options.workerId,
      workerInstanceId: this.workerInstanceId,
      sessionGeneration: session.generation,
      pageId: input.pageId ?? page.pageId,
    })
    live.receipts.clear()
    live.lastSeq = 0
    live.controlEpoch = granted.epoch
    live.inputAccepting = true
    const meta = await this.buildMeta(input.runId, input.actor.id, input.pageId ?? page.pageId)
    return {
      token: granted.token,
      epoch: granted.epoch,
      expiresAt: granted.expiresAt.toISOString(),
      pageRef: pageRefFor(session.id, session.generation, page),
      meta,
    }
  }

  async heartbeatRunAuthControl(input: {
    runId: string
    actorId: string
    token: string
    pageId?: string
  }): Promise<{ expiresAt: string; epoch: number }> {
    const { live } = await this.requireLiveAuthSession(input.runId)
    const beat = await heartbeatAuthControl(this.dbHandle, {
      sessionId: live.sessionId,
      runId: input.runId,
      actorId: input.actorId,
      token: input.token,
      workerInstanceId: this.workerInstanceId,
    })
    return { expiresAt: beat.expiresAt.toISOString(), epoch: beat.epoch }
  }

  async inputRunAuthControl(input: {
    runId: string
    actorId: string
    token: string
    command: BrowserAuthInputCommand
  }): Promise<AuthControlInputReceipt> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (!live.inputAccepting || run.status !== 'WAITING_FOR_AUTH' || !live.autoInputClosed) {
      throw conflict('AUTH_INPUT_REJECTED', '当前不是认证输入窗口')
    }
    await heartbeatAuthControl(this.dbHandle, {
      sessionId: session.id,
      runId: input.runId,
      actorId: input.actorId,
      token: input.token,
      workerInstanceId: this.workerInstanceId,
    })
    const boundEpoch = session.authControlEpoch
    const boundGeneration = session.generation
    return enqueueSerial(live, async () => this.executeAuthInput({
      sessionId: session.id,
      live,
      boundEpoch,
      boundGeneration,
      input,
    }))
  }

  private async executeAuthInput(params: {
    sessionId: string
    live: LiveHandle
    boundEpoch: number
    boundGeneration: number
    input: {
      runId: string
      actorId: string
      token: string
      command: BrowserAuthInputCommand
    }
  }): Promise<AuthControlInputReceipt> {
    const { sessionId, live, boundEpoch, boundGeneration, input } = params
    const known = live.receipts.get(input.command.commandId)
    if (known) return { ...known, status: 'duplicate' }
    if (input.command.seq <= live.lastSeq) {
      throw conflict('AUTH_INPUT_REJECTED', '输入序号乱序')
    }
    const { run: latestRun } = await this.lookupRunSession(input.runId)
    if (latestRun.status !== 'WAITING_FOR_AUTH' || !live.autoInputClosed) {
      throw conflict('AUTH_INPUT_REJECTED', '当前不是认证输入窗口')
    }
    const latest = await getSessionById(this.dbHandle, sessionId)
    if (!latest?.authControlExpiresAt || latest.authControlExpiresAt.getTime() <= Date.now()) {
      throw conflict('AUTH_CONTROL_INVALID', '认证输入权已过期')
    }
    if (latest.authControlActorId !== input.actorId) {
      throw conflict('AUTH_CONTROL_HELD', '由其他用户处理登录')
    }
    if (latest.authControlEpoch !== boundEpoch) {
      throw conflict('AUTH_CONTROL_INVALID', '认证输入权已更换')
    }
    if (!latest.authControlTokenHash || latest.authControlTokenHash !== hashAuthControlToken(input.token)) {
      throw conflict('AUTH_CONTROL_INVALID', '认证输入权已更换')
    }
    const entry = live.pages.get(input.command.pageRef.pageId)
    if (!entry || entry.page.isClosed()) throw conflict('PAGE_STALE', '页面已关闭或已失效')
    if (
      input.command.pageRef.sessionId !== latest.id ||
      input.command.pageRef.sessionGeneration !== boundGeneration ||
      input.command.pageRef.sessionGeneration !== latest.generation ||
      input.command.pageRef.documentEpoch !== entry.documentEpoch
    ) {
      throw conflict('PAGE_STALE', '页面代次已变化，请刷新画面')
    }
    if (!viewportMatches(entry.page.viewportSize(), input.command.viewport)) {
      throw conflict('PAGE_STALE', '视口已变化，请刷新画面')
    }
    if (input.command.type === 'mouse_click' || input.command.type === 'mouse_wheel') {
      const cast = live.screencasts.get(entry.pageId)
      if (cast) {
        await refreshScreencastIfStale(
          entry.page,
          cast,
          pageRefFor(latest.id, latest.generation, entry),
          2_000,
        )
      }
      const latestFrame = live.screencasts.get(entry.pageId)?.latest
      if (latestFrame) {
        const age = Date.now() - Date.parse(latestFrame.capturedAt)
        if (!Number.isFinite(age) || age > 5_000) {
          throw conflict('PAGE_STALE', '画面已过期，请按当前帧操作')
        }
      }
    }
    const pageUrl = typeof entry.page.url === 'function' ? entry.page.url() : ''
    if (live.allowedOrigins.length > 0 && pageUrl && !originAllowed(pageUrl, live.allowedOrigins)) {
      throw conflict('AUTH_INPUT_REJECTED', '当前页超出目标系统允许范围')
    }
    this.assertSessionOwnedHere(latest)
    await this.assertOwnLiveRegistration()
    await applyAuthInput(entry.page, input.command)
    live.lastSeq = input.command.seq
    return rememberReceipt(live.receipts, {
      commandId: input.command.commandId,
      seq: input.command.seq,
      status: 'accepted',
    })
  }

  async releaseRunAuthControl(input: {
    runId: string
    actor: { id: string }
    token: string
  }): Promise<boolean> {
    const { session, live } = await this.requireLiveAuthSession(input.runId)
    const released = await releaseAuthControl(this.dbHandle, {
      sessionId: session.id,
      runId: input.runId,
      actor: input.actor,
      token: input.token,
    })
    if (released) live.inputAccepting = false
    return released
  }

  async resumeRunAuth(input: {
    runId: string
    actor: { id: string }
    token?: string
    note?: string
  }): Promise<void> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (run.status !== 'WAITING_FOR_AUTH') {
      throw conflict('RUN_NOT_WAITING_FOR_AUTH', '只有等待认证的运行可以恢复领取')
    }
    live.inputAccepting = false
    try {
      await enqueueSerial(live, async () => {
        const latestSession = (await getSessionById(this.dbHandle, session.id)) ?? session
        const target = await this.loadTargetAuth(run.snapshot)
        if (!target) throw conflict('SESSION_TARGET_MISSING', '目标系统不存在')
        const page = this.ensureRunPage(live, input.runId).page
        const waitLease = await findAuthWaitLeaseForRun(this.dbHandle, input.runId)
        if (!waitLease) throw conflict('AUTH_HOLD_UNBOUND', '缺少认证等待租约')
        const checkpoint = run.authCheckpoint
        const inRunManual = checkpoint?.status === 'recovering' && checkpoint.recoveryKind === 'manual'
        const withWait = <T>(fn: () => Promise<T>) => runWithOccupancy(occupancyGrantFromLease(waitLease), fn)
        if (inRunManual && run.snapshot.authVerification?.capability === 'IDENTITY_VERIFIED') {
          const verification = run.snapshot.authVerification
          const profile = verification.profileRevision
            ? await loadAuthProfileRevision(this.dbHandle, run.snapshot.targetId, verification.profileRevision)
            : null
          if (!profile) throw conflict('AUTH_NOT_VERIFIED', '目标系统仍未登录')
          const observation = await withWait(() =>
            verifyAuthProfile(live.handle, { definition: profile.definition, verification }),
          )
          if (
            observation.observation.authState !== 'AUTHENTICATED' ||
            observation.observation.identityState !== 'MATCH'
          ) {
            if (observation.observation.identityState === 'MISMATCH') {
              await this.failInRunAuthRecovery(input.runId, latestSession, checkpoint, 'AUTH_CONTEXT_NOT_RECOVERABLE')
              throw conflict('AUTH_CONTEXT_NOT_RECOVERABLE', '登录已恢复，当前运行无法安全续跑')
            }
            throw conflict('AUTH_NOT_VERIFIED', '目标系统仍未登录')
          }
          if (!(await withWait(() => this.applyRecoveryRule(page, checkpoint.recoveryRule)))) {
            await this.failInRunAuthRecovery(input.runId, latestSession, checkpoint, 'AUTH_CONTEXT_NOT_RECOVERABLE')
            throw conflict('AUTH_CONTEXT_NOT_RECOVERABLE', '登录已恢复，当前运行无法安全续跑')
          }
          if ((await computeContextVersion(run.context)) !== checkpoint.contextVersion) {
            await this.failInRunAuthRecovery(input.runId, latestSession, checkpoint, 'AUTH_CONTEXT_NOT_RECOVERABLE')
            throw conflict('AUTH_CONTEXT_NOT_RECOVERABLE', '登录已恢复，当前运行无法安全续跑')
          }
        } else {
          const auth = await withWait(() => probeAuthOnPage(page, target))
          if (auth !== 'AUTHENTICATED') {
            throw conflict('AUTH_NOT_VERIFIED', '目标系统仍未登录')
          }
        }
        await resumeRunAfterAuth(this.dbHandle, {
          runId: input.runId,
          actor: input.actor,
          note: input.note,
          token: input.token,
          sessionId: latestSession.id,
          workerId: this.options.workerId,
          workerInstanceId: this.workerInstanceId,
          controlEpoch: latestSession.authControlEpoch,
          recoveredAuthCheckpoint: inRunManual && checkpoint ? { ...checkpoint, status: 'recovered' } : undefined,
        })
        live.autoInputClosed = false
        live.inputAccepting = false
      })
    } catch (error) {
      const latest = await getRun(this.dbHandle, input.runId).catch(() => run)
      if (latest.status === 'WAITING_FOR_AUTH' && live.autoInputClosed) {
        live.inputAccepting = true
      }
      throw error
    }
  }

  private async failInRunAuthRecovery(
    runId: string,
    session: SessionRecord,
    checkpoint: AuthCheckpoint,
    code: 'AUTH_CONTEXT_NOT_RECOVERABLE' | 'AUTH_RECOVERY_LIMIT',
  ): Promise<void> {
    const next = { ...checkpoint, status: 'unrecoverable' as const, unrecoverableCode: code }
    await writeRunAuthCheckpoint(this.dbHandle, { runId, recover: true, checkpoint: next }).catch(() => false)
    await failRunValidation(
      this.dbHandle,
      runId,
      { recover: true },
      {
        code,
        category: 'VALIDATION',
        retryable: false,
        safeMessage: '登录已恢复，当前运行无法安全续跑',
      },
    ).catch(() => undefined)
    await transitionSessionUse(this.dbHandle, {
      sessionId: session.id,
      fromPurpose: 'AUTH_WAIT',
      toPurpose: 'RELEASE',
      owner: { kind: 'RUN', runId, runFencingToken: 1 },
      holderWorkerId: this.options.workerId,
      holderInstanceId: this.workerInstanceId,
      leaseTtlSeconds: 30,
      reason: 'auth_unrecoverable',
    }).catch(() => undefined)
  }

  subscribeRunFrames(input: {
    runId: string
    actorId: string
    pageId?: string
    onFrame: (frame: ManagedBrowserFrame) => void
    signal: AbortSignal
  }): Promise<void> {
    return this.pipeFrames(input)
  }

  private async pipeFrames(input: {
    runId: string
    actorId: string
    pageId?: string
    onFrame: (frame: ManagedBrowserFrame) => void
    signal: AbortSignal
  }): Promise<void> {
    const { session, live, run } = await this.requireLiveAuthSession(input.runId)
    if (
      !canObserveManagedFrames({
        runStatus: run.status,
        actorId: input.actorId,
        controlActorId: session.authControlActorId,
        controlExpiresAt: session.authControlExpiresAt,
      })
    ) {
      throw conflict('AUTH_CONTROL_INVALID', '认证阶段仅当前控制者可看画面')
    }
    const entry = this.pageForView(live, input.runId, input.pageId)
    if (!entry) throw conflict('PAGE_STALE', '没有可观察的页面')
    const pageRef = pageRefFor(session.id, session.generation, entry)
    let cast = live.screencasts.get(entry.pageId)
    if (!cast) {
      cast = await startScreencast(entry.page, pageRef)
      live.screencasts.set(entry.pageId, cast)
    }
    live.screencastObservers.set(entry.pageId, (live.screencastObservers.get(entry.pageId) ?? 0) + 1)
    if (cast) await refreshScreencastIfStale(entry.page, cast, pageRef)
    const interval = Math.max(500, Math.floor(1000 / BROWSER_FRAME_MAX_FPS))
    try {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let ticking = false
        let closed = false
        const finish = () => {
          if (closed) return
          closed = true
          if (timer) clearTimeout(timer)
          timer = undefined
          input.signal.removeEventListener('abort', finish)
          resolve()
        }
        const tick = () => {
          if (closed || input.signal.aborted) {
            finish()
            return
          }
          if (ticking) {
            timer = setTimeout(tick, interval)
            return
          }
          ticking = true
          void Promise.all([
            getRun(this.dbHandle, input.runId),
            getSessionById(this.dbHandle, session.id),
            getWorkerById(this.dbHandle, this.options.workerId),
          ])
            .then(async ([latestRun, latestSession, worker]) => {
              if (closed || input.signal.aborted) return
              if (
                !latestSession ||
                latestSession.generation !== session.generation ||
                !this.sessionOwnedHere(latestSession) ||
                !this.registrationLive(worker)
              ) {
                finish()
                return
              }
              if (
                !canObserveManagedFrames({
                  runStatus: latestRun.status,
                  actorId: input.actorId,
                  controlActorId: latestSession.authControlActorId,
                  controlExpiresAt: latestSession.authControlExpiresAt,
                })
              ) {
                finish()
                return
              }
              if (cast) {
                await refreshScreencastIfStale(entry.page, cast, pageRef)
              }
              if (closed || input.signal.aborted) return
              if (cast?.latest) input.onFrame(cast.latest)
              if (closed || input.signal.aborted) return
              timer = setTimeout(tick, interval)
            })
            .catch(() => finish())
            .finally(() => {
              ticking = false
            })
        }
        if (cast?.latest && !input.signal.aborted) input.onFrame(cast.latest)
        timer = setTimeout(tick, interval)
        input.signal.addEventListener('abort', finish, { once: true })
        if (input.signal.aborted) finish()
      })
    } finally {
      await this.dropScreencastObserver(live, entry.pageId)
    }
  }

  countScreencastObservers(sessionId: string): number {
    const live = this.lives.get(sessionId)
    if (!live) return 0
    let total = 0
    for (const count of live.screencastObservers.values()) total += count
    return total
  }

  private async dropScreencastObserver(live: LiveHandle, pageId: string): Promise<void> {
    const current = live.screencastObservers.get(pageId) ?? 0
    if (current <= 1) {
      live.screencastObservers.delete(pageId)
      const cast = live.screencasts.get(pageId)
      live.screencasts.delete(pageId)
      await cast?.stop().catch(() => undefined)
      return
    }
    live.screencastObservers.set(pageId, current - 1)
  }

  private pageForView(live: LiveHandle, runId: string, pageId?: string): ManagedPageEntry | undefined {
    if (pageId) {
      const chosen = live.pages.get(pageId)
      if (chosen && chosen.runId === runId && !chosen.page.isClosed()) {
        const url = typeof chosen.page.url === 'function' ? chosen.page.url() : ''
        if (!url || live.allowedOrigins.length === 0 || originAllowed(url, live.allowedOrigins)) {
          return chosen
        }
      }
    }
    return this.ensureRunPage(live, runId)
  }

  private async requireLiveAuthSession(runId: string): Promise<{
    session: SessionRecord
    live: LiveHandle
    run: Awaited<ReturnType<typeof getRun>>
  }> {
    const { run, session, live } = await this.lookupRunSession(runId)
    if (!session) throw conflict('WORKER_UNREACHABLE', '运行没有可观察的受管会话')
    this.assertSessionOwnedHere(session)
    if (!live) throw conflict('WORKER_UNREACHABLE', '本进程没有会话句柄')
    await expireStaleAuthControl(this.dbHandle, session.id, runId).catch(() => undefined)
    await this.assertOwnLiveRegistration()
    const latest = (await getSessionById(this.dbHandle, session.id)) ?? session
    this.assertSessionOwnedHere(latest)
    return { session: latest, live, run }
  }

  private liveAuthHold(session: SessionRecord | null): SessionRecord | null {
    if (!session?.authHoldExpiresAt || session.authHoldExpiresAt.getTime() <= Date.now()) return null
    return session
  }

  private sessionOwnedHere(session: SessionRecord): boolean {
    return (
      session.ownerWorkerId === this.options.workerId &&
      Boolean(session.ownerWorkerInstanceId) &&
      session.ownerWorkerInstanceId === this.workerInstanceId &&
      (!session.authHoldWorkerInstanceId || session.authHoldWorkerInstanceId === this.workerInstanceId)
    )
  }

  private assertSessionOwnedHere(session: SessionRecord): void {
    if (session.ownerWorkerId !== this.options.workerId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker')
    }
    if (!session.ownerWorkerInstanceId || session.ownerWorkerInstanceId !== this.workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', '会话不属于当前 Worker 实例')
    }
    if (session.authHoldWorkerInstanceId && session.authHoldWorkerInstanceId !== this.workerInstanceId) {
      throw conflict('WORKER_GENERATION_MISMATCH', 'Worker 进程代次已变化')
    }
  }

  private registrationLive(worker: Awaited<ReturnType<typeof getWorkerById>>): boolean {
    return Boolean(
      worker &&
        worker.instanceId === this.workerInstanceId &&
        worker.status === 'READY' &&
        worker.heartbeatExpiresAt &&
        worker.heartbeatExpiresAt.getTime() > Date.now(),
    )
  }

  private async assertOwnLiveRegistration(): Promise<void> {
    const worker = await getWorkerById(this.dbHandle, this.options.workerId)
    if (!this.registrationLive(worker)) {
      throw conflict('WORKER_GENERATION_MISMATCH', '当前登记已失效')
    }
  }

  private liveSessionIdForRun(runId: string): string | undefined {
    for (const [leaseId, mappedRun] of this.leaseToRun) {
      if (mappedRun !== runId) continue
      const sessionId = this.leaseToSession.get(leaseId)
      if (sessionId && this.lives.has(sessionId)) return sessionId
    }
    for (const [sessionId, live] of this.lives) {
      if (live.currentPageIdByRun.has(runId)) return sessionId
      for (const entry of live.pages.values()) {
        if (entry.runId === runId && !entry.page.isClosed()) return sessionId
      }
    }
    return undefined
  }

  private async lookupRunSession(runId: string): Promise<{
    run: Awaited<ReturnType<typeof getRun>>
    session: SessionRecord | null
    live: LiveHandle | undefined
  }> {
    const operation = await getSessionOperation(this.dbHandle, runId)
    if (operation) {
      if (typeof operation.kindParams?.reusedRunId === 'string') {
        return this.lookupRunSession(operation.kindParams.reusedRunId)
      }
      const liveId = this.liveSessionIdForRun(runId)
      const lease =
        (await findAuthWaitLeaseForOperation(this.dbHandle, runId)) ??
        (liveId ? await findActiveLeaseRow(this.dbHandle, liveId) : null)
      const sessionId = lease?.sessionId ?? liveId ?? operation.expectedSessionId
      const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
      const live = session ? this.lives.get(session.id) : undefined
      return {
        run: {
          id: operation.id,
          status: operation.status === 'WAITING_FOR_AUTH' ? 'WAITING_FOR_AUTH' : operation.status,
          placement: { sessionId: session?.id ?? null },
        } as Awaited<ReturnType<typeof getRun>>,
        session,
        live,
      }
    }
    const instance = await getSessionById(this.dbHandle, runId)
    if (instance) {
      const lease = await findActiveLeaseRow(this.dbHandle, instance.id)
      const ownerId = lease?.runId ?? lease?.operationId
      if (ownerId) return this.lookupRunSession(ownerId)
      return {
        run: {
          id: instance.id,
          status: instance.status === 'OPEN' ? 'RUNNING' : 'FAILED',
          placement: { sessionId: instance.id },
        } as Awaited<ReturnType<typeof getRun>>,
        session: instance,
        live: this.lives.get(instance.id),
      }
    }
    const run = await getRun(this.dbHandle, runId)
    const held = this.liveAuthHold(await findSessionByAuthHoldRun(this.dbHandle, runId))
    const sessionId = held?.id ?? run.placement.sessionId ?? this.liveSessionIdForRun(runId)
    const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
    const live = session ? this.lives.get(session.id) : undefined
    return { run, session, live }
  }

  private async buildMeta(runId: string, actorId: string, viewPageId?: string): Promise<ManagedBrowserMeta> {
    const { run, session, live } = await this.lookupRunSession(runId)
    const liveOk = Boolean(live && session && this.sessionOwnedHere(session))
    const waiting = run.status === 'WAITING_FOR_AUTH'
    const controlLive =
      Boolean(
        session?.authControlActorId &&
          session.authControlExpiresAt &&
          session.authControlExpiresAt.getTime() > Date.now(),
      )
    const heldByViewer = session?.authControlActorId === actorId && controlLive
    const capabilities: ManagedBrowserCapabilities = { ...DEFAULT_MANAGED_BROWSER_CAPABILITIES }
    const framesAvailable = liveOk && (!waiting || heldByViewer) && capabilities.screencast !== 'closed'
    const current = live && liveOk ? this.ensureRunPage(live, runId) : undefined
    const pages: ManagedPageSummary[] =
      live && liveOk && session
        ? [...live.pages.values()]
            .filter((entry) => entry.runId === runId && !entry.page.isClosed())
            .slice(0, 16)
            .map((entry) => ({
              pageRef: pageRefFor(session.id, session.generation, entry),
              kind: entry.kind,
              viewing: viewPageId ? entry.pageId === viewPageId : entry.pageId === current?.pageId,
              currentExecution: entry.pageId === current?.pageId,
            }))
        : []
    return {
      runId,
      runStatus: run.status,
      sessionId: session?.id ?? null,
      sessionGeneration: session?.generation ?? null,
      ownerWorkerId: session?.ownerWorkerId ?? null,
      framesAvailable,
      viewingOtherPage: Boolean(viewPageId && current && viewPageId !== current.pageId),
      currentPage: current && session ? (pages.find((item) => item.currentExecution) ?? null) : null,
      pages,
      authHold:
        session && isBoundAuthHold(session) && session.authHoldExpiresAt
          ? {
              expiresAt: session.authHoldExpiresAt.toISOString(),
              bound: true,
              runId: session.authHoldRunId,
            }
          : session?.authHoldExpiresAt
            ? {
                expiresAt: session.authHoldExpiresAt.toISOString(),
                bound: false,
                runId: session.authHoldRunId,
              }
            : null,
      authControl: session
        ? {
            epoch: session.authControlEpoch,
            actorId: session.authControlActorId,
            expiresAt: session.authControlExpiresAt?.toISOString() ?? null,
            heldByViewer,
          }
        : null,
      capabilities,
      degradedReason: liveOk
        ? null
        : session && !this.sessionOwnedHere(session)
          ? 'worker_generation_mismatch'
          : session
            ? 'worker_unreachable'
            : null,
    }
  }

  pageCount(sessionId: string): number {
    const live = this.lives.get(sessionId)
    return live ? countPages(live.handle) : 0
  }

  /** 测试钩子：覆盖默认 SecretProvider 解密。 */
  resolveCredential?: (run: RunSnapshot) => Promise<{ username: string; password: string } | null>

  private platformDefaultPolicy(): SessionPolicy {
    return {
      ...DEFAULT_SESSION_POLICY,
      leaseTtlSeconds: this.options.defaultLeaseTtlSeconds,
    }
  }

  private async renewAll(): Promise<void> {
    for (const leaseId of [...this.leaseToSession.keys()]) {
      const result = await this.renew(leaseId)
      if (result === 'lost') {
        await this.closeRunPage(leaseId)
        this.leaseToSession.delete(leaseId)
        this.leaseToRun.delete(leaseId)
        this.leaseTtls.delete(leaseId)
      }
    }
  }

  private async launchAndOpen(
    created: SessionRecord,
    key: { targetId: string; targetAccountId: string },
  ): Promise<
    | { ok: true; session: SessionRecord }
    | { ok: false; code: SessionErrorCode; message: string }
  > {
    const db = this.dbHandle
    const { profileDir } = ensureProfileDir(this.options.profileRoot, key)
    const launch = this.launchOverride ?? launchSession
    try {
      const handle = await launch(profileDir, {
        headless: this.options.headless,
        executablePath: this.options.executablePath,
      })
      this.lives.set(created.id, emptyLive(handle, created.id))
      const health = await probeHealth(handle)
      await setSessionProbe(db, {
        sessionId: created.id,
        ...this.ownerScope(),
        health,
      })
      const opened = await setSessionStatus(db, {
        sessionId: created.id,
        expectedVersion: created.version,
        status: 'OPEN',
        ...this.ownerScope(),
      })
      if (!opened) {
        await stopSession(handle)
        this.lives.delete(created.id)
        return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '无法将会话置为 OPEN' }
      }
      const session = (await getSessionById(db, created.id))!
      return { ok: true, session }
    } catch (error) {
      if (error instanceof OccupancyRequiredError) {
        await setSessionStatus(db, {
          sessionId: created.id,
          expectedVersion: created.version,
          status: 'CLOSED',
          closeReason: 'launch_failed',
          ...this.ownerScope(),
        }).catch(() => {})
        return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: error.message }
      }
      if (error instanceof BrowserRuntimeError && error.code === 'PROFILE_LOCKED') {
        await setSessionStatus(db, {
          sessionId: created.id,
          expectedVersion: created.version,
          status: 'LOST',
          closeReason: 'profile_locked',
          ...this.ownerScope(),
        }).catch(() => {})
        return { ok: false, code: error.code, message: error.message }
      }
      await setSessionStatus(db, {
        sessionId: created.id,
        expectedVersion: created.version,
        status: 'CLOSED',
        closeReason: 'launch_failed',
        ...this.ownerScope(),
      }).catch(() => {})
      if (error instanceof BrowserRuntimeError) {
        this.markBrowserUnavailable(error.code)
        return { ok: false, code: error.code, message: error.message }
      }
      throw error
    }
  }

  private async waitInterruptible(ms: number, runId: string, signal?: AbortSignal): Promise<void> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      signal?.throwIfAborted()
      const run = await getRun(this.dbHandle, runId)
      if (run?.cancelRequested) {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, end - Date.now()))))
    }
  }

  private async ensureProfileAuth(
    session: SessionRecord,
    run: RunSnapshot,
    runGrant: RunGrant,
    policy: SessionPolicy,
    occupancy: SessionGrant,
    verification: FrozenAuthVerification,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; session: SessionRecord }
    | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }
  > {
    const db = this.dbHandle
    const live = this.lives.get(session.id)
    if (!live) return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '无浏览器句柄' }
    if (!run.targetAccountId) return { ok: false, code: 'SESSION_ACCOUNT_REQUIRED', message: '运行未指定目标账号' }
    const liveConfig = await assertLiveAuthConfiguration(db, {
      targetId: run.targetId,
      targetAccountId: run.targetAccountId,
    })
    if (!liveConfig.ok) return { ok: false, code: liveConfig.code, message: liveConfig.message }
    if (!verification.profileRevision) {
      return { ok: false, code: 'AUTH_PROFILE_REQUIRED', message: '冻结规则缺少修订' }
    }
    const profile = await loadAuthProfileRevision(db, run.targetId, verification.profileRevision)
    if (!profile || profile.digest !== verification.profileDigest) {
      return { ok: false, code: 'AUTH_CONFIGURATION_REVOKED', message: '冻结的核验规则已不可用' }
    }
    const targetInfo = await this.loadTargetAuth(run)
    if (!targetInfo) return { ok: false, code: 'SESSION_TARGET_MISSING', message: '目标系统不存在' }
    const successAt = session.lastAuthSuccessAt
    const page = this.pageForGrant(occupancy) ?? live.handle.basePage
    const pageUrl = page && typeof page.url === 'function' ? page.url() : ''
    const onLogin = pageLooksLikeLogin({ pageUrl, loginUrl: targetInfo.loginUrl })
    const fresh =
      !onLogin &&
      session.authState === 'AUTHENTICATED' &&
      (verification.capability !== 'IDENTITY_VERIFIED' || session.identityState === 'MATCH') &&
      isAuthEvidenceFresh({
        lastAuthSuccessAt: successAt instanceof Date ? successAt.toISOString() : successAt,
        freshnessSeconds: verification.freshnessSeconds,
        nowMs: Date.now(),
        sessionGeneration: session.generation,
        frozenGeneration: null,
        profileRevision: session.authProfileRevision,
        frozenRevision: verification.profileRevision,
        expectedIdentity: verification.expectedIdentity,
        frozenExpectedIdentity: verification.expectedIdentity,
      })
    let plan = planAuthEnsure({
      capability: verification.capability,
      fresh,
      infraAttempts: 0,
      backoffSeconds: verification.verifyRetryBackoffSeconds,
    })
    let observation: AuthObservation | null = null
    let infraAttempts = 0
    while (true) {
      signal?.throwIfAborted()
      if (plan.action === 'reuse') {
        await releaseAuthHold(db, { sessionId: session.id, workerId: this.options.workerId }).catch(() => undefined)
        return { ok: true, session: (await getSessionById(db, session.id))! }
      }
      if (plan.action === 'fail' || plan.action === 'yield') {
        return { ok: false, code: plan.code, message: plan.message }
      }
      if (plan.action === 'manual') {
        return this.enterWaitingForAuth(
          session,
          runGrant,
          policy,
          occupancy,
          plan.code,
          plan.message,
          targetInfo,
        )
      }
      if (plan.action === 'backoff_verify') {
        await this.waitInterruptible(plan.delaySeconds * 1000, run.runId, signal)
        infraAttempts += 1
        plan = { action: 'verify' }
        continue
      }
      if (plan.action === 'verify') {
        const verified = await verifyAuthProfile(live.handle, { definition: profile.definition, verification })
        observation = verified.observation
        await this.persistProfileObservation(session, verification, verified)
        plan = planAuthEnsure({
          capability: verification.capability,
          fresh: false,
          observation,
          infraAttempts,
          backoffSeconds: verification.verifyRetryBackoffSeconds,
        })
        continue
      }
      const occupied = await occupyAutoLoginBudget(db, {
        targetId: run.targetId,
        targetAccountId: run.targetAccountId,
      })
      if (!occupied.ok) {
        return this.enterWaitingForAuth(
          session,
          runGrant,
          policy,
          occupancy,
          (occupied.code as SessionErrorCode) ?? 'SESSION_AUTH_UNSUPPORTED',
          occupied.message,
          targetInfo,
        )
      }
      const credential = await this.resolveLoginCredential(run)
      if (!credential) {
        return this.enterWaitingForAuth(
          session,
          runGrant,
          policy,
          occupancy,
          'SESSION_AUTH_UNSUPPORTED',
          '无法解析登录凭据',
          targetInfo,
        )
      }
      const submitted = await submitLoginCredentials(
        live.handle,
        targetInfo,
        credential,
        verification.loginTimeoutMs,
      )
      const verified = await verifyAuthProfile(live.handle, { definition: profile.definition, verification })
      observation = verified.observation
      await this.persistProfileObservation(session, verification, verified)
      const passed =
        observation.authState === 'AUTHENTICATED' &&
        (verification.capability !== 'IDENTITY_VERIFIED' || observation.identityState === 'MATCH')
      const liveAfter = await readLiveSessionAuth(db)
      await recordAutoLoginOutcome(db, {
        targetAccountId: run.targetAccountId,
        result: passed ? 'success' : observation.identityState === 'MISMATCH' ? 'credential' : 'verify_failed',
        sessionAuth: liveAfter.sessionAuth,
      })
      if (submitted && passed) {
        await releaseAuthHold(db, { sessionId: session.id, workerId: this.options.workerId }).catch(() => undefined)
        return { ok: true, session: (await getSessionById(db, session.id))! }
      }
      plan = planAuthEnsure({
        capability: verification.capability,
        fresh: false,
        observation,
        infraAttempts,
        backoffSeconds: verification.verifyRetryBackoffSeconds,
      })
      if (plan.action === 'auto_login') {
        return this.enterWaitingForAuth(
          session,
          runGrant,
          policy,
          occupancy,
          observation.identityState === 'MISMATCH' ? 'AUTH_IDENTITY_MISMATCH' : 'SESSION_AUTH_UNSUPPORTED',
          '自动登录后仍未通过核验',
          targetInfo,
        )
      }
    }
  }

  private async ensureAuth(
    session: SessionRecord,
    run: RunSnapshot,
    runGrant: RunGrant,
    policy: SessionPolicy,
    occupancy: SessionGrant,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; session: SessionRecord }
    | { ok: false; code: SessionErrorCode; message: string; waitingForAuth?: boolean }
  > {
    const db = this.dbHandle
    const live = this.lives.get(session.id)
    if (!live) {
      return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '无浏览器句柄' }
    }

    const targetInfo = await this.loadTargetAuth(run)
    if (!targetInfo) {
      return { ok: false, code: 'SESSION_TARGET_MISSING', message: '目标系统不存在' }
    }

    const verification = run.authVerification
    if (verification && verification.capability !== 'LEGACY') {
      return this.ensureProfileAuth(session, run, runGrant, policy, occupancy, verification, signal)
    }
    if (session.authState === 'AUTHENTICATED' || session.authState === 'EXPIRED') {
      const auth = await probeAuth(live.handle, targetInfo)
      signal?.throwIfAborted()
      await setSessionProbe(db, {
        sessionId: session.id,
        ...this.ownerScope(),
        authState: auth,
      })
      if (auth === 'AUTHENTICATED') {
        return { ok: true, session: (await getSessionById(db, session.id))! }
      }
    }

    signal?.throwIfAborted()
    if (verification?.capability === 'LOGIN_VERIFIED') {
      return this.enterWaitingForAuth(
        session,
        runGrant,
        policy,
        occupancy,
        'SESSION_AUTH_UNSUPPORTED',
        'LOGIN_VERIFIED 不能自动提交凭据',
        targetInfo,
      )
    }
    const missingFields =
      !targetInfo.loginFields?.username ||
      !targetInfo.loginFields?.password ||
      !targetInfo.loginFields?.submit

    const needsManual =
      targetInfo.authMethod === 'manual' || targetInfo.captchaMode !== 'none' || missingFields

    if (needsManual) {
      // 表 D7：manual / captcha / 缺 loginFields 均记 SESSION_AUTH_UNSUPPORTED 并等待人工
      const message =
        missingFields && targetInfo.authMethod === 'password' && targetInfo.captchaMode === 'none'
          ? '登录框定位不完整，无法自动登录'
          : targetInfo.authMethod === 'manual'
            ? '目标系统要求手工认证'
            : targetInfo.captchaMode !== 'none'
              ? '目标系统启用验证码，自动登录降级'
              : '需要人工认证'
      return this.enterWaitingForAuth(
        session,
        runGrant,
        policy,
        occupancy,
        'SESSION_AUTH_UNSUPPORTED',
        message,
        targetInfo,
      )
    }

    // password + none + 字段齐全 → 自动登录
    const credential = await this.resolveLoginCredential(run)
    if (!credential) {
      return this.enterWaitingForAuth(
        session,
        runGrant,
        policy,
        occupancy,
        'SESSION_AUTH_UNSUPPORTED',
        '无法解析登录凭据',
        targetInfo,
      )
    }

    const account = await loadAccountForExecution(db, run.targetAccountId!)
    const username = account?.username ?? credential.username
    signal?.throwIfAborted()
    const ok = await loginWithCredentials(live.handle, targetInfo, {
      username,
      password: credential.password,
    })
    signal?.throwIfAborted()
    const authState = ok ? 'AUTHENTICATED' : 'EXPIRED'
    await setSessionProbe(db, {
      sessionId: session.id,
      ...this.ownerScope(),
      health: 'HEALTHY',
      authState,
    })
    this.logger.log(
      { sessionId: session.id, authState, workerId: this.options.workerId, runId: run.runId },
      'session.auth_changed',
    )
    if (!ok) {
      return this.enterWaitingForAuth(
        session,
        runGrant,
        policy,
        occupancy,
        'SESSION_AUTH_UNSUPPORTED',
        '自动登录失败',
        targetInfo,
      )
    }
    await releaseAuthHold(db, { sessionId: session.id, workerId: this.options.workerId }).catch(
      () => {},
    )
    return { ok: true, session: (await getSessionById(db, session.id))! }
  }

  /**
   * 认证占用 + Run → WAITING_FOR_AUTH，同一事务释放执行租约。
   * 这里等的是目标系统登录，不是控制台账号。
   */
  private async enterWaitingForAuth(
    session: SessionRecord,
    runGrant: RunGrant,
    policy: SessionPolicy,
    occupancy: SessionGrant,
    code: SessionErrorCode,
    message: string,
    target?: { entryUrl: string; loginUrl?: string | null },
  ): Promise<{ ok: false; code: SessionErrorCode; message: string; waitingForAuth: true }> {
    const db = this.dbHandle
    const live = this.lives.get(session.id)
    if (live) {
      live.autoInputClosed = true
      live.inputAccepting = false
      const entry = this.ensureRunPage(live, runGrant.runId, occupancy.leaseId)
      const loginUrl = target?.loginUrl ?? target?.entryUrl
      if (entry?.page && loginUrl) {
        await gotoPage(entry.page, loginUrl).catch(() => undefined)
      }
      for (const [leaseId, mapped] of this.leaseToRun) {
        if (mapped === runGrant.runId) await this.stopTracingForLease(leaseId, session.id)
      }
    }
    const waitGrant = await enterRunWaitingForAuth(db, {
      grant: runGrant,
      sessionId: session.id,
      workerId: this.options.workerId,
      workerInstanceId: this.workerInstanceId,
      holdSeconds: policy.authWaitSeconds,
      leaseTtlSeconds: policy.leaseTtlSeconds,
    })
    if (waitGrant && waitGrant.leaseId !== occupancy.leaseId) {
      this.unbindOccupancy(occupancy.leaseId)
      this.bindOccupancy(waitGrant, runGrant.runId, policy.leaseTtlSeconds)
    }
    this.logger.log(
      { sessionId: session.id, runId: runGrant.runId, workerId: this.options.workerId, code },
      'session.auth_changed',
    )
    return { ok: false, code, message, waitingForAuth: true }
  }

  private async resolveLoginCredential(
    run: RunSnapshot,
  ): Promise<{ username: string; password: string } | null> {
    if (this.resolveCredential) {
      return this.resolveCredential(run)
    }
    if (!run.secretRef || !this.secrets) return null
    if (run.secretRef.provider !== LOCAL_SECRET_PROVIDER) return null
    const row = await loadSecretCiphertext(this.dbHandle, run.secretRef.secretId)
    if (!row) return null
    try {
      const password = this.secrets.decrypt(row.id, row.ciphertext)
      const account = await loadAccountForExecution(this.dbHandle, run.targetAccountId!)
      return { username: account?.username ?? '', password }
    } catch {
      return null
    }
  }

  private async loadTargetAuth(run: RunSnapshot): Promise<
    | (TargetAuthInfo & {
        authMethod: string
        captchaMode: string
      })
    | null
  > {
    const row = await loadTargetForExecution(this.dbHandle, run.targetId)
    if (!row) return null
    if (run.targetAuth) {
      return {
        entryUrl: run.targetAuth.entryUrl,
        loginUrl: run.targetAuth.loginUrl,
        loginFields: run.targetAuth.loginFields,
        authMethod: run.targetAuth.authMethod,
        captchaMode: run.targetAuth.captchaMode,
      }
    }
    return {
      entryUrl: row.entryUrl,
      loginUrl: row.loginUrl,
      loginFields: row.loginFields,
      authMethod: row.authMethod,
      captchaMode: row.captchaMode,
    }
  }

  private async applyReuse(
    session: SessionRecord,
    policy: SessionPolicy,
    leaseId: string,
  ): Promise<void> {
    const live = this.lives.get(session.id)
    if (!live) return
    if (pageStrategyForReuse(policy.reuse) === 'base') return
    const page = await openRunPage(live.handle)
    live.runPages.set(leaseId, page)
    live.runPageIds.add(leaseId)
    const runId = this.leaseToRun.get(leaseId)
    if (runId) this.adoptPage(live, runId, page, 'run', leaseId)
  }

  /** 测试钩子：给已有会话行挂上可确认退出的句柄，让 close() 走 D6 确认路径。 */
  installLiveHandleForTest(sessionId: string, handle: BrowserHandle): void {
    this.lives.set(sessionId, emptyLive(handle, sessionId))
  }

  markBrowserUnavailable(code: 'BROWSER_UNAVAILABLE' | 'BROWSER_LAUNCH_FAILED' | 'PROFILE_LOCKED'): void {
    if (code === 'PROFILE_LOCKED') return
    this.browserUnavailable = true
    this.browserUnavailableCode = code
    this.logger.error({ code, workerId: this.options.workerId }, 'browser.unavailable')
  }

  /**
   * 失联自愈：先停本进程全部句柄。确认退出才关会话；确认不了则留 LOST。
   */
  async stopAllLocal(): Promise<Array<{ sessionId: string; result: 'stopped' | 'unconfirmed' }>> {
    const owned = await listOwnedLiveSessions(this.dbHandle, this.options.workerId)
    const ids = new Set<string>([...this.lives.keys(), ...owned.map((session) => session.id)])
    const results: Array<{ sessionId: string; result: 'stopped' | 'unconfirmed' }> = []
    for (const sessionId of ids) {
      await this.close(sessionId, 'owner_confirmed_stopped')
      const latest = await getSessionById(this.dbHandle, sessionId)
      results.push({
        sessionId,
        result: latest?.status === 'CLOSED' ? 'stopped' : 'unconfirmed',
      })
    }
    return results
  }

  private async closeRunPage(leaseId: string): Promise<void> {
    const sessionId = this.leaseToSession.get(leaseId)
    if (!sessionId) return
    const live = this.lives.get(sessionId)
    if (!live) return
    const page = live.runPages.get(leaseId)
    if (page) {
      await closePage(page)
      live.runPages.delete(leaseId)
      live.runPageIds.delete(leaseId)
    }
  }
}

function emptyLive(handle: BrowserHandle, sessionId: string): LiveHandle {
  return {
    handle,
    sessionId,
    runPageIds: new Set(),
    runPages: new Map(),
    pages: new Map(),
    currentPageIdByLease: new Map(),
    currentPageIdByRun: new Map(),
    autoInputClosed: false,
    inputAccepting: false,
    serial: Promise.resolve(),
    allowedOrigins: [],
    receipts: new Map(),
    lastSeq: 0,
    controlEpoch: 0,
    screencasts: new Map(),
    screencastObservers: new Map(),
  }
}

export type { LeaseRecord }
