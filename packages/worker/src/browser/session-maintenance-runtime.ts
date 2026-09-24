import { existsSync, rmSync } from 'node:fs'
import {
  adoptSessionRetention,
  appendSessionEvent,
  claimSessionUse,
  createSession,
  conflict,
  finishSessionOperation,
  freezeAuthVerificationForRun,
  getSessionOperation,
  invalidateSessionProfile,
  loadAuthProfileRevision,
  markSessionOperationWaitingForAuth,
  occupyAutoLoginBudget,
  abandonSessionKeepAlive,
  readLiveSessionAuth,
  recordAutoLoginOutcome,
  getSessionById,
  loadSecretCiphertext,
  recordCredentialVerification,
  resolveAccountCurrentCredential,
  resolveAccountAuthMaterials,
  scheduleNextAuthCheck,
  setSessionAuthSummary,
  setSessionProbe,
  setSessionStatus,
  transitionSessionUse,
  loadAccountForExecution,
  loadTargetForExecution,
  recordCaptchaLoginAttempt,
  enqueueTakeoverNotification,
  type SessionRecord
} from '@cairn/db'
import {
  type AuthObservation,
  type FrozenAuthVerification,
  isSessionMaintenanceKind,
  classifyLoginWaitReason,
  isUnrecoverableLoginWait,
  planAuthEnsure,
  shouldSubmitStoredCredentials,
  type LoginWaitSubmitState,
  type SessionErrorCode,
  type SessionEventType,
  type SessionGrant
} from '@cairn/shared'
import { profileDirFor } from './profiles'
import { beginOperationProgress, peekOperationProgress, takeOperationProgress } from './operation-progress'
import { verifyAuthProfile } from './session-auth'
import {
  BrowserRuntimeError,
  gotoPage,
  applySessionAuthToTarget,
  attemptLoginCredentials,
  attemptLoginWithCredentials,
  injectStorageState,
  loginWithCredentials,
  probeAuth,
  runWithOccupancy,
  runWithSessionRestart,
  type TargetAuthInfo
} from './runtime'
import { openedEntryDuringVerify } from './landing-settle.js'
import { SessionLeaseError, type LiveHandle, type SessionManagerContext } from './session-live.js'
import { shouldContinueCaptchaRetry } from './captcha/login-outcome.js'

async function settleAfterMaintenanceLogin(
  ctx: SessionManagerContext,
  session: SessionRecord,
  operation: { id: string },
  grant: SessionGrant | null,
  alreadyOpenedEntry?: boolean,
): Promise<void> {
  await ctx.settleOccupiedLanding({
    session,
    grant,
    trigger: 'after_login',
    alreadyOpenedEntry,
    operationId: operation.id,
  })
}

function maintenanceCaughtErrorCode(error: unknown, loginSubmitted: boolean): string {
  if (loginSubmitted) return 'OUTCOME_UNKNOWN'
  if (error instanceof SessionLeaseError || error instanceof BrowserRuntimeError) return error.code
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  if (
    code === 'PLATFORM_CONFIG_SCHEMA_UNSUPPORTED' ||
    code === 'PLATFORM_CONFIG_UNREADABLE' ||
    (error instanceof Error && error.message.includes('schemaVersion'))
  ) {
    return 'PLATFORM_CONFIG_UNREADABLE'
  }
  return 'OPERATION_INTERRUPTED'
}

export async function attachValidationOperation(this: SessionManagerContext, input: {
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
      if (!waitGrant) {
        throw new SessionLeaseError('SESSION_NOT_CLAIMABLE', '未能转入认证等待')
      }
      this.unbindOccupancy(input.grant.leaseId)
      this.bindOccupancy(waitGrant, input.operation.id, this.options.defaultLeaseTtlSeconds)
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

export async function verifyOccupiedOwner(this: SessionManagerContext, ownerId: string): Promise<AuthObservation> {
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
      if (verification.capability === 'LEGACY' || !verification.profileRevision) {
        if (!target) throw conflict('SESSION_TARGET_MISSING', '目标系统不存在')
        const probed = await probeAuth(live.handle, {
          entryUrl: target.entryUrl,
          loginUrl: target.loginUrl,
          loginFields: target.loginFields,
        })
        return persistLegacyObservation(this, session, probed)
      }
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

const inFlightCompleteAuth = new Set<string>()

export async function completeOccupiedAuth(this: SessionManagerContext, 
    ownerId: string,
    _input?: { actorId: string; token?: string },
  ): Promise<AuthObservation> {
    if (inFlightCompleteAuth.has(ownerId)) {
      throw conflict('VERIFICATION_IN_FLIGHT', '登录核验正在进行中，请稍候')
    }
    inFlightCompleteAuth.add(ownerId)
    try {
      const sessionId = this.liveSessionIdForOwner(ownerId)
      const liveBefore = sessionId ? this.lives.get(sessionId) : undefined
      const page = liveBefore
        ? this.ensureRunPage(liveBefore, ownerId).page
        : undefined
      const urlBefore = page && typeof page.url === 'function' ? page.url() : ''
      let observation = await this.verifyOccupiedOwner(ownerId)

      // 5~8s 宽限期轮询：若首轮未就绪，最多等待重试 3 次，适应 SPA 登录跳转网络延迟
      if (observation.authState !== 'AUTHENTICATED') {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 1500))
          observation = await this.verifyOccupiedOwner(ownerId)
          if (observation.authState === 'AUTHENTICATED') break
        }
      }

      const operation = await getSessionOperation(this.dbHandle, ownerId)
      if (operation && isSessionMaintenanceKind(operation.kind)) {
        if (observation.authState !== 'AUTHENTICATED') {
          throw conflict('AUTH_STILL_REQUIRED', '尚未检测到登录成功，请在页面中确认并提交')
        }
        const session = sessionId ? await getSessionById(this.dbHandle, sessionId) : null
        const live = sessionId ? this.lives.get(sessionId) : undefined
        if (live) {
          live.autoInputClosed = false
          live.inputAccepting = false
        }
        if (session && observation.identityState !== 'MISMATCH') {
          const urlAfter = page && typeof page.url === 'function' ? page.url() : ''
          const target = await loadTargetForExecution(this.dbHandle, operation.targetId).catch(() => null)
          await this.settleOccupiedLanding({
            session,
            page,
            trigger: 'after_login',
            alreadyOpenedEntry: target
              ? openedEntryDuringVerify(urlBefore, urlAfter, target.entryUrl)
              : false,
            operationId: operation.id,
          })
        }
        await this.finishMaintenance(
          operation.id,
          { targetId: operation.targetId, targetAccountId: operation.targetAccountId },
          'SUCCEEDED',
          { type: 'auth.verified', sessionId: session?.id, generation: session?.generation },
        )
        const leaseId = [...this.leaseToRun.entries()].find(([, mapped]) => mapped === ownerId)?.[0]
        if (leaseId) await this.release(leaseId, 'auth_completed').catch(() => undefined)
      }
      return observation
    } finally {
      inFlightCompleteAuth.delete(ownerId)
    }
  }

