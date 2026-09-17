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
  scheduleNextAuthCheck,
  setSessionAuthSummary,
  setSessionProbe,
  setSessionStatus,
  transitionSessionUse,
  loadAccountForExecution,
  loadTargetForExecution,
  type SessionRecord
} from '@cairn/db'
import {
  type AuthObservation,
  type FrozenAuthVerification,
  isSessionMaintenanceKind,
  type SessionErrorCode,
  type SessionEventType,
  type SessionGrant
} from '@cairn/shared'
import { profileDirFor } from './profiles'
import { verifyAuthProfile } from './session-auth'
import {
  BrowserRuntimeError,
  gotoPage,
  loginWithCredentials,
  probeAuth,
  runWithOccupancy,
  runWithSessionRestart,
  submitLoginCredentials,
  type TargetAuthInfo
} from './runtime'
import { SessionLeaseError, type LiveHandle, type SessionManagerContext } from './session-live.js'

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

export async function completeOccupiedAuth(this: SessionManagerContext, 
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

export async function attachMaintenanceOperation(this: SessionManagerContext, input: {
    operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string; kindParams?: Record<string, unknown> | null }
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
      this.logger.error(
        {
          operationId: input.operation.id,
          kind: input.operation.kind,
          message: error instanceof Error ? error.message : String(error),
        },
        '会话维护失败',
      )
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
    // 终态已被别人写过（迟到结果）：状态不覆盖，账本也不能追加一条自相矛盾的收尾事件。
    if (!written) return
    await appendSessionEvent(this.dbHandle, {
      key,
      type: event?.type ?? 'operation.finished',
      sessionId: event?.sessionId,
      generation: event?.generation,
      operationId,
      payload: { status, errorCode: errorCode ?? null },
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

    const observation = await verifyOnce()
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
      if (attempt && submitted) attempt.loginSubmitted = true
      if (submitted) {
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
          if (after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH') return { ok: true }
        } catch {
          await this.markMaintenanceOutcomeUnknown(session, operation)
          return { ok: false, code: 'OUTCOME_UNKNOWN' }
        }
      }
      return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
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
        await appendSessionEvent(db, {
          key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
          type: 'auth.attempt_started',
          sessionId: session.id,
          generation: session.generation,
          payload: { kind: operation.kind },
        }).catch(() => undefined)
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
        if (attempt && submitted) attempt.loginSubmitted = true
        if (submitted) {
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
            if (after.authState === 'AUTHENTICATED' && after.identityState !== 'MISMATCH') return { ok: true }
          } catch {
            await this.markMaintenanceOutcomeUnknown(session, operation)
            return { ok: false, code: 'OUTCOME_UNKNOWN' }
          }
        }
      }
    }
    }

    if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    return enterMaintenanceAuthWait(this, session, operation, grant, target, live)
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

async function enterMaintenanceAuthWait(
  ctx: SessionManagerContext,
  session: SessionRecord,
  operation: { id: string; kind: string; targetId: string; targetAccountId: string },
  grant: SessionGrant,
  target: { entryUrl: string; loginUrl?: string | null },
  live: LiveHandle,
): Promise<'waiting' | { ok: false; code: SessionErrorCode }> {
  const loginUrl = target.loginUrl ?? target.entryUrl
  if (loginUrl) {
    const page = ctx.ensureRunPage(live, operation.id, grant.leaseId).page
    await gotoPage(page, loginUrl).catch(() => undefined)
  }
  const waitGrant = await transitionSessionUse(ctx.dbHandle, {
    sessionId: session.id,
    fromPurpose: 'MAINTENANCE',
    toPurpose: 'AUTH_WAIT',
    owner: { kind: 'SESSION_OPERATION', operationId: operation.id },
    holderWorkerId: ctx.options.workerId,
    holderInstanceId: ctx.workerInstanceId,
    leaseTtlSeconds: ctx.options.defaultLeaseTtlSeconds,
    waitSeconds: ctx.options.defaultAuthWaitSeconds,
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
    payload: { kind: operation.kind },
  })
  return 'waiting'
}

async function loginLegacyMaintenance(
  ctx: SessionManagerContext,
  session: SessionRecord,
  operation: { id: string; kind: string; targetId: string; targetAccountId: string; origin?: string },
  attempt: { loginSubmitted: boolean } | undefined,
  target: TargetAuthInfo,
  live: LiveHandle,
): Promise<{ ok: true } | { ok: false; code?: SessionErrorCode }> {
  const credential = await ctx.resolveAccountCredential(operation.targetAccountId)
  if (!credential) {
    if (operation.origin === 'BACKGROUND') {
      await abandonSessionKeepAlive(ctx.dbHandle, session.id)
      return { ok: false, code: 'SESSION_KEEPALIVE_ABANDONED' }
    }
    return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
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
    return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
  }
  await appendSessionEvent(ctx.dbHandle, {
    key: { targetId: session.targetId, targetAccountId: session.targetAccountId },
    type: 'auth.attempt_started',
    sessionId: session.id,
    generation: session.generation,
    payload: { origin: operation.origin ?? 'USER', kind: operation.kind },
  }).catch(() => undefined)
  const ok = await loginWithCredentials(
    live.handle,
    {
      entryUrl: target.entryUrl,
      loginUrl: target.loginUrl,
      loginFields: target.loginFields,
    },
    credential,
  )
  if (attempt) attempt.loginSubmitted = true
  await persistLegacyObservation(ctx, session, ok ? 'AUTHENTICATED' : 'EXPIRED')
  const liveAfter = await readLiveSessionAuth(ctx.dbHandle)
  await recordAutoLoginOutcome(ctx.dbHandle, {
    targetAccountId: operation.targetAccountId,
    result: ok ? 'success' : 'verify_failed',
    sessionAuth: liveAfter.sessionAuth,
  })
  return ok ? { ok: true } : { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
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
  const probed = await probeAuth(live.handle, {
    entryUrl: target.entryUrl,
    loginUrl: target.loginUrl,
    loginFields: target.loginFields,
  })
  await persistLegacyObservation(this, session, probed)
  if (probed === 'AUTHENTICATED') return { ok: true }

  if (mode === 'verify') {
    const backgroundKeepAlive =
      operation.origin === 'BACKGROUND' &&
      session.reclaimMode === 'AUTH_DRIVEN' &&
      session.keepAliveUntil != null &&
      session.keepAliveUntil.getTime() > Date.now()
    if (!backgroundKeepAlive) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    return loginLegacyMaintenance(this, session, operation, attempt, target, live)
  }

  const missingFields =
    !target.loginFields?.username || !target.loginFields?.password || !target.loginFields?.submit
  const needsManual = target.authMethod === 'manual' || target.captchaMode !== 'none' || missingFields
  if (needsManual) {
    if (!grant) return { ok: false, code: 'SESSION_AUTH_UNSUPPORTED' }
    return enterMaintenanceAuthWait(this, session, operation, grant, target, live)
  }

  const shouldLogin =
    operation.kind === 'LOGIN' || operation.kind === 'PREPARE' || operation.kind === 'RENEW_AUTH'
  if (shouldLogin) {
    const logged = await loginLegacyMaintenance(this, session, operation, attempt, target, live)
    if (logged.ok) return logged
    if (!grant) return logged
    return enterMaintenanceAuthWait(this, session, operation, grant, target, live)
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

export async function resolveAccountCredential(this: SessionManagerContext, 
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

