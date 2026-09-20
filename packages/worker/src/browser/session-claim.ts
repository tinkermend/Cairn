import {
  appendSessionEvent,
  assertLiveAuthConfiguration,
  claimSessionUse,
  enterRunWaitingForAuth,
  countOpenSessionsForWorker,
  findEvictableSession,
  loadAuthProfileRevision,
  occupyAutoLoginBudget,
  readLiveSessionAuth,
  recordAutoLoginOutcome,
  findLiveSession,
  getRun,
  getSessionById,
  loadSecretCiphertext,
  recordCredentialVerification,
  resolveSnapshotCredential,
  releaseSessionUse,
  setSessionProbe,
  setSessionStatus,
  loadTargetForExecution,
  appendRunEvents,
  recordCaptchaLoginAttempt,
  type SessionRecord
} from '@cairn/db'
import { randomUUID } from 'node:crypto'
import {
  LOCAL_SECRET_PROVIDER,
  resolveSessionPolicy,
  type AuthObservation,
  type AuthRecoveryOutcome,
  type FrozenAuthVerification,
  type ChallengeAuditRecord,
  compileAccessScopeFromSnapshot,
  deriveRecoveryRule,
  inRunAuthVerifyAllowed,
  isAuthEvidenceFresh,
  pageLooksLikeLogin,
  planAuthEnsure,
  type RunGrant,
  type RunSnapshot,
  type SessionErrorCode,
  type SessionGrant,
  type SessionPolicy
} from '@cairn/shared'
import { ensureProfileDir } from './profiles'
import { verifyAuthProfile } from './session-auth'
import { pageStrategyForReuse, shouldRecreateSession } from './reuse'
import {
  BrowserRuntimeError,
  OccupancyRequiredError,
  applySessionAuthToTarget,
  gotoPage,
  launchSession,
  attemptLoginWithCredentials,
  loginWithCredentials,
  openRunPage,
  probeAuth,
  probeHealth,
  runWithOccupancy,
  submitLoginCredentials,
  stopSession,
  type TargetAuthInfo
} from './runtime'
import { hasTargetScope, installTargetScope } from './target-scope'
import { originAllowed } from './page-identity'
import { emptyLive, type LiveHandle, type SessionAcquireResult, type SessionManagerContext } from './session-live.js'
import { shouldContinueCaptchaRetry } from './captcha/login-outcome.js'

async function recordAuthAttemptStarted(
  db: SessionManagerContext['dbHandle'],
  session: Pick<SessionRecord, 'id' | 'targetId' | 'targetAccountId' | 'generation'>,
  detail?: { runId?: string; attempt?: number; maxAttempts?: number; challengeType?: ChallengeAuditRecord['challengeType'] },
): Promise<void> {
  try {
    await appendSessionEvent(db, {
      key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
      type: 'auth.attempt_started',
      sessionId: session.id,
      generation: session.generation,
      runId: detail?.runId,
      payload: detail?.attempt
        ? { attempt: detail.attempt, maxAttempts: detail.maxAttempts, challengeType: detail.challengeType }
        : {},
    })
  } catch {
    /* 事件失败不得阻断登录，但持久化后可用于崩溃后复盘已尝试次数 */
  }
}

export function bindOccupancy(this: SessionManagerContext, grant: SessionGrant, runId: string, ttlSeconds: number) {
    this.guard.install(grant)
    this.leaseToSession.set(grant.leaseId, grant.sessionId)
    this.leaseToRun.set(grant.leaseId, runId)
    this.leaseTtls.set(grant.leaseId, ttlSeconds)
  }

export function unbindOccupancy(this: SessionManagerContext, leaseId: string) {
    this.guard.revoke(leaseId)
    this.leaseToSession.delete(leaseId)
    this.leaseToRun.delete(leaseId)
    this.leaseTtls.delete(leaseId)
  }