function borrowedAuthWaitOwner(input: {
  reusedRunId: string | null
  operation: { kindParams?: Record<string, unknown> | null }
}): string | null {
  if (input.reusedRunId) return input.reusedRunId
  const reusedOperationId = input.operation.kindParams?.reusedOperationId
  return typeof reusedOperationId === 'string' && reusedOperationId.length > 0 ? reusedOperationId : null
}

export async function attachMaintenanceOperation(this: SessionManagerContext, input: {
    operation: {
      id: string
      kind: string
      targetId: string
      targetAccountId: string
      origin?: string
      kindParams?: Record<string, unknown> | null
      attemptNo?: number
      createdAt?: Date | null
    }
    grant: SessionGrant | null
    session: SessionRecord | null
    reusedRunId: string | null
    acquire?: { reason: string; profileFallback: boolean; accountSlot: number } | null
  }): Promise<void> {
    const db = this.dbHandle
    const key = { targetId: input.operation.targetId, targetAccountId: input.operation.targetAccountId }
    const borrowedOwner = borrowedAuthWaitOwner(input)
    if (input.reusedRunId) {
      await appendSessionEvent(db, {
        key,
        type: 'operation.claimed',
        operationId: input.operation.id,
        runId: input.reusedRunId,
        payload: { kind: input.operation.kind, reusedRunId: input.reusedRunId },
      })
      // LOGIN 加入 Run 的 AUTH_WAIT 只挂接；刷新登录页必须真的打开登录页，且不得拆掉等待占用。
      if (input.operation.kind !== 'REFRESH_LOGIN_PAGE') return
    } else {
      await appendSessionEvent(db, {
        key,
        type: 'operation.claimed',
        sessionId: input.session?.id ?? input.grant?.sessionId ?? null,
        generation: input.session?.generation ?? input.grant?.generation ?? null,
        operationId: input.operation.id,
        payload: {
          kind: input.operation.kind,
          workerId: this.options.workerId,
          ...(input.operation.attemptNo != null ? { attemptNo: input.operation.attemptNo } : {}),
        },
      })
    }
    const progress = beginOperationProgress(db, {
      key,
      operationId: input.operation.id,
      kind: input.operation.kind,
      background: input.operation.origin === 'BACKGROUND',
      createdAt: input.operation.createdAt ?? null,
      sessionId: input.session?.id ?? input.grant?.sessionId ?? null,
      generation: input.session?.generation ?? input.grant?.generation ?? null,
    })
    if (input.acquire) {
      await progress.mark('session_acquired', {
        detail: {
          acquireReason: input.acquire.reason,
          accountSlot: input.acquire.accountSlot,
          profileFallback: input.acquire.profileFallback,
        },
      })
    }
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
        await invalidateSessionProfile(db, {
          ...key,
          accountSlot: input.session?.accountSlot ?? 1,
        })
        const dir = profileDirFor(this.options.profileRoot, key, input.session?.accountSlot ?? 1)
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
          reclaimMode: predecessor.reclaimMode,
          keepAliveSeconds: predecessor.keepAliveSeconds,
          authProbeIntervalSeconds: predecessor.authProbeIntervalSeconds,
          evictionPriority: predecessor.evictionPriority,
        })
        if (!created.ok) {
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, created.code)
          return
        }
        await adoptSessionRetention(db, { fromSessionId: predecessor.id, toSessionId: created.session.id })
        const launchStartedAt = Date.now()
        const launched = await runWithSessionRestart(created.session.id, () =>
          this.launchAndOpen(created.session, key),
        )
        if (!launched.ok) {
          await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, launched.code)
          return
        }
        progress.bindSession(launched.session)
        await progress.mark('browser_launched', { durationMs: Date.now() - launchStartedAt })
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
          reclaimMode: launched.session.reclaimMode,
          keepAliveSeconds: launched.session.keepAliveSeconds,
          authProbeIntervalSeconds: launched.session.authProbeIntervalSeconds,
          evictionPriority: launched.session.evictionPriority,
          touchLastUsed: false,
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
      if (!borrowedOwner) {
        this.bindOccupancy(input.grant, input.operation.id, this.options.defaultLeaseTtlSeconds)
      }
      await runWithOccupancy(input.grant, async () => {
        let session = input.session!
        if (!this.lives.has(session.id)) {
          const launchStartedAt = Date.now()
          let launched = await this.launchAndOpen(session, key)
          if (!launched.ok && launched.code === 'SESSION_NOT_CLAIMABLE') {
            this.logger.warn(
              {
                operationId: input.operation.id,
                sessionId: session.id,
                expiresAt: input.grant?.expiresAt,
                message: launched.message,
              },
              '启动会话缺少占用，按当前 grant 再试一次',
            )
            launched = await runWithOccupancy(input.grant!, () => this.launchAndOpen(session, key))
          }
          if (!launched.ok) {
            if (!borrowedOwner) await this.abandonOccupancy(input.grant!.leaseId, 'launch_failed')
            throw new SessionLeaseError(launched.code, launched.message)
          }
          session = launched.session
          progress.bindSession(session)
          await progress.mark('browser_launched', { durationMs: Date.now() - launchStartedAt })
        } else {
          await progress.mark('browser_reused')
        }
        const live = this.lives.get(session.id)
        if (live) this.ensureRunPage(live, borrowedOwner ?? input.operation.id, input.grant!.leaseId)

        if (input.operation.kind === 'SETTLE_LANDING') {
          const page = live
            ? this.ensureRunPage(live, input.operation.id, input.grant!.leaseId).page
            : undefined
          await this.settleOccupiedLanding({
            session,
            grant: input.grant,
            page,
            trigger: 'manual',
            operationId: input.operation.id,
          })
          if (!borrowedOwner) await this.abandonOccupancy(input.grant!.leaseId, 'settle_done')
          await this.finishMaintenance(input.operation.id, key, 'SUCCEEDED', {
            type: 'operation.finished',
            sessionId: session.id,
            generation: session.generation,
          })
          return
        }

        if (input.operation.kind === 'REFRESH_LOGIN_PAGE') {
          const target = await loadTargetForExecution(db, key.targetId)
          const loginUrl = target?.loginUrl ?? target?.entryUrl
          const page = live
            ? this.ensureRunPage(live, borrowedOwner ?? input.operation.id, input.grant!.leaseId).page
            : undefined
          const current = page && typeof page.url === 'function' ? page.url() : ''
          if (
            !loginUrl ||
            !page ||
            !this.isSafeLoginRefresh(current, loginUrl, target?.entryUrl ?? null, {
              allowSameOrigin: Boolean(borrowedOwner),
            })
          ) {
            if (!borrowedOwner) await this.abandonOccupancy(input.grant!.leaseId, 'refresh_unsafe')
            await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, 'PAGE_REFRESH_UNSAFE')
            return
          }
          await gotoPage(page, loginUrl).catch(() => undefined)
          if (!borrowedOwner) await this.abandonOccupancy(input.grant!.leaseId, 'refresh_done')
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
        if (auth.ok) await revealPreparedPage(this, session, input.operation)
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
      this.logger.error(
        {
          operationId: input.operation.id,
          kind: input.operation.kind,
          message: error instanceof Error ? error.message : String(error),
        },
        '会话维护失败',
      )
      const code = maintenanceCaughtErrorCode(error, attempt.loginSubmitted)
      if (attempt.loginSubmitted && input.session) {
        await this.markMaintenanceOutcomeUnknown(input.session, input.operation)
      }
      if (occupiedGrant && !borrowedOwner) {
        await this.abandonOccupancy(occupiedGrant.leaseId, code).catch(() => undefined)
      }
      await this.finishMaintenance(input.operation.id, key, 'FAILED', undefined, code)
    }
  }

