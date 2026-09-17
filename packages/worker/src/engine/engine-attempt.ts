import {
  finishAttempt,
  loadRunDetail,
  loadRunRow,
  markRunCancelled,
  startAttempt,
  type FinishAttemptInput,
} from '@cairn/db'
import {
  CANCELLED_ATTEMPT_ERROR,
  authGateClosedError,
  jsonValueSchema,
  resolveEvidencePolicy,
  type DebugMode,
  type DebugOverlay,
  type JsonValue,
  type MapFactBatchItem,
  type MapRunSourceType,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import { isAbortError, type EngineClock } from './clock.js'
import { persistBeforeObservation, buildAfterMapFacts, type CapturePhaseBudget } from '../map/passive-capture.js'
import { planCandidateFailure, planCandidateHalt, planCandidateSuccess } from './engine-candidate-plan.js'
import { chargedAttemptCount, contextValue, evidencePayloadForStep, sessionLeaseFor } from './engine-step-plan.js'
import { shouldNeedsReview, shouldRetry } from './engine-decisions.js'
import { collectAttemptOutcomeResults } from './outcome-collector.js'
import {
  collectErrorSurfaceResults,
  ERROR_SURFACE_VIOLATED,
  mergeErrorSurfaceOutput,
  shouldProbeErrorSurface,
} from './error-surface.js'
import type { AttemptOutcome, ExecutorOutcome } from './engine-types.js'
import type { ExecutionEngine } from './engine.js'

export type CompleteAttemptInput = {
  runId: string
  grant: RunGrant
  step: Step
  stepRunId: string
  stepOrdinal: number
  attemptId: string
  attemptNo: number
  input: JsonValue
  policy: { timeoutMs: number; retryLimit: number }
  last: boolean
  context: Record<string, JsonValue>
  sessionGrant?: SessionGrant
  targetId: string
  stop: AbortSignal
  /** 见 execute 里的同名闭包：停机中止不写终态 */
  yielding: () => boolean
  clock: EngineClock
  secrets: readonly string[]
  evidencePolicy: ReturnType<typeof resolveEvidencePolicy>
  snapshot: RunSnapshot
  taint: { hung: boolean }
  debugMode: DebugMode
  overlay?: DebugOverlay | null
  mapSourceType: MapRunSourceType
  mapBudget: CapturePhaseBudget
  authGate?: { restored: boolean }
}

export async function completeAttempt(this: ExecutionEngine, input: CompleteAttemptInput): Promise<AttemptOutcome> {
  const db = this.handle
  let attemptId = input.attemptId
  let attemptNo = input.attemptNo
  let context = input.context

  while (true) {
    // 重试之间也要看取消（D6 的「步骤间隙」），否则取消之后还会再开一次 Attempt。
    if (input.stop.aborted) {
      // 停机：这一轮的 Attempt 还没跑，原样留给接管方收孤儿，不替用户写取消。
      if (input.yielding()) return 'yielded'
      await this.close({
        runId: input.runId,
        attemptId,
        attemptStatus: 'CANCELLED',
        error: CANCELLED_ATTEMPT_ERROR,
        stepRunStatus: 'CANCELLED',
        runStatus: 'CANCELLED',
        cancelPending: true,
        grant: input.grant,
        sessionLease: sessionLeaseFor(input),
        secrets: input.secrets,
      })
      return 'cancelled'
    }

    const skipDispatch = Boolean(input.authGate?.restored)
    if (input.authGate?.restored) input.authGate.restored = false
    let outcome: ExecutorOutcome | undefined
    let mapFacts: MapFactBatchItem[] | undefined
    let beforeMatches: import('@cairn/shared').ErrorSurfaceNode[] | undefined
    if (skipDispatch) {
      outcome = {
        kind: 'failed',
        error: authGateClosedError('not_dispatched'),
        timedOut: false,
        aborted: false,
      }
    } else {
      const before = await persistBeforeObservation({
        db: this.handle,
        grant: input.grant,
        snapshot: input.snapshot,
        step: input.step,
        stepRunId: input.stepRunId,
        attemptId,
        sessionGrant: input.sessionGrant,
        remainingStepMs: input.policy.timeoutMs,
        budget: input.mapBudget,
        sourceType: input.mapSourceType,
        port: this.mapObservation,
        signal: input.stop,
      })
      if (before === 'abort') {
        if (input.yielding()) return 'yielded'
        if (input.stop.aborted) return 'cancelled'
        return 'stopped'
      }

      const probeSurface = async () => {
        if (!input.sessionGrant || !this.browser?.probeErrorSurface) return undefined
        try {
          return await this.browser.probeErrorSurface(input.sessionGrant, input.stop)
        } catch {
          // 探测失败按未观察处理，不得写成干净页 PASS。
          return undefined
        }
      }

      let skipExecutor = false
      if (shouldProbeErrorSurface(input.snapshot, input.step, 'before')) {
        const matches = await probeSurface()
        beforeMatches = matches
        if (matches) {
          const collected = collectErrorSurfaceResults({
            snapshot: input.snapshot,
            stepRunId: input.stepRunId,
            attemptId,
            now: new Date(input.clock.now()),
            matches,
          })
          if (collected.violated && collected.halt) {
            skipExecutor = true
            outcome = {
              kind: 'failed',
              error: ERROR_SURFACE_VIOLATED,
              output: mergeErrorSurfaceOutput(null, { probed: true, matches }),
              timedOut: false,
              aborted: false,
            }
          }
        }
      }

      if (!skipExecutor) {
        const stepStarted = input.clock.now()
        outcome = await this.runExecutor({
          step: input.step,
          input: input.input,
          context,
          timeoutMs: input.policy.timeoutMs,
          stop: input.stop,
          clock: input.clock,
          sessionGrant: input.sessionGrant,
          runId: input.runId,
          stepRunId: input.stepRunId,
          attemptId,
          targetId: input.targetId,
          evidencePolicy: input.evidencePolicy,
          grant: input.grant,
          snapshot: input.snapshot,
        })
        const remainingAfter = Math.max(0, input.policy.timeoutMs - (input.clock.now() - stepStarted))
        mapFacts = await this.collectAfterFacts({
          input,
          attemptId,
          remainingStepMs: remainingAfter,
          extraFacts: outcome.mapFacts,
        })
        if (outcome.hung) input.taint.hung = true
      } else {
        mapFacts = await this.collectAfterFacts({
          input,
          attemptId,
          remainingStepMs: input.policy.timeoutMs,
          extraFacts: undefined,
        })
      }
    }
    if (!outcome) {
      throw new Error('ENGINE_ATTEMPT_OUTCOME_MISSING')
    }

    let surfaceMatches: import('@cairn/shared').ErrorSurfaceNode[] | undefined
    if (!skipDispatch && shouldProbeErrorSurface(input.snapshot, input.step, 'after') && outcome.kind === 'success') {
      if (input.sessionGrant && this.browser?.probeErrorSurface) {
        try {
          surfaceMatches = await this.browser.probeErrorSurface(input.sessionGrant, input.stop)
        } catch {
          surfaceMatches = undefined
        }
      }
    } else if (outcome.output && typeof outcome.output === 'object' && 'errorSurface' in outcome.output) {
      const raw = (outcome.output as { errorSurface?: { matches?: import('@cairn/shared').ErrorSurfaceNode[] } }).errorSurface
      surfaceMatches = raw?.matches
    } else if (beforeMatches) {
      surfaceMatches = beforeMatches
    }

    const surfaceCollected = surfaceMatches
      ? collectErrorSurfaceResults({
          snapshot: input.snapshot,
          stepRunId: input.stepRunId,
          attemptId,
          now: new Date(input.clock.now()),
          matches: surfaceMatches,
        })
      : undefined
    if (surfaceCollected && outcome.kind === 'success') {
      outcome = {
        ...outcome,
        output: mergeErrorSurfaceOutput(outcome.output, { probed: true, matches: surfaceMatches ?? [] }),
      }
    }

    const { outcomeResults: stepOutcomeResults, continueMode } = collectAttemptOutcomeResults({
      snapshot: input.snapshot,
      step: input.step,
      outcome,
      attemptId,
      now: new Date(input.clock.now()),
    })
    const outcomeResults = [...stepOutcomeResults, ...(surfaceCollected?.results ?? [])]
    const haltAfterSurface =
      Boolean(surfaceCollected?.halt && surfaceCollected.violated && outcome.kind === 'success')

    // 成功也要看写入结果：取消请求抢先到达时 finishAttempt 会把它改写成取消，此时必须停手。
    // 在 continue 模式下，即便断言失败也视为业务巡检步骤完成，按成功继续下一逻辑步，OutcomeResult 记 FAIL。
    if (outcome.kind === 'success' || continueMode) {
      const stepOutput = outcome.kind === 'success' ? outcome.output : (outcome.output ?? { passed: false })
      if (input.step.outputKey) {
        context = {
          ...context,
          [input.step.outputKey]: jsonValueSchema.parse(contextValue(input.step, stepOutput)),
        }
      }
      const groupPlan = planCandidateSuccess({
        snapshot: input.snapshot,
        stepId: input.step.id,
        context,
        last: input.last,
        detail: await loadRunDetail(db, input.runId),
      })
      if (groupPlan?.context) context = groupPlan.context
      const pause = this.holds.consumePause(input.runId)
      const hold = input.debugMode === 'holdAfterEach' || pause
      const closed = await this.close({
        runId: input.runId,
        attemptId,
        attemptStatus: 'SUCCEEDED',
        output: stepOutput,
        context,
        screenshot: outcome.screenshot,
        trace: outcome.trace,
        stepRunStatus: 'SUCCEEDED',
        runStatus: hold
          ? 'HOLDING'
          : haltAfterSurface
            ? 'FAILED'
            : groupPlan?.last ?? input.last
              ? 'SUCCEEDED'
              : undefined,
        skipRemaining: haltAfterSurface,
        skipStepIds: groupPlan?.skipStepIds,
        selectionDecision: groupPlan?.selectionDecision,
        checkpoint: hold
          ? await this.buildCheckpoint({
              runId: input.runId,
              debugMode: input.debugMode,
              reason: pause ? 'author_pause' : 'step_succeeded',
              stepId: input.step.id,
              stepOrdinal: input.stepOrdinal,
              contextKeys: Object.keys(context),
              sessionGrant: input.sessionGrant,
              grant: input.grant,
              overlay: input.overlay,
            })
          : undefined,
        grant: input.grant,
        sessionLease: sessionLeaseFor(input),
        secrets: input.secrets,
        mapFacts,
        outcomeResults,
      })
      if (!closed) return input.stop.aborted && !input.yielding() ? 'cancelled' : input.yielding() ? 'yielded' : 'stopped'
      if (hold) return 'await_hold'
      if (haltAfterSurface) return 'failed'
      return input.last ? 'completed' : 'next'
    }

    const error = outcome.error
    if (error.code === 'AUTH_GATE_CLOSED') {
      const handled = await this.handleAuthGate({
        ...input,
        attemptId,
        attemptNo,
        context,
        outcome,
        mapFacts,
      })
      if (handled.kind === 'retry') {
        attemptId = handled.attemptId
        attemptNo = handled.attemptNo
        continue
      }
      return handled.exit
    }
    if (
      outcome.kind === 'needs_review' ||
      shouldNeedsReview(input.step, error, outcome.timedOut, outcome.aborted)
    ) {
      const reviewPlan = planCandidateHalt({
        snapshot: input.snapshot,
        stepId: input.step.id,
        error,
        runStatus: 'NEEDS_REVIEW',
        detail: await loadRunDetail(db, input.runId),
      })
      await this.close({
        runId: input.runId,
        attemptId,
        attemptStatus: 'FAILED',
        error,
        diagnostics: outcome.diagnostics,
        screenshot: outcome.screenshot,
        trace: outcome.trace,
        stepRunStatus: 'FAILED',
        runStatus: 'NEEDS_REVIEW',
        skipStepIds: reviewPlan?.skipStepIds,
        selectionDecision: reviewPlan?.selectionDecision,
        grant: input.grant,
        sessionLease: sessionLeaseFor(input),
        secrets: input.secrets,
        mapFacts,
        outcomeResults,
      })
      return 'stopped'
    }

    // 停机中止。SIDE_EFFECT 已在上面的 needs_review 分支拿到结论，能走到这里的都可安全重跑。
    if (outcome.aborted && !outcome.timedOut && input.yielding()) return 'yielded'

    if (outcome.kind === 'cancelled' || (outcome.aborted && !outcome.timedOut)) {
      await this.close({
        runId: input.runId,
        attemptId,
        attemptStatus: 'CANCELLED',
        error,
        diagnostics: outcome.diagnostics,
        screenshot: outcome.screenshot,
        trace: outcome.trace,
        stepRunStatus: 'CANCELLED',
        runStatus: 'CANCELLED',
        cancelPending: true,
        grant: input.grant,
        sessionLease: sessionLeaseFor(input),
        secrets: input.secrets,
        mapFacts,
        outcomeResults,
      })
      return 'cancelled'
    }

    const retryDetail = await loadRunDetail(db, input.runId)
    const retry = shouldRetry(input.step, error, retryDetail ? chargedAttemptCount(retryDetail, input.stepRunId) : attemptNo, input.policy.retryLimit)
    const hold =
      !retry && (input.debugMode === 'holdOnFailure' || input.debugMode === 'holdAfterEach')
    const failPlan = !retry
      ? planCandidateFailure({
          snapshot: input.snapshot,
          stepId: input.step.id,
          error,
          debugHold: hold,
          detail: retryDetail,
        })
      : undefined
    const closed = await this.close({
      runId: input.runId,
      attemptId,
      attemptStatus: 'FAILED',
      error,
      output: outcome.output,
      diagnostics: outcome.diagnostics,
      screenshot: outcome.screenshot,
      trace: outcome.trace,
      stepRunStatus: retry ? 'RUNNING' : 'FAILED',
      runStatus: retry || failPlan?.keepRunOpen ? undefined : hold ? 'HOLDING' : 'FAILED',
      skipRemaining: !retry && !hold && !failPlan?.keepRunOpen,
      skipStepIds: failPlan?.keepRunOpen ? failPlan.skipStepIds : undefined,
      selectionDecision: failPlan?.selectionDecision,
      checkpoint: hold
        ? await this.buildCheckpoint({
            runId: input.runId,
            debugMode: input.debugMode,
            reason: 'step_failed',
            stepId: input.step.id,
            stepOrdinal: input.stepOrdinal,
            contextKeys: Object.keys(context),
            sessionGrant: input.sessionGrant,
            grant: input.grant,
            overlay: input.overlay,
          })
        : undefined,
      grant: input.grant,
      sessionLease: sessionLeaseFor(input),
      secrets: input.secrets,
      mapFacts,
      outcomeResults,
    })
    if (!closed) return input.stop.aborted && !input.yielding() ? 'cancelled' : input.yielding() ? 'yielded' : 'stopped'
    if (hold) return 'await_hold'
    if (failPlan?.keepRunOpen) return 'next'
    if (!retry) return 'failed'

    const next = await startAttempt(db, {
      runId: input.runId,
      stepRunId: input.stepRunId,
      inputPayload: evidencePayloadForStep(input.step, input.input),
      grant: input.grant,
      secrets: input.secrets,
    })
    if (!next) {
      await this.finishAfterZeroRow(input.runId, input.grant, input.stop, input.yielding)
      return input.stop.aborted && !input.yielding() ? 'cancelled' : input.yielding() ? 'yielded' : 'stopped'
    }
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
    attemptId = next.attemptId
    attemptNo = next.attemptNo
  }
}

export async function runExecutor(
  this: ExecutionEngine,
  input: {
    step: Step
    input: JsonValue
    context: Record<string, JsonValue>
    timeoutMs: number
    stop: AbortSignal
    clock: EngineClock
    sessionGrant?: SessionGrant
    runId: string
    stepRunId: string
    attemptId: string
    targetId: string
    evidencePolicy: ReturnType<typeof resolveEvidencePolicy>
    grant: RunGrant
    snapshot: RunSnapshot
  },
): Promise<ExecutorOutcome> {
  const { step, timeoutMs, stop, clock } = input
  const deadlineAtMs = clock.now() + timeoutMs
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const combined = AbortSignal.any([stop, timeout.signal])
  try {
    const executor = this.registry.get(step.type)
    if (!executor) {
      return {
        kind: 'failed',
        error: {
          code: 'EXECUTOR_NOT_FOUND',
          category: 'VALIDATION',
          retryable: false,
          safeMessage: `未找到步骤类型 [${step.type}] 的执行器`,
        },
        timedOut: false,
        aborted: false,
      }
    }

    const outcome = await executor.execute({
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      targetId: input.targetId,
      step,
      input: input.input,
      context: input.context,
      signal: combined,
      deadlineAtMs,
      clock,
      sessionGrant: input.sessionGrant,
      evidencePolicy: input.evidencePolicy,
      grant: input.grant,
      snapshot: input.snapshot,
    })

    // 执行器可能把中止收成一个普通失败结果返回（AI SDK 会把 abort 包成自己的错误）。
    // 中止判定以引擎自己的信号为准，否则副作用步骤会丢掉 NEEDS_REVIEW 这条处置路径。
    if (outcome.kind === 'success') return { ...outcome, timedOut: false, aborted: false }
    return {
      ...outcome,
      timedOut: (outcome.timedOut ?? false) || (timeout.signal.aborted && !stop.aborted),
      aborted: (outcome.aborted ?? false) || timeout.signal.aborted || stop.aborted,
    }
  } catch (error) {
    const timedOut = timeout.signal.aborted && !stop.aborted
    const aborted = isAbortError(error) || stop.aborted || timeout.signal.aborted
    if (step.effectType === 'SIDE_EFFECT' && aborted) {
      return {
        kind: 'needs_review',
        error: {
          code: timedOut ? 'TIMEOUT' : 'UNKNOWN',
          category: timedOut ? 'TIMEOUT' : 'UNKNOWN',
          retryable: false,
          safeMessage: timedOut ? '副作用步骤超时，结果未确认' : '副作用步骤中止，结果未确认',
        },
        timedOut,
        aborted,
      }
    }
    if (aborted) {
      return {
        kind: timedOut ? 'failed' : 'cancelled',
        error: {
          code: timedOut ? 'TIMEOUT' : 'CANCELLED',
          category: timedOut ? 'TIMEOUT' : 'CANCELLED',
          retryable: timedOut,
          safeMessage: timedOut ? '步骤超时' : '步骤已取消',
        },
        timedOut,
        aborted,
      }
    }
    // 非中止的异常是执行器故障，不是取消：记 EXECUTOR，是否再试交给策略。
    this.logger.error(
      {
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        stepType: step.type,
        message: error instanceof Error ? error.message : String(error),
      },
      '执行器抛出异常',
    )
    return {
      kind: 'failed',
      error: {
        code: 'EXECUTOR_ERROR',
        category: 'EXECUTOR',
        retryable: true,
        safeMessage: '执行器执行失败',
      },
      timedOut: false,
      aborted: false,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function finishAfterZeroRow(
  this: ExecutionEngine,
  runId: string,
  grant: RunGrant,
  stop: AbortSignal,
  yielding: () => boolean,
): Promise<void> {
  const row = await loadRunRow(this.handle, runId)
  if (!row || row.status !== 'RUNNING') return
  if (row.cancelRequestedAt) {
    await markRunCancelled(this.handle, runId, { grant })
    return
  }
  if (stop.aborted && !yielding()) {
    await markRunCancelled(this.handle, runId, { grant })
  }
}

/**
 * 收尾一次 Attempt。
 *
 * 返回 true 表示这次收尾真的落库、且没有被取消请求改写成取消——只有此时才允许继续推进。
 * `updated: false`（Attempt 已被关闭，迟到回调）与 `cancelled: true` 都必须立刻停手。
 */
export async function collectAfterFacts(
  this: ExecutionEngine,
  input: {
    input: {
      grant: RunGrant
      snapshot: RunSnapshot
      step: Step
      stepRunId: string
      sessionGrant?: SessionGrant
      stop: AbortSignal
      mapSourceType: MapRunSourceType
      mapBudget: CapturePhaseBudget
    }
    attemptId: string
    remainingStepMs: number
    extraFacts?: MapFactBatchItem[]
  },
): Promise<MapFactBatchItem[] | undefined> {
  const facts = await buildAfterMapFacts({
    grant: input.input.grant,
    snapshot: input.input.snapshot,
    step: input.input.step,
    stepRunId: input.input.stepRunId,
    attemptId: input.attemptId,
    sessionGrant: input.input.sessionGrant,
    remainingStepMs: input.remainingStepMs,
    budget: input.input.mapBudget,
    sourceType: input.input.mapSourceType,
    port: this.mapObservation,
    signal: input.input.stop,
    extraFacts: input.extraFacts,
  })
  return facts.length > 0 ? facts : undefined
}

/**
 * 收尾一次 Attempt。瞬时失败最多再试 2 次，不重跑 Executor、不重采。
 * 第一次已提交则第二次 `updated: false` 按已收口解释。
 */
export async function close(this: ExecutionEngine, input: FinishAttemptInput): Promise<boolean> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await finishAttempt(this.handle, input)
      if (result.cancelled) {
        this.emitAttemptFinished(input.attemptId, 'CANCELLED', input.error?.code)
        return false
      }
      if (result.updated) {
        this.emitAttemptFinished(input.attemptId, input.attemptStatus, input.error?.code)
        return true
      }
      return attempt > 0 ? this.alreadyClosedContinues(input) : false
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function alreadyClosedContinues(this: ExecutionEngine, input: FinishAttemptInput): Promise<boolean> {
  const detail = await loadRunDetail(this.handle, input.runId)
  const attempt = detail?.stepRuns
    .flatMap((step) => step.attempts)
    .find((item) => item.id === input.attemptId)
  return attempt?.status === 'SUCCEEDED'
}