export async function abandonOccupancy(this: SessionManagerContext, leaseId: string, reason: string) {
    const sealed = await this.sealVideoForLease(leaseId)
    this.unbindOccupancy(leaseId)
    try {
      await releaseSessionUse(this.dbHandle, {
        leaseId,
        holderWorkerId: this.options.workerId,
        reason,
      })
    } catch {
      // 释放占用不得挡住维护终态；句柄已失效时租约由收割收敛。
    }
    await this.finalizeSealedVideo(sealed)
  }

export function withHeldOccupancy<T>(this: SessionManagerContext, 
    leaseId: string,
    expected: Partial<SessionGrant> | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> | T {
    return runWithOccupancy(this.guard.assertHeld(leaseId, expected), fn)
  }

export async function evictIfAtCapacity(this: SessionManagerContext): Promise<boolean> {
  const db = this.dbHandle
  const openCount = await countOpenSessionsForWorker(db, this.options.workerId)
  if (openCount < this.options.maxSessions) return false
  const evictable = await findEvictableSession(db, this.options.workerId, this.workerInstanceId)
  if (!evictable) return false
  await this.close(evictable.id, 'capacity_evict')
  return true
}

export async function acquireExclusive(this: SessionManagerContext, run: RunSnapshot, runGrant: RunGrant, signal?: AbortSignal): Promise<SessionAcquireResult> {
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
      policy = resolveSessionPolicy(run.sessionPolicy)
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
        await this.evictIfAtCapacity()
        openCount = await countOpenSessionsForWorker(db, this.options.workerId)
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
      reclaimMode: policy.reclaim,
      keepAliveSeconds: policy.keepAliveSeconds,
      authProbeIntervalSeconds: policy.authProbeIntervalSeconds,
      evictionPriority: policy.evictionPriority,
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

export async function finishClaimedAcquire(this: SessionManagerContext, 
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
      managed.accessScope = compileAccessScopeFromSnapshot(run)
      if (managed.accessScope.rules.length > 0 || hasTargetScope(managed.handle.context)) {
        await installTargetScope(managed.handle.context, managed.accessScope)
      }
    }
    await this.applyReuse(live, policy, grant.leaseId)
    if (managed) this.ensureRunPage(managed, run.runId, grant.leaseId)
    this.runAuth.set(grant.leaseId, { ...this.runAuth.get(grant.leaseId), snapshot: run })
    await this.startVideoForLease(grant.leaseId, live.id, run)

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
    await this.startVideoForLease(grant.leaseId, live.id, run)
    if (ready) await this.retargetVideoForLease(ready, grant.leaseId)
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

export function liveSessionIdForOwner(this: SessionManagerContext, ownerId: string): string | undefined {
    const leaseId = [...this.leaseToRun.entries()].find(([, mapped]) => mapped === ownerId)?.[0]
    return leaseId ? this.leaseToSession.get(leaseId) : undefined
  }

export async function recoverAuth(this: SessionManagerContext, 
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

export async function recoverAuthHeld(this: SessionManagerContext, 
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
    if (live) await this.startVideoForLease(grant.leaseId, sessionId, input.snapshot)
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
    if (checkpoint?.recoveryRule?.reuse === 'REUSE_PAGE') {
      const hold = await this.describeHoldPage(input.runGrant.runId)
      if (checkpoint.pageRef && hold?.pageRef && hold.pageRef.documentEpoch !== checkpoint.pageRef.documentEpoch) {
        return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      }
      const pageUrl = (page && typeof page.url === 'function' ? page.url() : hold?.url) ?? ''
      if (
        pageUrl &&
        !originAllowed(
          pageUrl,
          checkpoint.recoveryRule.allowedOrigins ?? [],
          compileAccessScopeFromSnapshot(input.snapshot),
        )
      ) {
        return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      }
    }
    if (input.resuming) {
      const after = await this.verifyInRunAuth(grant, 'recovery', input.snapshot)
      const passed = after.authState === 'AUTHENTICATED' && after.identityState === 'MATCH'
      if (!passed) {
        this.authGateClosed.add(grant.leaseId)
        return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
      }
      this.authGateClosed.delete(grant.leaseId)
      if (live) await this.retargetVideoForLease(live, grant.leaseId)
      return { ok: true }
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
    // 先备齐凭据与句柄再占预算：拿不到凭据时不该白计一次自动登录。
    const credential = await this.resolveLoginCredential(input.snapshot)
    if (!credential || !live || !target) {
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    const occupied = await occupyAutoLoginBudget(this.dbHandle, {
      targetId: input.snapshot.targetId,
      targetAccountId: input.snapshot.targetAccountId,
    })
    if (!occupied.ok) {
      return waiting(occupied.code as SessionErrorCode, occupied.message)
    }
    const accountId = input.snapshot.targetAccountId
    const recordOutcome = async (result: 'success' | 'credential' | 'verify_failed') => {
      const liveAuth = await readLiveSessionAuth(this.dbHandle).catch(() => null)
      if (!liveAuth) return
      await recordAutoLoginOutcome(this.dbHandle, {
        targetAccountId: accountId,
        result,
        sessionAuth: liveAuth.sessionAuth,
      }).catch(() => undefined)
    }
    let after: Pick<AuthObservation, 'authState' | 'identityState'>
    let submitted: boolean
    try {
      await this.verifyInRunAuth(grant, 'recovery', input.snapshot)
      if (input.snapshot.targetAccountId) {
        await recordAuthAttemptStarted(this.dbHandle, {
          id: grant.sessionId,
          targetId: input.snapshot.targetId,
          targetAccountId: input.snapshot.targetAccountId,
          generation: grant.generation,
        })
      }
      submitted = await submitLoginCredentials(
        live.handle,
        target,
        credential,
        input.snapshot.authVerification?.loginTimeoutMs,
      )
      after = await this.verifyInRunAuth(grant, 'recovery', input.snapshot)
    } catch {
      // 预算已计次：结果不可观察也必须补记一次失败，否则 consecutiveFailures 不增长、熔断永不触发。
      await recordOutcome('verify_failed')
      this.authGateClosed.add(grant.leaseId)
      return { ok: false, unrecoverable: true, code: 'AUTH_CONTEXT_NOT_RECOVERABLE', runStatus: 'FAILED' }
    }
    const passed =
      submitted && after.authState === 'AUTHENTICATED' && after.identityState === 'MATCH'
    await recordOutcome(passed ? 'success' : after.identityState === 'MISMATCH' ? 'credential' : 'verify_failed')
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
    if (live) await this.retargetVideoForLease(live, grant.leaseId)
    return { ok: true }
  }

export async function launchAndOpen(this: SessionManagerContext, 
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
      this.lives.set(created.id, emptyLive(handle, created.id, created.generation))
      await this.attachSessionAuthObserver(created.id)
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

export async function waitInterruptible(this: SessionManagerContext, ms: number, runId: string, signal?: AbortSignal): Promise<void> {
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

export async function ensureProfileAuth(this: SessionManagerContext, 
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
      await recordAuthAttemptStarted(db, session)
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

export async function ensureAuth(this: SessionManagerContext, 
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
    // LEGACY 先核验再登录。inspectAuthOnPage 在「没有密码框、也不像登录 URL」
    // 时默认 AUTHENTICATED，新会话（UNKNOWN）不能凭这个启发式短路：manual /
    // 缺字段 / 缺口令 / 错密都会被当成已登录，AUTH_WAIT 永远进不去。
    // 已有认证履历的会话（EXPIRED 或 AUTHENTICATED）才允许用 probe 复用 cookie，
    // 避免已登录站点被再次填表、表单找不到后误判进人工等待。
    const probed = await probeAuth(live.handle, targetInfo)
    signal?.throwIfAborted()
    await setSessionProbe(db, {
      sessionId: session.id,
      ...this.ownerScope(),
      authState: probed,
    })
    const established = session.authState === 'AUTHENTICATED' || session.authState === 'EXPIRED'
    if (probed === 'AUTHENTICATED' && established) {
      return { ok: true, session: (await getSessionById(db, session.id))! }
    }

    signal?.throwIfAborted()
    const missingFields =
      !targetInfo.loginFields?.username ||
      !targetInfo.loginFields?.password ||
      !targetInfo.loginFields?.submit

    const isSupportedCaptcha =
      targetInfo.captchaMode === 'image' ||
      targetInfo.captchaMode === 'graphic' ||
      targetInfo.captchaMode === 'slider' ||
      Boolean(targetInfo.captcha)

    const needsManual =
      targetInfo.authMethod === 'manual' ||
      (targetInfo.captchaMode !== 'none' && !isSupportedCaptcha) ||
      missingFields

    if (needsManual) {
      // 表 D7：manual / unsupported captcha / 缺 loginFields 均记 SESSION_AUTH_UNSUPPORTED 并等待人工
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

    const username = credential.username
    const liveAuth = await readLiveSessionAuth(db).catch(() => null)
    const loginTarget = applySessionAuthToTarget(targetInfo, liveAuth?.sessionAuth)
    const maxAttempts = isSupportedCaptcha ? Math.max(1, loginTarget.captchaMaxAttempts ?? 2) : 1
    // 这层 for 循环才是验证码重试预算的唯一持有者；submitLoginCredentials 内部还会按
    // target.captchaMaxAttempts 再循环一次，两层都读同一个配置值会让实际提交次数变成
    // maxAttempts²（默认 2×2=4 次），直接违反"最多重试 captchaMaxAttempts 次"的预算承诺。
    // 这里把内层预算显式收紧到 1，确保外层每迭代一次只真实提交一次表单。
    const singleAttemptTarget = isSupportedCaptcha ? { ...loginTarget, captchaMaxAttempts: 1 } : loginTarget
    let ok = false
    const challengeAudit: ChallengeAuditRecord = {
      challengeId: randomUUID(),
      sessionId: session.id,
      runId: run.runId,
      challengeType: targetInfo.captchaMode === 'slider' ? 'SLIDER_CAPTCHA' : 'IMAGE_CAPTCHA',
      handledBy: 'MACHINE',
      attemptsUsed: 0,
      success: false,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    }
    const startTime = Date.now()

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted()
      await recordAuthAttemptStarted(db, session, {
        runId: run.runId,
        attempt,
        maxAttempts,
        challengeType: isSupportedCaptcha ? challengeAudit.challengeType : undefined,
      })
      if (isSupportedCaptcha) {
        challengeAudit.attemptsUsed = attempt
        challengeAudit.timestamp = new Date().toISOString()
        await appendRunEvents(db, run.runId, [
          { type: 'run.captcha_attempted', payload: challengeAudit },
        ]).catch(() => undefined)
      }
      const loginResult = await attemptLoginWithCredentials(live.handle, singleAttemptTarget, {
        username,
        password: credential.password,
      })
      ok = loginResult.authenticated
      if (isSupportedCaptcha) {
        const outcome =
          ok
            ? 'success'
            : loginResult.submit === 'ambiguous'
              ? 'ambiguous'
              : loginResult.submit === 'credential_failed'
                ? 'credential_failed'
                : 'captcha_failed'
        challengeAudit.success = ok
        challengeAudit.durationMs = Date.now() - startTime
        await recordCaptchaLoginAttempt(db, {
          key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
          sessionId: session.id,
          generation: session.generation,
          runId: run.runId,
          attempt,
          maxAttempts,
          challengeType: challengeAudit.challengeType,
          outcome,
          audit: challengeAudit,
        }).catch(() => undefined)
      }
      if (credential.secretId) {
        await recordCredentialVerification(db, {
          secretId: credential.secretId,
          sessionId: session.id,
          sessionGeneration: session.generation,
          source: 'run',
          sourceId: run.runId,
          outcome: ok ? 'verified' : 'failed',
          submittedPassword: true,
        }).catch(() => undefined)
      }
      if (ok) {
        if (isSupportedCaptcha) {
          challengeAudit.success = true
          challengeAudit.durationMs = Date.now() - startTime
          await appendRunEvents(db, run.runId, [
            { type: 'run.captcha_solved', payload: challengeAudit },
          ]).catch(() => undefined)
        }
        break
      }
      if (isSupportedCaptcha && !shouldContinueCaptchaRetry(loginResult)) break
    }
    signal?.throwIfAborted()
    if (!ok && isSupportedCaptcha) {
      challengeAudit.success = false
      challengeAudit.durationMs = Date.now() - startTime
      await appendRunEvents(db, run.runId, [
        { type: 'run.captcha_escalated', payload: challengeAudit },
      ]).catch(() => undefined)
    }
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
        isSupportedCaptcha
          ? { ...targetInfo, captchaHumanWaitSeconds: loginTarget.captchaHumanWaitSeconds }
          : targetInfo,
      )
    }
    return { ok: true, session: (await getSessionById(db, session.id))! }
  }

function pageUrlOf(page: { url?: () => string; isClosed?: () => boolean } | undefined): string | undefined {
  if (!page || page.isClosed?.()) return undefined
  try {
    return typeof page.url === 'function' ? page.url() : undefined
  } catch {
    return undefined
  }
}

function findPageAlreadyOnLogin(
  live: LiveHandle,
  loginUrl: string,
): import('playwright').Page | undefined {
  const seen = new Set<import('playwright').Page>()
  const candidates: Array<import('playwright').Page | undefined> = [
    ...[...live.pages.values()].map((entry) => entry.page),
    live.lastPage,
    live.handle.basePage,
  ]
  for (const page of candidates) {
    if (!page || seen.has(page)) continue
    seen.add(page)
    if (pageLooksLikeLogin({ pageUrl: pageUrlOf(page), loginUrl })) return page
  }
  return undefined
}

function remountRunPage(live: LiveHandle, runId: string, leaseId: string) {
  const pageId = live.currentPageIdByRun.get(runId)
  if (pageId) live.currentPageIdByLease.set(leaseId, pageId)
}

async function prepareLoginPageForAuthWait(
  this: SessionManagerContext,
  live: LiveHandle,
  runId: string,
  occupancy: SessionGrant,
  target?: { entryUrl: string; loginUrl?: string | null },
): Promise<void> {
  const loginUrl = target?.loginUrl ?? target?.entryUrl
  if (!loginUrl) return
  const already = findPageAlreadyOnLogin(live, loginUrl)
  if (already) {
    this.adoptPage(live, runId, already, already === live.handle.basePage ? 'base' : 'run', occupancy.leaseId)
    return
  }
  const entry = this.ensureRunPage(live, runId, occupancy.leaseId)
  if (!entry?.page) return
  if ((await this.renew(occupancy.leaseId)) !== 'ok') {
    this.logger.warn(
      { sessionId: live.sessionId, runId, loginUrl, workerId: this.options.workerId },
      'session.auth_wait_login_nav_skipped',
    )
    return
  }
  try {
    await this.withHeldOccupancy(
      occupancy.leaseId,
      {
        sessionId: occupancy.sessionId,
        generation: occupancy.generation,
        sessionFencingToken: occupancy.sessionFencingToken,
      },
      () => gotoPage(entry.page, loginUrl),
    )
  } catch (error) {
    this.logger.warn(
      {
        sessionId: live.sessionId,
        runId,
        loginUrl,
        workerId: this.options.workerId,
        err: error instanceof Error ? error.message : String(error),
      },
      'session.auth_wait_login_nav_failed',
    )
  }
}

export async function enterWaitingForAuth(this: SessionManagerContext, 
    session: SessionRecord,
    runGrant: RunGrant,
    policy: SessionPolicy,
    occupancy: SessionGrant,
    code: SessionErrorCode,
    message: string,
    target?: { entryUrl: string; loginUrl?: string | null; captchaHumanWaitSeconds?: number },
  ): Promise<{ ok: false; code: SessionErrorCode; message: string; waitingForAuth: boolean }> {
    const db = this.dbHandle
    const live = this.lives.get(session.id)
    if (live) {
      await prepareLoginPageForAuthWait.call(this, live, runGrant.runId, occupancy, target)
    }
    const waitGrant = await enterRunWaitingForAuth(db, {
      grant: runGrant,
      sessionId: session.id,
      workerId: this.options.workerId,
      workerInstanceId: this.workerInstanceId,
      holdSeconds: target?.captchaHumanWaitSeconds ?? policy.authWaitSeconds,
      leaseTtlSeconds: policy.leaseTtlSeconds,
    })
    if (!waitGrant) {
      this.logger.warn(
        { sessionId: session.id, runId: runGrant.runId, workerId: this.options.workerId, code },
        'session.auth_wait_rejected',
      )
      return { ok: false, code: 'SESSION_NOT_CLAIMABLE', message: '未能转入认证等待', waitingForAuth: false }
    }
    if (waitGrant.leaseId !== occupancy.leaseId) {
      this.rebindVideoForLease(occupancy.leaseId, waitGrant.leaseId)
      const authState = this.runAuth.get(occupancy.leaseId)
      if (authState) {
        this.runAuth.delete(occupancy.leaseId)
        this.runAuth.set(waitGrant.leaseId, authState)
      }
      this.unbindOccupancy(occupancy.leaseId)
      this.bindOccupancy(waitGrant, runGrant.runId, policy.leaseTtlSeconds)
    }
    if (live) {
      remountRunPage(live, runGrant.runId, waitGrant.leaseId)
      if (!findPageAlreadyOnLogin(live, target?.loginUrl ?? target?.entryUrl ?? '')) {
        await prepareLoginPageForAuthWait.call(this, live, runGrant.runId, waitGrant, target)
      }
      live.autoInputClosed = true
      live.inputAccepting = false
      for (const [leaseId, mapped] of this.leaseToRun) {
        if (mapped === runGrant.runId) await this.stopTracingForLease(leaseId, session.id)
      }
      const snapshot = this.runAuth.get(waitGrant.leaseId)?.snapshot
      if (snapshot) {
        await this.startVideoForLease(waitGrant.leaseId, session.id, snapshot)
        await this.retargetVideoForLease(live, waitGrant.leaseId)
      }
    }
    this.logger.log(
      { sessionId: session.id, runId: runGrant.runId, workerId: this.options.workerId, code },
      'session.auth_changed',
    )
    return { ok: false, code, message, waitingForAuth: true }
  }

export async function resolveLoginCredential(this: SessionManagerContext, 
    run: RunSnapshot,
  ): Promise<{ username: string; password: string; secretId?: string } | null> {
    if (this.resolveCredential) {
      return this.resolveCredential(run)
    }
    if (!this.secrets) return null
    const grant = await resolveSnapshotCredential(this.dbHandle, run)
    if (!grant || grant.provider !== LOCAL_SECRET_PROVIDER) return null
    const row = await loadSecretCiphertext(this.dbHandle, grant.secretId)
    if (!row) return null
    try {
      return {
        username: grant.username,
        password: this.secrets.decrypt(row.id, row.ciphertext),
        secretId: grant.secretId,
      }
    } catch {
      return null
    }
  }

export async function loadTargetAuth(this: SessionManagerContext, run: RunSnapshot): Promise<
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
        captcha: run.targetAuth.captcha ?? null,
      }
    }
    return {
      entryUrl: row.entryUrl,
      loginUrl: row.loginUrl,
      loginFields: row.loginFields,
      authMethod: row.authMethod,
      captchaMode: row.captchaMode,
      captcha: row.captcha ?? null,
    }
  }

export async function applyReuse(this: SessionManagerContext, 
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
    this.adoptPage(live, session.id, page, 'run')
  }