export async function markSessionLost(this: SessionManagerContext, sessionId: string, reason: string): Promise<void> {
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

export async function markMaintenanceOutcomeUnknown(this: SessionManagerContext, 
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

export async function finishMaintenance(this: SessionManagerContext, 
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
    const written = await finishSessionOperation(this.dbHandle, {
      operationId,
      workerId: this.options.workerId,
      workerInstanceId: this.workerInstanceId,
      status,
      errorCode,
    })
    const progress = takeOperationProgress(operationId)
    // 终态已被别人写过（迟到结果）：状态不覆盖，账本也不能追加一条自相矛盾的收尾事件。
    if (!written) return
    // 后台操作的阶段事件只在失败时补写，且须排在收尾事件之前。
    await progress?.flush(status === 'FAILED')
    const payload = {
      status,
      errorCode: errorCode ?? null,
      ...(progress
        ? {
            kind: progress.input.kind,
            workerId: this.options.workerId,
            durationMs: progress.elapsedMs(),
            ...(progress.queuedMs != null ? { queuedMs: progress.queuedMs } : {}),
          }
        : {}),
    }
    // 认证结论可以单独入账，但操作生命周期必须落 operation.finished，否则使用记录会停在「执行中」。
    if (event?.type && event.type !== 'operation.finished') {
      await appendSessionEvent(this.dbHandle, {
        key,
        type: event.type,
        sessionId: event.sessionId,
        generation: event.generation,
        operationId,
        payload,
      })
    }
    await appendSessionEvent(this.dbHandle, {
      key,
      type: 'operation.finished',
      sessionId: event?.sessionId,
      generation: event?.generation,
      operationId,
      payload,
    })
  }

export async function runMaintenanceAuth(this: SessionManagerContext, 
    session: SessionRecord,
    operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string },
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
      return runLegacyMaintenanceAuth.call(this, session, operation, grant, mode, attempt, target)
    }
    const profile = await loadAuthProfileRevision(db, operation.targetId, verification.profileRevision)
    if (!profile) return { ok: false, code: 'AUTH_PROFILE_REQUIRED' }

    const verifyOnce = async () => {
      const verified = await verifyAuthProfile(live.handle, { definition: profile.definition, verification })
      await this.persistProfileObservation(session, verification, verified)
      return verified.observation
    }

    const probeStartedAt = Date.now()
    const observation = await verifyOnce()
    await peekOperationProgress(operation.id)?.mark('auth_probed', {
      durationMs: Date.now() - probeStartedAt,
      detail: {
        authState: observation.authState,
        identityState: observation.identityState ?? null,
        via: 'auth_profile',
      },
    })
    const passed =
      observation.authState === 'AUTHENTICATED' &&
      (verification.capability !== 'IDENTITY_VERIFIED' || observation.identityState === 'MATCH')

    if (operation.kind === 'RENEW_AUTH' && profile.definition.renew === 'verify_slides') {
      return passed ? { ok: true } : { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    }
    if (mode === 'verify') {
      if (passed) return { ok: true }
      const backgroundKeepAlive =
        operation.origin === 'BACKGROUND' &&
        session.reclaimMode === 'AUTH_DRIVEN' &&
        session.keepAliveUntil != null &&
        session.keepAliveUntil.getTime() > Date.now()
      if (!backgroundKeepAlive) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
      const credential = await this.resolveAccountCredential(operation.targetAccountId)
      if (!credential) {
        await abandonSessionKeepAlive(db, session.id)
        return { ok: false, code: 'SESSION_KEEPALIVE_ABANDONED' }
      }
      const occupied = await occupyAutoLoginBudget(db, {
        targetId: operation.targetId,
        targetAccountId: operation.targetAccountId,
      })
      if (!occupied.ok) {
        await abandonSessionKeepAlive(db, session.id)
        return { ok: false, code: 'SESSION_KEEPALIVE_ABANDONED' }
      }
      await appendSessionEvent(db, {
        key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
        type: 'auth.attempt_started',
        sessionId: session.id,
        generation: session.generation,
        payload: { origin: 'BACKGROUND', kind: operation.kind },
      }).catch(() => undefined)
      const loginResult = await attemptLoginCredentials(
        live.handle,
        applySessionAuthToTarget(
          {
            entryUrl: target.entryUrl,
            loginUrl: target.loginUrl,
            loginFields: target.loginFields,
            loginLeaveTimeoutMs: target.loginLeaveTimeoutMs,
          },
          liveAuth.sessionAuth,
        ),
        credential,
        verification.loginTimeoutMs,
      )
      const submitted = loginResult.submit !== 'not_attempted'
      if (attempt && submitted) attempt.loginSubmitted = true
      if (loginResult.authenticated) {
        try {
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
          if (credential.secretId) {
            await recordCredentialVerification(db, {
              secretId: credential.secretId,
              sessionId: session.id,
              sessionGeneration: session.generation,
              source: 'maintenance',
              sourceId: operation.id,
              outcome:
                after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH'
                  ? 'verified'
                  : 'failed',
              submittedPassword: true,
            }).catch(() => undefined)
          }
          if (after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH') {
            await settleAfterMaintenanceLogin(this, session, operation, grant)
            return { ok: true }
          }
        } catch {
          await this.markMaintenanceOutcomeUnknown(session, operation)
          return { ok: false, code: 'OUTCOME_UNKNOWN' }
        }
      }
      return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    }
    const isSupportedCaptcha =
      target.captchaMode === 'image' ||
      target.captchaMode === 'slider' ||
      String(target.captchaMode) === 'graphic' ||
      Boolean(target.captcha)
    const requiresHumanAuth =
      target.authMethod === 'manual' ||
      (target.captchaMode !== 'none' && !isSupportedCaptcha)
    if (passed) return { ok: true }
    if (requiresHumanAuth || observation.identityState === 'MISMATCH') {
      if (!grant) {
        return {
          ok: false,
          code: observation.identityState === 'MISMATCH' ? 'AUTH_IDENTITY_MISMATCH' : 'SESSION_AUTH_UNSUPPORTED',
        }
      }
      return enterMaintenanceAuthWait(this, session, operation, grant, target, live, {
        reason: observation.identityState === 'MISMATCH' ? 'AUTH_IDENTITY_MISMATCH' : 'SESSION_AUTH_UNSUPPORTED',
      })
    }
    const shouldLogin =
      operation.kind === 'LOGIN' ||
      operation.kind === 'PREPARE' ||
      (operation.kind === 'RENEW_AUTH' && profile.definition.renew === 'relogin')
    const planned = planAuthEnsure({
      capability: verification.capability,
      fresh: false,
      observation,
      infraAttempts: 0,
      backoffSeconds: verification.verifyRetryBackoffSeconds ?? [],
    })
    const plan = shouldSubmitStoredCredentials({
      plan: planned,
      capability: verification.capability,
      skipBackoffWait: true,
    })
      ? { action: 'auto_login' as const }
      : planned
    if (plan.action === 'reuse') return { ok: true }
    let submitted: boolean | undefined
    let submit: LoginWaitSubmitState | undefined
    let waitReason: SessionErrorCode | undefined
    if (shouldLogin && plan.action === 'auto_login') {
      const credential = await this.resolveAccountCredential(operation.targetAccountId)
      if (!credential) {
        if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
        return enterMaintenanceAuthWait(this, session, operation, grant, target, live, {
          reason: 'SESSION_AUTH_UNSUPPORTED',
        })
      }
      const occupied = await occupyAutoLoginBudget(db, {
        targetId: operation.targetId,
        targetAccountId: operation.targetAccountId,
      })
      if (!occupied.ok) {
        waitReason = (occupied.code as SessionErrorCode) ?? 'AUTH_AUTO_LOGIN_PAUSED'
      } else {
        await appendSessionEvent(db, {
          key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
          type: 'auth.attempt_started',
          sessionId: session.id,
          generation: session.generation,
          payload: { kind: operation.kind },
        }).catch(() => undefined)
        const loginResult = await attemptLoginCredentials(
          live.handle,
          applySessionAuthToTarget(
            {
              entryUrl: target.entryUrl,
              loginUrl: target.loginUrl,
              loginFields: target.loginFields,
              loginLeaveTimeoutMs: target.loginLeaveTimeoutMs,
            },
            liveAuth.sessionAuth,
          ),
          credential,
          verification.loginTimeoutMs,
        )
        submitted = loginResult.submit !== 'not_attempted'
        submit = loginResult.submit
        if (attempt && submitted) attempt.loginSubmitted = true
        if (loginResult.authenticated) {
          try {
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
            if (credential.secretId) {
              await recordCredentialVerification(db, {
                secretId: credential.secretId,
                sessionId: session.id,
                sessionGeneration: session.generation,
                source: 'maintenance',
                sourceId: operation.id,
                outcome:
                  after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH'
                    ? 'verified'
                    : 'failed',
                submittedPassword: true,
              }).catch(() => undefined)
            }
            if (after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH') {
              await settleAfterMaintenanceLogin(this, session, operation, grant)
              return { ok: true }
            }
          } catch {
            await this.markMaintenanceOutcomeUnknown(session, operation)
            return { ok: false, code: 'OUTCOME_UNKNOWN' }
          }
        } else if (submitted) {
          const liveAfter = await readLiveSessionAuth(db)
          await recordAutoLoginOutcome(db, {
            targetAccountId: operation.targetAccountId,
            result: loginResult.submit === 'credential_failed' ? 'credential' : 'verify_failed',
            sessionAuth: liveAfter.sessionAuth,
          }).catch(() => undefined)
        }
      }
    }

    if (!grant) {
      return {
        ok: false,
        code: waitReason ?? (plan.action === 'manual' ? plan.code : 'SESSION_AUTH_UNSUPPORTED'),
      }
    }
    return enterMaintenanceAuthWait(this, session, operation, grant, target, live, {
      submitted,
      submit,
      reason: waitReason ?? (submit === 'credential_failed' ? 'credential' : undefined),
    })
  }

async function persistLegacyObservation(
  ctx: SessionManagerContext,
  session: SessionRecord,
  authState: 'AUTHENTICATED' | 'EXPIRED',
): Promise<AuthObservation> {
  const observation: AuthObservation = {
    authState,
    identityState: 'UNVERIFIED',
    observedIdentity: null,
    unknownClass: null,
    evidenceSummary: null,
    authProfileRevision: null,
    diagnosticCode: authState === 'AUTHENTICATED' ? 'verified' : 'legacy_unauthenticated',
  }
  await setSessionAuthSummary(ctx.dbHandle, {
    sessionId: session.id,
    ...ctx.ownerScope(),
    authState,
    identityState: 'UNVERIFIED',
    lastAuthError: authState === 'AUTHENTICATED' ? null : 'legacy_unauthenticated',
    authProfileRevision: null,
    observedTier: 'LEGACY',
    recordSuccess: authState === 'AUTHENTICATED',
  })
  await setSessionProbe(ctx.dbHandle, {
    sessionId: session.id,
    ...ctx.ownerScope(),
    health: 'HEALTHY',
    authState,
  })
  return observation
}

function isVisibleHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 复用已登录态时页面可能仍是 about:blank，受管画面要对着目标入口才有东西可指认。 */
export async function revealPreparedPage(
  ctx: SessionManagerContext,
  session: { id: string },
  operation: { id: string; kind: string; targetId: string },
): Promise<void> {
  if (operation.kind !== 'PREPARE' && operation.kind !== 'LOGIN') return
  const live = ctx.lives.get(session.id)
  if (!live) return
  const target = await loadTargetForExecution(ctx.dbHandle, operation.targetId)
  const dest = target?.entryUrl?.trim()
  if (!dest || !isVisibleHttpUrl(dest)) return
  const page = ctx.ensureRunPage(live, operation.id).page
  const current = typeof page.url === 'function' ? page.url() : ''
  if (isVisibleHttpUrl(current)) return
  await gotoPage(page, dest).catch(() => undefined)
}

async function enterMaintenanceAuthWait(
  ctx: SessionManagerContext,
  session: SessionRecord,
  operation: { id: string; kind: string; targetId: string; targetAccountId: string },
  grant: SessionGrant,
  target: { entryUrl: string; loginUrl?: string | null },
  live: LiveHandle,
  options?: { waitSeconds?: number; submitted?: boolean; submit?: LoginWaitSubmitState; reason?: string },
): Promise<'waiting' | { ok: false; code: SessionErrorCode }> {
  const loginUrl = target.loginUrl ?? target.entryUrl
  const page = loginUrl ? ctx.ensureRunPage(live, operation.id, grant.leaseId).page : undefined
  if (loginUrl && page) {
    await gotoPage(page, loginUrl).catch(() => undefined)
  }
  const pageUrl = typeof page?.url === 'function' ? page.url() : ''
  const waitReason = classifyLoginWaitReason({
    pageUrl,
    submitted: options?.submitted,
    submit: options?.submit,
    fallback: options?.reason,
  })
  await setSessionAuthSummary(ctx.dbHandle, {
    sessionId: session.id,
    ...ctx.ownerScope(),
    authState: session.authState ?? 'UNKNOWN',
    identityState: session.identityState ?? 'UNVERIFIED',
    lastAuthError: waitReason,
    authProfileRevision: session.authProfileRevision ?? null,
    observedTier: session.observedTier ?? null,
    recordSuccess: false,
  }).catch(() => undefined)
  if (isUnrecoverableLoginWait(waitReason)) {
    return { ok: false, code: 'LOGIN_PAGE_UNREACHABLE' }
  }
  const targetPolicy = (target as { sessionPolicy?: { unattendedAuthTimeoutSeconds?: number; notifyOnAuthWait?: boolean } })?.sessionPolicy
  const waitSeconds =
    options?.waitSeconds ??
    ((operation as { originContext?: string }).originContext === 'UNATTENDED'
      ? (targetPolicy?.unattendedAuthTimeoutSeconds ?? (target as { unattendedAuthTimeoutSeconds?: number })?.unattendedAuthTimeoutSeconds ?? 120)
      : ctx.options.defaultAuthWaitSeconds)
  const waitGrant = await transitionSessionUse(ctx.dbHandle, {
    sessionId: session.id,
    fromPurpose: 'MAINTENANCE',
    toPurpose: 'AUTH_WAIT',
    owner: { kind: 'SESSION_OPERATION', operationId: operation.id },
    holderWorkerId: ctx.options.workerId,
    holderInstanceId: ctx.workerInstanceId,
    leaseTtlSeconds: ctx.options.defaultLeaseTtlSeconds,
    waitSeconds,
    reason: 'maintenance_auth',
  })
  if (!waitGrant) return { ok: false, code: 'SESSION_NOT_CLAIMABLE' }
  ctx.unbindOccupancy(grant.leaseId)
  ctx.bindOccupancy(waitGrant, operation.id, ctx.options.defaultLeaseTtlSeconds)
  live.autoInputClosed = true
  live.inputAccepting = false
  await markSessionOperationWaitingForAuth(ctx.dbHandle, {
    operationId: operation.id,
    workerId: ctx.options.workerId,
  })
  await appendSessionEvent(ctx.dbHandle, {
    key: { targetId: operation.targetId, targetAccountId: operation.targetAccountId },
    type: 'operation.waiting_for_auth',
    sessionId: session.id,
    generation: session.generation,
    operationId: operation.id,
    payload: { kind: operation.kind, reason: waitReason },
  })
  if (targetPolicy?.notifyOnAuthWait || (target as { notifyOnAuthWait?: boolean })?.notifyOnAuthWait) {
    const expiresAt = new Date(Date.now() + waitSeconds * 1000)
    await enqueueTakeoverNotification(ctx.dbHandle, {
      targetId: operation.targetId,
      targetAccountId: operation.targetAccountId,
      targetName: (target as { name?: string })?.name ?? operation.targetId,
      accountDisplayName: (target as { accountDisplayName?: string })?.accountDisplayName ?? operation.targetAccountId,
      operationId: operation.id,
      sessionId: session.id,
      expiresAt,
      reason: waitReason,
    }).catch(() => undefined)
  }
  return 'waiting'
}

async function loginLegacyMaintenance(
  ctx: SessionManagerContext,
  session: SessionRecord,
  operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string },
  attempt: { loginSubmitted: boolean } | undefined,
  target: TargetAuthInfo,
  live: LiveHandle,
): Promise<
  | { ok: true }
  | { ok: false; code?: SessionErrorCode; submitted?: boolean; submit?: LoginWaitSubmitState }
