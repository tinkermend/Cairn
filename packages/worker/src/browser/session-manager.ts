import { randomUUID } from 'node:crypto'
import {
  Inject,
  Injectable,
  Logger,
  Optional
} from '@nestjs/common'
import {
  getRun,
  getWorkerById,
  type DbHandle,
  type LeaseRecord,
  type SessionRecord
} from '@cairn/db'
import {
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
  type RecoveryRule,
  type ManagedBrowserFrame,
  type ManagedBrowserMeta,
  type MapViewport,
  type ObserveOperation,
  type PageRef,
  type RunGrant,
  type TargetObservation,
  type RunSnapshot,
  type SessionErrorCode,
  type SessionEventType,
  type SessionGrant,
  type SessionPolicy
} from '@cairn/shared'
import type { LocalSecretProvider } from '@cairn/secret'
import { ObjectService } from '../objects/object.service'
import { DB_HANDLE } from '../db/db.module'
import { SessionGuard } from './guard'
import { verifyAuthProfile } from './session-auth'
import {
  countPages,
  launchSession,
  type BrowserHandle,
  type TargetAuthInfo
} from './runtime'
import { type ManagedPageEntry } from './page-identity'
import {
  emptyLive,
  SessionLeaseError,
  type BrowserSessionManagerOptions,
  type LiveHandle,
  type ObserveGrantEntry,
  type RunAuthState,
  type SessionAcquireResult,
} from './session-live.js'
import { abandonOccupancy, acquireExclusive, applyReuse, bindOccupancy, ensureAuth, ensureProfileAuth, enterWaitingForAuth, evictIfAtCapacity, finishClaimedAcquire, launchAndOpen, liveSessionIdForOwner, loadTargetAuth, recoverAuth, recoverAuthHeld, resolveLoginCredential, unbindOccupancy, waitInterruptible, withHeldOccupancy } from './session-claim.js'
import { attachSessionAuthObserver } from './session-idle-observer.js'
import { attachMaintenanceOperation, attachValidationOperation, completeOccupiedAuth, finishMaintenance, markMaintenanceOutcomeUnknown, markSessionLost, persistProfileObservation, resolveAccountCredential, runMaintenanceAuth, verifyOccupiedOwner } from './session-maintenance-runtime.js'
import { acquireRunAuthControl, applyRecoveryRule, executeAuthInput, expiredAuthObservation, failInRunAuthRecovery, heartbeatRunAuthControl, inputRunAuthControl, observeInRunAuth, observeInRunAuthHeld, releaseRunAuthControl, restoreAuthGateFromCheckpoint, resumeRunAuth, verifyInRunAuth } from './session-auth-control.js'
import { adoptPage, assertCommand, closeRunPage, ensureRunPage, execute, invalidate, pageForGrant, runManagedPage, runSurfaceCommand, startTracingForLease, stopTracingForLease, withManagedPage } from './session-command.js'
import {
  discardSealedVideo,
  finalizeSealedVideo,
  rebindVideoForLease,
  retargetVideoForLease,
  sealVideoForLease,
  startVideoForLease,
  stopVideoForLease,
  type RunVideoRecorder,
  type SealedRunVideo,
} from './run-video.js'
import { assertOwnLiveRegistration, assertSessionOwnedHere, authWindowStatus, buildMeta, describeHoldPage, describeRunBrowser, dropScreencastObserver, invalidateObserveGrant, liveSessionIdForRun, lookupRunSession, observeRun, pageForView, pipeFrames, probeErrorSurface, registrationLive, requireLiveAuthSession, sampleMapConditions, sessionOwnedHere, subscribeRunFrames } from './session-observe-runtime.js'
import { close, dropDisposedHandles, dropLocalHandle, ownerScope, platformDefaultPolicy, reap, reconcileOwn, release, renew, renewAll, shutdown, stopAllLocal } from './session-reaper.js'

