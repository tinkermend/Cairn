import {
  failRunValidation,
  loadRunDetail,
  markRunCancelled,
  startAttempt,
  writeRunAuthCheckpoint,
} from '@cairn/db'
import {
  authGateDoesNotConsumeRetry,
  classifyInterruptedAttempt,
  computeContextVersion,
  decideAuthRecovery,
  deriveRecoveryRule,
  isContextRecoverable,
  PROCESS_LOG_EVENTS,
  redactAuthUrl,
  resolveRunAuthRecovery,
  type AuthCheckpoint,
  type DebugMode,
  type DebugOverlay,
  type JsonValue,
  type MapFactBatchItem,
  type ProcessLogExit,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import type { EngineClock } from './clock.js'
import type { BrowserPort } from './ports.js'
import { confirmFromCause, shouldRetry } from './engine-decisions.js'
import { chargedAttemptCount, evidencePayloadForStep, sessionLeaseFor } from './engine-step-plan.js'
import type { ExecutorOutcome } from './engine-types.js'
import type { ExecutionEngine } from './engine.js'

export async function handleAuthGate(
  this: ExecutionEngine,
  input: {
    runId: string
    grant: RunGrant
    step: Step
    stepRunId: string
    stepOrdinal: number
    attemptId: string
    attemptNo: number
    context: Record<string, JsonValue>
    sessionGrant?: SessionGrant
    snapshot: RunSnapshot
    policy: { timeoutMs: number; retryLimit: number }
    last: boolean
    secrets: readonly string[]
    outcome: Exclude<ExecutorOutcome, { kind: 'success' }>
    debugMode: DebugMode
    overlay?: DebugOverlay | null
    input: JsonValue
    stop: AbortSignal
    clock: EngineClock
    mapFacts?: MapFactBatchItem[]
    yielding?: () => boolean
  },
): Promise<
  | { kind: 'leave'; exit: ProcessLogExit }
  | { kind: 'retry'; attemptId: string; attemptNo: number }
> {
  const error = input.outcome.error
  const detail = await loadRunDetail(this.handle, input.runId)
  if (!detail) return { kind: 'leave', exit: 'stopped' }
  const existing = detail.authCheckpoint
  const resuming = existing?.status === 'closed' || existing?.status === 'recovering'
  const classification = resuming ? existing.interruptedClassification : classifyInterruptedAttempt({
    effectType: input.step.effectType,
    dispatched: error.cause?.code !== 'not_dispatched',
  })
  const capability = input.snapshot.authVerification?.capability ?? 'LEGACY'
  const limits = resolveRunAuthRecovery(input.snapshot.runAuthRecovery)
  const rule = deriveRecoveryRule({
    reuse: input.snapshot.sessionPolicy?.reuse,
    entryUrl: input.snapshot.targetAuth?.entryUrl,
    loginUrl: input.snapshot.targetAuth?.loginUrl,
    allowedOrigins: input.snapshot.allowedOrigins,
  })
  const page = input.sessionGrant ? await this.browser?.describeHold?.(input.runId) : undefined
  const confirm = page?.authObservation ?? confirmFromCause(error.cause?.message)
  const contextVersion = await computeContextVersion(detail.context)
  const resumeValid = !resuming || (
    existing.contextVersion === contextVersion && existing.nextStepId === input.step.id &&
    existing.sessionGeneration === input.sessionGrant?.generation &&
    (!existing.pageRef || existing.pageRef.sessionId === input.sessionGrant?.sessionId)
  )
  let decision = resumeValid
    ? (resuming && existing.status === 'recovering' && existing.recoveryKind
        ? { kind: existing.recoveryKind }
        : decideAuthRecovery({
            capability, classification, confirm,
            autoUsed: existing?.autoRecoveriesUsed ?? 0,
            manualUsed: existing?.manualRecoveriesUsed ?? 0,
            limits,
            contextRecoverable: page?.contextRecoverable ?? isContextRecoverable({ rule, pageUrl: page?.url }),
          }))
    : { kind: 'fail' as const, code: 'AUTH_CONTEXT_NOT_RECOVERABLE' as const }
  const base: AuthCheckpoint = resuming ? existing : {
    schemaVersion: 1,
    status: 'closed',
    closedAt: new Date().toISOString(),
    trigger: page?.authSignal ?? {
      kind: 'navigated_to_login', at: new Date().toISOString(),
      summary: redactAuthUrl(page?.url)?.slice(0, 512) ?? '认证门禁已关闭',
    },
    nextStepId: input.step.id, nextOrdinal: input.stepOrdinal,
    interruptedAttemptId: input.attemptId, interruptedClassification: classification,
    contextVersion, contextKeys: Object.keys(detail.context),
    ...(page?.pageRef ? { pageRef: page.pageRef } : {}),
    ...(page?.url ? { url: redactAuthUrl(page.url) } : {}),
    ...(confirm ? { confirmObservation: confirm } : {}),
    ...(input.snapshot.deadlineAt ? { deadlineAt: input.snapshot.deadlineAt } : {}),
    sessionGeneration: input.sessionGrant?.generation ?? 0,
    fencingToken: String(input.grant.fencingToken), recoveryRule: rule, capability,
    autoRecoveriesUsed: existing?.autoRecoveriesUsed ?? 0,
    manualRecoveriesUsed: existing?.manualRecoveriesUsed ?? 0,
  }
  const charged = chargedAttemptCount(detail, input.stepRunId)
  const retryAllowed = authGateDoesNotConsumeRetry(classification) ||
    shouldRetry(input.step, error, charged, input.policy.retryLimit)
  if (decision.kind !== 'review' && decision.kind !== 'fail' && decision.kind !== 'none' && !retryAllowed) {
    decision = { kind: 'fail', code: 'AUTH_CONTEXT_NOT_RECOVERABLE' }
  }
  if (decision.kind === 'review' || decision.kind === 'fail' || decision.kind === 'none') {
    const code = decision.kind === 'fail' ? decision.code : 'AUTH_CONTEXT_NOT_RECOVERABLE'
    await this.close({
      runId: input.runId, attemptId: input.attemptId, attemptStatus: 'FAILED',
      error: decision.kind === 'review' ? error : { code, category: 'VALIDATION', retryable: false,
        safeMessage: code === 'AUTH_RECOVERY_LIMIT' ? '认证恢复次数已用尽，本次运行无法安全续跑' : '登录已失效，本次运行无法安全续跑' },
      diagnostics: input.outcome.diagnostics, screenshot: input.outcome.screenshot, trace: input.outcome.trace,
      stepRunStatus: 'FAILED', runStatus: decision.kind === 'review' ? 'NEEDS_REVIEW' : 'FAILED',
      skipRemaining: decision.kind !== 'review',
      authCheckpoint: { ...base, status: 'unrecoverable', unrecoverableCode: code },
      grant: input.grant, sessionLease: sessionLeaseFor(input), secrets: input.secrets, mapFacts: input.mapFacts,
    })
    return { kind: 'leave', exit: decision.kind === 'review' ? 'stopped' : 'failed' }
  }
  let checkpoint: AuthCheckpoint = decision.kind === 'reopen'
    ? { ...base, status: 'recovered' }
    : resuming && existing.status === 'recovering' ? existing : {
        ...base, status: 'recovering', recoveryKind: decision.kind,
        autoRecoveriesUsed: base.autoRecoveriesUsed + (decision.kind === 'auto' ? 1 : 0),
        manualRecoveriesUsed: base.manualRecoveriesUsed + (decision.kind === 'manual' ? 1 : 0),
      }
  const closed = await this.close({
    runId: input.runId, attemptId: input.attemptId, attemptStatus: 'FAILED', error,
    diagnostics: input.outcome.diagnostics, screenshot: input.outcome.screenshot, trace: input.outcome.trace,
    stepRunStatus: 'RUNNING', authCheckpoint: checkpoint, grant: input.grant,
    sessionLease: sessionLeaseFor(input), secrets: input.secrets, mapFacts: input.mapFacts,
  })
  // 取消、丢失 fencing 或迟到回调，绝不能再执行登录副作用。
  const stopAfterAbort = async () => {
    if (!input.yielding?.()) await markRunCancelled(this.handle, input.runId, { grant: input.grant })
    return { kind: 'leave' as const, exit: (input.yielding?.() ? 'yielded' : 'cancelled') as ProcessLogExit }
  }
  if (!closed) return { kind: 'leave', exit: input.stop.aborted && !input.yielding?.() ? 'cancelled' : 'stopped' }
  if (input.stop.aborted) return stopAfterAbort()
  const fail = async (code: string, runStatus: 'FAILED' | 'NEEDS_REVIEW' = 'FAILED') => {
    await failRunValidation(this.handle, input.runId, { grant: input.grant }, {
      code, category: runStatus === 'NEEDS_REVIEW' ? 'UNKNOWN' : 'VALIDATION', retryable: false,
      safeMessage: code === 'AUTH_RECOVERY_LIMIT' ? '认证恢复次数已用尽，本次运行无法安全续跑' : '当前运行无法安全续跑',
    }, { runStatus, stepRunId: input.stepRunId, skipRemaining: runStatus !== 'NEEDS_REVIEW',
      authCheckpoint: { ...checkpoint, status: 'unrecoverable', unrecoverableCode: code } })
    return { kind: 'leave' as const, exit: (runStatus === 'NEEDS_REVIEW' ? 'stopped' : 'failed') as ProcessLogExit }
  }
  if (decision.kind !== 'reopen') {
    if (!input.sessionGrant || !this.browser?.recoverAuth) return fail('AUTH_CONTEXT_NOT_RECOVERABLE')
    let result: Awaited<ReturnType<NonNullable<BrowserPort['recoverAuth']>>>
    try {
      result = await this.browser.recoverAuth(input.sessionGrant, {
        kind: decision.kind, runGrant: input.grant, snapshot: input.snapshot,
        resuming: existing?.status === 'recovering', signal: input.stop,
      })
      if (!result.ok && 'manualRequired' in result) {
        if (checkpoint.manualRecoveriesUsed >= limits.maxManualRecoveriesPerRun) return fail('AUTH_RECOVERY_LIMIT')
        checkpoint = { ...checkpoint, recoveryKind: 'manual', manualRecoveriesUsed: checkpoint.manualRecoveriesUsed + 1 }
        if (!(await writeRunAuthCheckpoint(this.handle, { runId: input.runId, grant: input.grant, checkpoint }))) return { kind: 'leave', exit: 'stopped' }
        result = await this.browser.recoverAuth(input.sessionGrant, {
          kind: 'manual', runGrant: input.grant, snapshot: input.snapshot, signal: input.stop,
        })
      }
    } catch (error) {
      this.logger.error(
        {
          runId: input.runId,
          workerId: input.grant.holderWorkerId,
          leaseId: input.grant.leaseId,
          stepRunId: input.stepRunId,
          attemptId: input.attemptId,
          message: error instanceof Error ? error.message : String(error),
        },
        '认证恢复失败',
      )
      if (input.stop.aborted) return stopAfterAbort()
      return fail('AUTH_CONTEXT_NOT_RECOVERABLE')
    }
    if (!result.ok) {
      if ('waitingForAuth' in result) {
        this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, {
          runId: input.runId,
          reason: 'waiting_for_auth',
          stepId: input.step.id,
        })
        return { kind: 'leave', exit: 'held' }
      }
      return fail(result.code, 'runStatus' in result ? result.runStatus : 'FAILED')
    }
  }
  const latest = await loadRunDetail(this.handle, input.runId)
  if (input.stop.aborted) return stopAfterAbort()
  if (!latest || latest.status !== 'RUNNING' || latest.cancelRequested) return { kind: 'leave', exit: 'stopped' }
  if (await computeContextVersion(latest.context) !== checkpoint.contextVersion) return fail('AUTH_CONTEXT_NOT_RECOVERABLE')
  if (!(await writeRunAuthCheckpoint(this.handle, { runId: input.runId, grant: input.grant,
    checkpoint: { ...checkpoint, status: 'recovered' } }))) return { kind: 'leave', exit: 'stopped' }
  const next = await startAttempt(this.handle, {
    runId: input.runId, stepRunId: input.stepRunId,
    inputPayload: evidencePayloadForStep(input.step, input.input), grant: input.grant, secrets: input.secrets,
  })
  if (!next) return { kind: 'leave', exit: 'stopped' }
  this.rememberAttempt(next.attemptId, {
    startedAt: input.clock.now(),
    clock: input.clock,
    stepId: input.step.id,
    stepType: input.step.type,
    attemptNo: next.attemptNo,
    runId: input.runId,
    stepRunId: input.stepRunId,
    workerId: input.grant.holderWorkerId,
    leaseId: input.grant.leaseId,
  })
  return { kind: 'retry', attemptId: next.attemptId, attemptNo: next.attemptNo }
}