> {
  const credential = await ctx.resolveAccountCredential(operation.targetAccountId)
  if (!credential) {
    if (operation.origin === 'BACKGROUND') {
      await abandonSessionKeepAlive(ctx.dbHandle, session.id)
      return { ok: false, code: 'SESSION_KEEPALIVE_ABANDONED' }
    }
    return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
  }
  if (credential.storageState) {
    await injectStorageState(live.handle.context, credential.storageState)
    try {
      await live.handle.basePage.goto(target.entryUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      const probed = await probeAuth(live.handle, target)
      if (probed === 'AUTHENTICATED') {
        return { ok: true }
      }
    } catch {
      // 探活未通过，平滑降级至常规登录
    }
  }
  const occupied = await occupyAutoLoginBudget(ctx.dbHandle, {
    targetId: operation.targetId,
    targetAccountId: operation.targetAccountId,
  })
  if (!occupied.ok) {
    if (operation.origin === 'BACKGROUND') {
      await abandonSessionKeepAlive(ctx.dbHandle, session.id)
      return { ok: false, code: 'SESSION_KEEPALIVE_ABANDONED' }
    }
    return { ok: false, code: (occupied.code as SessionErrorCode) ?? 'AUTH_AUTO_LOGIN_PAUSED' }
  }
  await appendSessionEvent(ctx.dbHandle, {
    key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
    type: 'auth.attempt_started',
    sessionId: session.id,
    generation: session.generation,
    payload: { origin: operation.origin ?? 'USER', kind: operation.kind },
  }).catch(() => undefined)
  const captchaRetries =
    target.captchaMode === 'image' ||
    target.captchaMode === 'slider' ||
    String(target.captchaMode) === 'graphic' ||
    Boolean(target.captcha)
  const liveAuth = await readLiveSessionAuth(ctx.dbHandle).catch(() => null)
  const loginTarget = applySessionAuthToTarget(
    {
      entryUrl: target.entryUrl,
      loginUrl: target.loginUrl,
      loginFields: target.loginFields,
      loginLeaveTimeoutMs: target.loginLeaveTimeoutMs,
      captchaMode: target.captchaMode,
      captcha: target.captcha,
    },
    liveAuth?.sessionAuth,
  )
  const maxAttempts = captchaRetries ? Math.max(1, loginTarget.captchaMaxAttempts ?? 2) : 1
  // 同 session-claim.ts：这层循环是验证码重试预算的唯一持有者，loginWithCredentials 内部
  // 会按同一个 captchaMaxAttempts 再循环一次，不收紧到 1 会让实际提交次数变成 maxAttempts²。
  const singleAttemptTarget = captchaRetries ? { ...loginTarget, captchaMaxAttempts: 1 } : loginTarget
  let ok = false
  let lastSubmit: LoginWaitSubmitState = 'not_attempted'
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
    const loginResult = await attemptLoginWithCredentials(live.handle, singleAttemptTarget, credential)
    lastSubmit = loginResult.submit
    ok = loginResult.authenticated
    if (captchaRetries) {
      const outcome =
        ok
          ? 'success'
          : loginResult.submit === 'ambiguous'
            ? 'ambiguous'
            : loginResult.submit === 'credential_failed'
              ? 'credential_failed'
              : 'captcha_failed'
      await recordCaptchaLoginAttempt(ctx.dbHandle, {
        key: { targetId: operation.targetId, targetAccountId: operation.targetAccountId },
        sessionId: session.id,
        generation: session.generation,
        operationId: operation.id,
        attempt: attemptNo,
        maxAttempts,
        challengeType: target.captchaMode === 'slider' ? 'SLIDER_CAPTCHA' : 'IMAGE_CAPTCHA',
        outcome,
        audit: {
          challengeId: operation.id,
          sessionId: session.id,
          challengeType: target.captchaMode === 'slider' ? 'SLIDER_CAPTCHA' : 'IMAGE_CAPTCHA',
          handledBy: 'MACHINE',
          attemptsUsed: attemptNo,
          success: ok,
          durationMs: 0,
          timestamp: new Date().toISOString(),
        },
      }).catch(() => undefined)
    }
    if (ok) break
    if (captchaRetries && !shouldContinueCaptchaRetry(loginResult)) break
  }
  if (attempt) attempt.loginSubmitted = lastSubmit !== 'not_attempted'
  await persistLegacyObservation(ctx, session, ok ? 'AUTHENTICATED' : 'EXPIRED')
  const liveAfter = await readLiveSessionAuth(ctx.dbHandle)
  await recordAutoLoginOutcome(ctx.dbHandle, {
    targetAccountId: operation.targetAccountId,
    result: ok ? 'success' : lastSubmit === 'credential_failed' ? 'credential' : 'verify_failed',
    sessionAuth: liveAfter.sessionAuth,
  })
  if (ok) {
    await settleAfterMaintenanceLogin(ctx, session, operation, null)
    return { ok: true }
  }
  return {
        ok: false,
        code: 'SESSION_AUTH_UNSUPPORTED',
        submitted: lastSubmit !== 'not_attempted',
        submit: lastSubmit,
      }
}