export const BROWSER_SESSION_OPTIONS = Symbol('BROWSER_SESSION_OPTIONS')
import { SECRET_PROVIDER } from '../tokens.js'
export { SECRET_PROVIDER }
export { SessionLeaseError, type BrowserSessionManagerOptions, type SessionAcquireResult } from './session-live.js'

@Injectable()
export class BrowserSessionManager {
  readonly logger = new Logger(BrowserSessionManager.name)
  readonly guard = new SessionGuard()
  readonly acquiring = new Set<string>()
  readonly lives = new Map<string, LiveHandle>()
  readonly leaseToSession = new Map<string, string>()
  readonly leaseToRun = new Map<string, string>()
  readonly leaseTtls = new Map<string, number>()
  readonly tracingByLease = new Map<string, boolean>()
  readonly videoRecorders = new Map<string, RunVideoRecorder>()
  readonly observeGrants = new Map<string, ObserveGrantEntry>()
  readonly authGateClosed = new Set<string>()
  readonly inRunVerifyCounts = new Map<string, number>()
  readonly runAuth = new Map<string, RunAuthState>()
  heartbeat: NodeJS.Timeout | undefined
  reconciled = false
  browserUnavailable = false
  browserUnavailableCode: 'BROWSER_UNAVAILABLE' | 'BROWSER_LAUNCH_FAILED' = 'BROWSER_UNAVAILABLE'
  workerInstanceId: string
  /** 测试钩子：覆盖默认 launch。 */
  launchOverride?: typeof launchSession

  setWorkerInstance(instanceId: string): void {
    this.workerInstanceId = instanceId
  }

  getWorkerInstanceId(): string {
    return this.workerInstanceId
  }

  ownerScope() {
    return ownerScope.call(this)
  }

  async dropLocalHandle(
    sessionId: string,
    options?: { commitVideo?: boolean },
  ): Promise<'stopped' | 'unconfirmed'> {
    return dropLocalHandle.call(this, sessionId, options)
  }

  constructor(
    @Inject(DB_HANDLE) readonly dbHandle: DbHandle,
    @Inject(BROWSER_SESSION_OPTIONS) readonly options: BrowserSessionManagerOptions,
    @Optional() @Inject(SECRET_PROVIDER) readonly secrets?: LocalSecretProvider,
    @Optional() @Inject(ObjectService) readonly objects?: ObjectService,
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
    return reconcileOwn.call(this)
  }

