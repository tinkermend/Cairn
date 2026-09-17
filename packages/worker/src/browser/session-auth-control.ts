import {
  acquireAuthControl,
  occupancyGrantFromLease,
  conflict,
  failRunValidation,
  findAuthWaitLeaseForRun,
  loadAuthProfileRevision,
  getRun,
  getSessionById,
  hashAuthControlToken,
  heartbeatAuthControl,
  releaseAuthControl,
  resumeRunAfterAuth,
  transitionSessionUse,
  writeRunAuthCheckpoint,
  setSessionAuthSummary,
  appendRunEvents,
  type SessionRecord
} from '@cairn/db'
import {
  type AcquireAuthControlResponse,
  type AuthControlInputReceipt,
  type AuthCheckpoint,
  type BrowserAuthInputCommand,
  authGateClosedError,
  classifyAuthSignals,
  classifyInterruptedAttempt,
  isContextRecoverable,
  pageLooksLikeLogin,
  shouldCloseAuthGate,
  computeContextVersion,
  type AuthObservation,
  type ExecutionError,
  type RecoveryRule,
  type RunSnapshot,
  type SessionGrant
} from '@cairn/shared'
import { verifyAuthProfile } from './session-auth'
import { gotoPage, probeAuth, probeAuthOnPage, runWithOccupancy } from './runtime'
import { refreshScreencastIfStale } from './screencast'
import {
  applyAuthInput,
  enqueueSerial,
  rememberReceipt,
  viewportMatches
} from './managed-helpers'
import { originAllowed, pageRefFor } from './page-identity'
import { type LiveHandle, type SessionManagerContext } from './session-live.js'

export async function acquireRunAuthControl(this: SessionManagerContext, input: {
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

export async function heartbeatRunAuthControl(this: SessionManagerContext, input: {
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

export async function inputRunAuthControl(this: SessionManagerContext, input: {
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

export async function executeAuthInput(this: SessionManagerContext, params: {
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
    // 这里只要认证输入窗口的状态。调用方已经给了 sessionId / live，不必再走一遍
    // lookupRunSession 的会话解析——那会给每次按键多压两三次查询。
    const latestStatus = await this.authWindowStatus(input.runId)
    if (latestStatus !== 'WAITING_FOR_AUTH' || !live.autoInputClosed) {
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
    if (live.allowedOrigins.length > 0 && pageUrl && !originAllowed(pageUrl, live.allowedOrigins, live.accessScope)) {
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

export async function releaseRunAuthControl(this: SessionManagerContext, input: {
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

export async function resumeRunAuth(this: SessionManagerContext, input: {
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

export async function failInRunAuthRecovery(this: SessionManagerContext, 
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


export function expiredAuthObservation(this: SessionManagerContext, summary: string, snapshot?: RunSnapshot): AuthObservation {
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

export async function applyRecoveryRule(this: SessionManagerContext, 
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

export async function restoreAuthGateFromCheckpoint(this: SessionManagerContext, runId: string, grant: SessionGrant): Promise<boolean> {
    const run = await getRun(this.dbHandle, runId)
    const status = run?.authCheckpoint?.status
    if (status === 'recovering' || status === 'closed') {
      this.authGateClosed.add(grant.leaseId)
      return true
    }
    return false
  }

export async function verifyInRunAuth(this: SessionManagerContext, 
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

export async function observeInRunAuth(this: SessionManagerContext, 
    grant: SessionGrant,
    classification: 'dispatched' | 'not_dispatched',
    signal?: AbortSignal,
  ): Promise<ExecutionError | null> {
    // 被动观察同样要读页面，必须在合法占用内进行（不变量 2）。
    // 租约已失效时命令根本没落到页面，无从观察，直接放行给调用方的丢租收口。
    let held: SessionGrant
    try {
      held = this.guard.assertHeld(grant.leaseId, grant)
    } catch {
      return null
    }
    return runWithOccupancy(held, () => this.observeInRunAuthHeld(grant, classification, signal))
  }

export async function observeInRunAuthHeld(this: SessionManagerContext, 
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