async function runLegacyMaintenanceAuth(
  this: SessionManagerContext,
  session: SessionRecord,
  operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string },
  grant: SessionGrant | null,
  mode: 'verify' | 'ensure',
  attempt: { loginSubmitted: boolean } | undefined,
  target: TargetAuthInfo & { authMethod?: string; captchaMode?: string },
): Promise<{ ok: true } | { ok: false; code?: SessionErrorCode } | 'waiting'> {
  const live = this.lives.get(session.id)
  if (!live) return { ok: false, code: 'SESSION_NOT_CLAIMABLE' }
  const probeStartedAt = Date.now()
  const probed = await probeAuth(live.handle, {
    entryUrl: target.entryUrl,
    loginUrl: target.loginUrl,
    loginFields: target.loginFields,
  })
  await peekOperationProgress(operation.id)?.mark('auth_probed', {
    durationMs: Date.now() - probeStartedAt,
    detail: { authState: probed, via: 'page_heuristic' },
  })
  await persistLegacyObservation(this, session, probed)
  // 与领取路径一致：inspectAuthOnPage 在看不到密码框、也不像登录 URL 时默认
  // AUTHENTICATED。新会话（UNKNOWN）不能凭这个启发式短路，否则缺字段的 hash
  // 登录页会被写成就绪。
  // EXPIRED 只说明上次看过这页，不能和启发式 AUTHENTICATED 叠成「已经登录」。
  if (probed === 'AUTHENTICATED' && session.authState === 'AUTHENTICATED') return { ok: true }

  if (mode === 'verify') {
    const backgroundKeepAlive =
      operation.origin === 'BACKGROUND' &&
      session.reclaimMode === 'AUTH_DRIVEN' &&
      session.keepAliveUntil != null &&
      session.keepAliveUntil.getTime() > Date.now()
    if (!backgroundKeepAlive) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    return loginLegacyMaintenance(this, session, operation, attempt, target, live)
  }

  const isSupportedCaptcha =
    target.captchaMode === 'image' ||
    target.captchaMode === 'slider' ||
    String(target.captchaMode) === 'graphic' ||
    Boolean(target.captcha)
  const needsManual =
    target.authMethod === 'manual' ||
    (target.captchaMode !== 'none' && !isSupportedCaptcha)
  if (needsManual) {
    if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    return enterMaintenanceAuthWait(this, session, operation, grant, target, live, {
      reason: 'SESSION_AUTH_UNSUPPORTED',
    })
  }

  const shouldLogin =
    operation.kind === 'LOGIN' || operation.kind === 'PREPARE' || operation.kind === 'RENEW_AUTH'
  if (shouldLogin) {
    const logged = await loginLegacyMaintenance(this, session, operation, attempt, target, live)
    if (logged.ok) return logged
    if (!grant) return logged
    const liveAuth = await readLiveSessionAuth(this.dbHandle).catch(() => null)
    const submit = 'submit' in logged ? logged.submit : undefined
    return enterMaintenanceAuthWait(this, session, operation, grant, target, live, {
      waitSeconds: isSupportedCaptcha ? liveAuth?.sessionAuth.captchaHumanWaitSeconds : undefined,
      submitted: logged.submitted ?? attempt?.loginSubmitted,
      submit,
      reason:
        submit === 'credential_failed'
          ? 'credential'
          : submit && submit !== 'not_attempted'
            ? 'AUTH_PROBE_UNKNOWN'
            : logged.code,
    })
  }
  if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
  return enterMaintenanceAuthWait(this, session, operation, grant, target, live)
}