  async acquire(run: RunSnapshot, runGrant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireResult> {
    const key = `${run.targetId}:${run.targetAccountId ?? ''}`
    if (this.acquiring.has(key)) return { ok: false, code: 'SESSION_BUSY', message: '同一目标账号正在获取会话' }
    this.acquiring.add(key)
    try { return await this.acquireExclusive(run, runGrant, signal) }
    finally { this.acquiring.delete(key) }
  }

  bindOccupancy(grant: SessionGrant, runId: string, ttlSeconds: number) {
    return bindOccupancy.call(this, grant, runId, ttlSeconds)
  }

  unbindOccupancy(leaseId: string) {
    return unbindOccupancy.call(this, leaseId)
  }

  async abandonOccupancy(leaseId: string, reason: string) {
    return abandonOccupancy.call(this, leaseId, reason)
  }

  withHeldOccupancy<T>(
    leaseId: string,
    expected: Partial<SessionGrant> | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> | T {
    return withHeldOccupancy.call(this, leaseId, expected, fn) as Promise<T> | T
  }

  async acquireExclusive(run: RunSnapshot, runGrant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireResult> {
    return acquireExclusive.call(this, run, runGrant, signal)
  }

  async evictIfAtCapacity(): Promise<boolean> {
    return evictIfAtCapacity.call(this)
  }

  async attachSessionAuthObserver(sessionId: string): Promise<void> {
    return attachSessionAuthObserver.call(this, sessionId)
  }

  async finishClaimedAcquire(
    created: boolean,
    session: SessionRecord,
    run: RunSnapshot,
    runGrant: RunGrant,
    policy: SessionPolicy,
    grant: SessionGrant,
    signal?: AbortSignal,
  ): Promise<SessionAcquireResult> {
    return finishClaimedAcquire.call(this, created, session, run, runGrant, policy, grant, signal)
  }

  liveSessionIdForOwner(ownerId: string): string | undefined {
    return liveSessionIdForOwner.call(this, ownerId)
  }

  countInRunVerify(phase: string): number {
    return this.inRunVerifyCounts.get(phase) ?? 0
  }

  assertAuthGate(leaseId: string): void {
    if (this.authGateClosed.has(leaseId)) {
      throw new Error('AUTH_GATE_CLOSED')
    }
  }

  expiredAuthObservation(summary: string, snapshot?: RunSnapshot): AuthObservation {
    return expiredAuthObservation.call(this, summary, snapshot)
  }

  async applyRecoveryRule(
    page: { url: () => string },
    rule: RecoveryRule,
  ): Promise<boolean> {
    return applyRecoveryRule.call(this, page, rule)
  }

  markTransientPageState(grant: SessionGrant): void {
    const current = this.runAuth.get(grant.leaseId) ?? {}
    this.runAuth.set(grant.leaseId, { ...current, transient: true })
  }

  async restoreAuthGateFromCheckpoint(runId: string, grant: SessionGrant): Promise<boolean> {
    return restoreAuthGateFromCheckpoint.call(this, runId, grant)
  }

  async verifyInRunAuth(
    grant: SessionGrant,
    phase?: string,
    snapshot?: RunSnapshot,
  ): Promise<Pick<AuthObservation, 'authState' | 'identityState'>> {
    return verifyInRunAuth.call(this, grant, phase, snapshot)
  }

  async observeInRunAuth(
    grant: SessionGrant,
    classification: 'dispatched' | 'not_dispatched',
    signal?: AbortSignal,
  ): Promise<ExecutionError | null> {
    return observeInRunAuth.call(this, grant, classification, signal)
  }

  async observeInRunAuthHeld(
    grant: SessionGrant,
    classification: 'dispatched' | 'not_dispatched',
    _signal?: AbortSignal,
  ): Promise<ExecutionError | null> {
    return observeInRunAuthHeld.call(this, grant, classification, _signal)
  }

  async sampleMapConditions(
    grant: SessionGrant,
    _signal?: AbortSignal,
  ): Promise<{ locale?: string; viewport?: MapViewport; pageFrameObserved: boolean }> {
    return sampleMapConditions.call(this, grant, _signal)
  }

  async probeErrorSurface(grant: SessionGrant, _signal?: AbortSignal): Promise<{ role: string; text: string }[]> {
    return probeErrorSurface.call(this, grant, _signal)
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
    return recoverAuth.call(this, grant, input)
  }

  async recoverAuthHeld(
    grant: SessionGrant,
    input: {
      kind: 'auto' | 'manual'
      runGrant: RunGrant
      snapshot: RunSnapshot
      resuming?: boolean
    },
  ): Promise<AuthRecoveryOutcome> {
    return recoverAuthHeld.call(this, grant, input)
  }

  async attachValidationOperation(input: {
    operation: { id: string; targetId: string; targetAccountId: string }
    grant: SessionGrant
    session: SessionRecord
  }): Promise<void> {
    return attachValidationOperation.call(this, input)
  }

  async verifyOccupiedOwner(ownerId: string): Promise<AuthObservation> {
    return verifyOccupiedOwner.call(this, ownerId)
  }

  async completeOccupiedAuth(
    ownerId: string,
    _input?: { actorId: string; token?: string },
  ): Promise<AuthObservation> {
    return completeOccupiedAuth.call(this, ownerId, _input)
  }

  async attachMaintenanceOperation(input: {
    operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string; kindParams?: Record<string, unknown> | null }
    grant: SessionGrant | null
    session: SessionRecord | null
    reusedRunId: string | null
  }): Promise<void> {
    return attachMaintenanceOperation.call(this, input)
  }

  async markSessionLost(sessionId: string, reason: string): Promise<void> {
    return markSessionLost.call(this, sessionId, reason)
  }

  async markMaintenanceOutcomeUnknown(
    session: SessionRecord,
    operation: { targetId: string; targetAccountId: string },
  ): Promise<void> {
    return markMaintenanceOutcomeUnknown.call(this, session, operation)
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
    return finishMaintenance.call(this, operationId, key, status, event, errorCode)
  }

  async runMaintenanceAuth(
    session: SessionRecord,
    operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string },
    grant: SessionGrant | null,
    mode: 'verify' | 'ensure',
    attempt?: { loginSubmitted: boolean },
  ): Promise<{ ok: true } | { ok: false; code?: SessionErrorCode } | 'waiting'> {
    return runMaintenanceAuth.call(this, session, operation, grant, mode, attempt)
  }

  async persistProfileObservation(
    session: SessionRecord,
    verification: FrozenAuthVerification,
    verified: Awaited<ReturnType<typeof verifyAuthProfile>>,
  ): Promise<void> {
    return persistProfileObservation.call(this, session, verification, verified)
  }

  async resolveAccountCredential(
    accountId: string,
  ): Promise<{ username: string; password: string; secretId?: string } | null> {
    return resolveAccountCredential.call(this, accountId)
  }

  async renew(leaseId: string, leaseTtlSeconds?: number): Promise<'ok' | 'lost'> {
    return renew.call(this, leaseId, leaseTtlSeconds)
  }

  /**
   * 释放租约。行不存在 → SESSION_LEASE_UNKNOWN；已非 ACTIVE 视为幂等成功。
   */
  async release(leaseId: string, reason: string): Promise<void> {
    return release.call(this, leaseId, reason)
  }

  async close(sessionId: string, reason: string): Promise<'stopped' | 'unconfirmed'> {
    return close.call(this, sessionId, reason)
  }

  async reap(options?: { includeGlobalLeases?: boolean }): Promise<{
    leasesExpired: number
    sessionsClosed: number
  }> {
    return reap.call(this, options)
  }

  /**
   * 丢弃已不由本进程拥有的会话句柄：行已 CLOSED、已消失，或 owner 换了人。
   *
   * 处置只改库，停不了浏览器；句柄在本进程时由这里收尾。租约映射一并清掉——
   * 处置已经把它们 REVOKED，留着只会让心跳反复判定丢租。
   */
  async dropDisposedHandles(): Promise<number> {
    return dropDisposedHandles.call(this)
  }

  /** 停机：释放名下租约并关闭浏览器。 */
  async shutdown(): Promise<void> {
    return shutdown.call(this)
  }

  assertCommand(leaseId: string): SessionGrant {
    return assertCommand.call(this, leaseId)
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
    | {
        ok: true
        value: T
        screenshotBytes?: Buffer
        extraShots?: { role: import('@cairn/shared').ScreenshotRole; bytes: Buffer }[]
        faceRole?: import('@cairn/shared').ScreenshotRole
        pageRef?: import('@cairn/shared').PageRef
        tracePath?: string
      }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        extraShots?: { role: import('@cairn/shared').ScreenshotRole; bytes: Buffer }[]
        faceRole?: import('@cairn/shared').ScreenshotRole
        pageRef?: import('@cairn/shared').PageRef
        tracePath?: string
      }
  > {
    return (withManagedPage as typeof withManagedPage<T>).call(this, grant, evidence, fn, failed)
  }

  async runManagedPage<T>(
    grant: SessionGrant,
    evidence: BrowserCommandEvidence | undefined,
    fn: (page: import('playwright').Page) => Promise<T>,
    failed: (value: T) => boolean,
  ): Promise<
    | {
        ok: true
        value: T
        screenshotBytes?: Buffer
        extraShots?: { role: import('@cairn/shared').ScreenshotRole; bytes: Buffer }[]
        faceRole?: import('@cairn/shared').ScreenshotRole
        pageRef?: import('@cairn/shared').PageRef
        tracePath?: string
      }
    | {
        ok: false
        error: Extract<BrowserCommandResult, { ok: false }>['error']
        screenshotBytes?: Buffer
        extraShots?: { role: import('@cairn/shared').ScreenshotRole; bytes: Buffer }[]
        faceRole?: import('@cairn/shared').ScreenshotRole
        pageRef?: import('@cairn/shared').PageRef
        tracePath?: string
      }
  > {
    return (runManagedPage as typeof runManagedPage<T>).call(this, grant, evidence, fn, failed)
  }

  /**
   * 浏览器命令唯一入口：先过受管范围，再走 Surface。Playwright 不离开 runtime.ts。
   */
  async execute(
    grant: SessionGrant,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<
    BrowserCommandResult & {
      screenshotBytes?: Buffer
      extraShots?: { role: import('@cairn/shared').ScreenshotRole; bytes: Buffer }[]
      faceRole?: import('@cairn/shared').ScreenshotRole
      pageRef?: import('@cairn/shared').PageRef
      tracePath?: string
    }
  > {
    return execute.call(this, grant, command, signal, evidence)
  }

  async invalidate(grant: SessionGrant, reason: string): Promise<void> {
    return invalidate.call(this, grant, reason)
  }

  async startTracingForLease(leaseId: string, sessionId: string, run: RunSnapshot): Promise<void> {
    return startTracingForLease.call(this, leaseId, sessionId, run)
  }

  async stopTracingForLease(leaseId: string, sessionId: string | undefined): Promise<void> {
    return stopTracingForLease.call(this, leaseId, sessionId)
  }

  async startVideoForLease(leaseId: string, sessionId: string, run: RunSnapshot): Promise<void> {
    return startVideoForLease.call(this, leaseId, sessionId, run)
  }

  async sealVideoForLease(leaseId: string): Promise<SealedRunVideo | null> {
    return sealVideoForLease.call(this, leaseId)
  }

  async finalizeSealedVideo(sealed: SealedRunVideo | null): Promise<void> {
    return finalizeSealedVideo.call(this, sealed)
  }

  async discardSealedVideo(sealed: SealedRunVideo | null): Promise<void> {
    return discardSealedVideo.call(this, sealed)
  }

  async stopVideoForLease(leaseId: string): Promise<void> {
    return stopVideoForLease.call(this, leaseId)
  }

  rebindVideoForLease(fromLeaseId: string, toLeaseId: string): void {
    return rebindVideoForLease.call(this, fromLeaseId, toLeaseId)
  }

  async retargetVideoForLease(live: LiveHandle, leaseId: string): Promise<void> {
    return retargetVideoForLease.call(this, live, leaseId)
  }

  pageForGrant(grant: SessionGrant) {
    return pageForGrant.call(this, grant)
  }

  async runSurfaceCommand(
    grant: SessionGrant,
    page: import('playwright').Page,
    command: BrowserCommand,
    signal?: AbortSignal,
    evidence?: BrowserCommandEvidence,
  ): Promise<BrowserCommandResult> {
    return runSurfaceCommand.call(this, grant, page, command, signal, evidence)
  }

  adoptPage(
    live: LiveHandle,
    runId: string,
    page: import('playwright').Page,
    kind: ManagedPageEntry['kind'],
    leaseId?: string,
  ): ManagedPageEntry {
    return adoptPage.call(this, live, runId, page, kind, leaseId)
  }

  ensureRunPage(live: LiveHandle, runId: string, leaseId?: string): ManagedPageEntry {
    return ensureRunPage.call(this, live, runId, leaseId)
  }

  async describeRunBrowser(input: { runId: string; actorId: string; pageId?: string }): Promise<ManagedBrowserMeta> {
    return describeRunBrowser.call(this, input)
  }

  invalidateObserveGrant(runId: string): void {
    return invalidateObserveGrant.call(this, runId)
  }

  async describeHoldPage(runId: string): Promise<{
    pageRef?: PageRef
    url?: string
    authSignal?: AuthSignal
    authObservation?: AuthObservation
    contextRecoverable?: boolean
  } | undefined> {
    return describeHoldPage.call(this, runId)
  }

  async observeRun(input: { runId: string; actorId: string; op: ObserveOperation }): Promise<TargetObservation> {
    return observeRun.call(this, input)
  }

  async acquireRunAuthControl(input: {
    runId: string
    actor: { id: string }
    pageId?: string
  }): Promise<AcquireAuthControlResponse> {
    return acquireRunAuthControl.call(this, input)
  }

  async heartbeatRunAuthControl(input: {
    runId: string
    actorId: string
    token: string
    pageId?: string
  }): Promise<{ expiresAt: string; epoch: number }> {
    return heartbeatRunAuthControl.call(this, input)
  }

  async inputRunAuthControl(input: {
    runId: string
    actorId: string
    token: string
    command: BrowserAuthInputCommand
  }): Promise<AuthControlInputReceipt> {
    return inputRunAuthControl.call(this, input)
  }

  async executeAuthInput(params: {
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
    return executeAuthInput.call(this, params)
  }

  async releaseRunAuthControl(input: {
    runId: string
    actor: { id: string }
    token: string
  }): Promise<boolean> {
    return releaseRunAuthControl.call(this, input)
  }

  async resumeRunAuth(input: {
    runId: string
    actor: { id: string }
    token?: string
    note?: string
  }): Promise<void> {
    return resumeRunAuth.call(this, input)
  }

  async failInRunAuthRecovery(
    runId: string,
    session: SessionRecord,
    checkpoint: AuthCheckpoint,
    code: 'AUTH_CONTEXT_NOT_RECOVERABLE' | 'AUTH_RECOVERY_LIMIT',
  ): Promise<void> {
    return failInRunAuthRecovery.call(this, runId, session, checkpoint, code)
  }

  subscribeRunFrames(input: {
    runId: string
    actorId: string
    pageId?: string
    onFrame: (frame: ManagedBrowserFrame) => void
    signal: AbortSignal
  }): Promise<void> {
    return subscribeRunFrames.call(this, input)
  }

  async pipeFrames(input: {
    runId: string
    actorId: string
    pageId?: string
    onFrame: (frame: ManagedBrowserFrame) => void
    signal: AbortSignal
  }): Promise<void> {
    return pipeFrames.call(this, input)
  }

  countScreencastObservers(sessionId: string): number {
    const live = this.lives.get(sessionId)
    if (!live) return 0
    let total = 0
    for (const count of live.screencastObservers.values()) total += count
    return total
  }

  async dropScreencastObserver(live: LiveHandle, pageId: string): Promise<void> {
    return dropScreencastObserver.call(this, live, pageId)
  }

  pageForView(live: LiveHandle, runId: string, pageId?: string): ManagedPageEntry | undefined {
    return pageForView.call(this, live, runId, pageId)
  }

  async requireLiveAuthSession(runId: string): Promise<{
    session: SessionRecord
    live: LiveHandle
    run: Awaited<ReturnType<typeof getRun>>
  }> {
    return requireLiveAuthSession.call(this, runId)
  }

  sessionOwnedHere(session: SessionRecord): boolean {
    return sessionOwnedHere.call(this, session)
  }

  assertSessionOwnedHere(session: SessionRecord): void {
    return assertSessionOwnedHere.call(this, session)
  }

  registrationLive(worker: Awaited<ReturnType<typeof getWorkerById>>): boolean {
    return registrationLive.call(this, worker)
  }

  async assertOwnLiveRegistration(): Promise<void> {
    return assertOwnLiveRegistration.call(this)
  }

  liveSessionIdForRun(runId: string): string | undefined {
    return liveSessionIdForRun.call(this, runId)
  }

  /** 只解析「是不是认证输入窗口」的状态：先 Run，落空再按维护操作 id 兜底。 */
  async authWindowStatus(runId: string): Promise<string> {
    return authWindowStatus.call(this, runId)
  }

  async lookupRunSession(runId: string): Promise<{
    run: Awaited<ReturnType<typeof getRun>>
    session: SessionRecord | null
    live: LiveHandle | undefined
  }> {
    return lookupRunSession.call(this, runId)
  }

  async buildMeta(runId: string, actorId: string, viewPageId?: string): Promise<ManagedBrowserMeta> {
    return buildMeta.call(this, runId, actorId, viewPageId)
  }

  pageCount(sessionId: string): number {
    const live = this.lives.get(sessionId)
    return live ? countPages(live.handle) : 0
  }

  /** 测试钩子：覆盖默认 SecretProvider 解密。 */
  resolveCredential?: (run: RunSnapshot) => Promise<{ username: string; password: string; secretId?: string } | null>

  platformDefaultPolicy(): SessionPolicy {
    return platformDefaultPolicy.call(this)
  }

  async renewAll(): Promise<void> {
    return renewAll.call(this)
  }

  async launchAndOpen(
    created: SessionRecord,
    key: { targetId: string; targetAccountId: string },
  ): Promise<
    | { ok: true; session: SessionRecord }
    | { ok: false; code: SessionErrorCode; message: string }
  > {
    return launchAndOpen.call(this, created, key)
  }

  async waitInterruptible(ms: number, runId: string, signal?: AbortSignal): Promise<void> {
    return waitInterruptible.call(this, ms, runId, signal)
  }

  async ensureProfileAuth(
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
    return ensureProfileAuth.call(this, session, run, runGrant, policy, occupancy, verification, signal)
  }

  async ensureAuth(
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
    return ensureAuth.call(this, session, run, runGrant, policy, occupancy, signal)
  }

  /**
   * 认证占用 + Run → WAITING_FOR_AUTH，同一事务释放执行租约。
   * 这里等的是目标系统登录，不是控制台账号。
   */
  async enterWaitingForAuth(
    session: SessionRecord,
    runGrant: RunGrant,
    policy: SessionPolicy,
    occupancy: SessionGrant,
    code: SessionErrorCode,
    message: string,
    target?: { entryUrl: string; loginUrl?: string | null; captchaHumanWaitSeconds?: number },
  ): Promise<{ ok: false; code: SessionErrorCode; message: string; waitingForAuth: boolean }> {
    return enterWaitingForAuth.call(this, session, runGrant, policy, occupancy, code, message, target)
  }

  async resolveLoginCredential(
    run: RunSnapshot,
  ): Promise<{ username: string; password: string; secretId?: string } | null> {
    return resolveLoginCredential.call(this, run)
  }

  async loadTargetAuth(run: RunSnapshot): Promise<
    | (TargetAuthInfo & {
        authMethod: string
        captchaMode: string
      })
    | null
  > {
    return loadTargetAuth.call(this, run)
  }

  async applyReuse(
    session: SessionRecord,
    policy: SessionPolicy,
    leaseId: string,
  ): Promise<void> {
    return applyReuse.call(this, session, policy, leaseId)
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
    return stopAllLocal.call(this)
  }

  async closeRunPage(leaseId: string): Promise<void> {
    return closeRunPage.call(this, leaseId)
  }
}

export type { LeaseRecord }