export async function persistProfileObservation(this: SessionManagerContext, 
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

export async function resolveAccountCredential(
  this: SessionManagerContext, 
  accountId: string,
): Promise<{
  username: string
  password: string
  totpSecret?: string
  storageState?: unknown
  secretId?: string
} | null> {
  if (!this.secrets) return null
  const materials = await resolveAccountAuthMaterials(this.dbHandle, accountId)
  if (!materials) return null

  let password = ''
  if (materials.passwordSecretId) {
    const row = await loadSecretCiphertext(this.dbHandle, materials.passwordSecretId)
    if (row && row.provider === 'local') {
      try {
        password = this.secrets.decrypt(row.id, row.ciphertext)
      } catch {}
    }
  }

  let totpSecret: string | undefined
  if (materials.totpSecretId) {
    const row = await loadSecretCiphertext(this.dbHandle, materials.totpSecretId)
    if (row && row.provider === 'local') {
      try {
        totpSecret = this.secrets.decrypt(row.id, row.ciphertext)
      } catch {}
    }
  }

  let storageState: unknown
  if (materials.storageStateSecretId) {
    const row = await loadSecretCiphertext(this.dbHandle, materials.storageStateSecretId)
    if (row && row.provider === 'local') {
      try {
        const decrypted = this.secrets.decrypt(row.id, row.ciphertext)
        storageState = JSON.parse(decrypted)
      } catch {}
    }
  }

  return {
    username: materials.username,
    password,
    totpSecret,
    storageState,
    secretId: materials.passwordSecretId,
  }
}

