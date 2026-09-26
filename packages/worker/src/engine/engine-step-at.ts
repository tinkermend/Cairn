import {
  type FinishAttemptInput,
  loadRunLoopState,
  loadRunStepStates,
  markRunCancelled,
  skipStepRuns,
  startAttempt,
} from '@cairn/db'
import {
  type DebugMode,
  type ExecutionError,
  type JsonValue,
  type MapRunSourceType,
  type ProcessLogExit,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
  stepRunFor,
  resolveStepPolicy,
  PROCESS_LOG_EVENTS,
  type resolveEvidencePolicy,
} from '@cairn/shared'
import type { ExecutionEngine } from './engine.js'
import type { CompleteAttemptInput } from './engine-attempt.js'
import { evidencePayloadForStep, isLastOpenStep, isRunnableStepRun, resolveStepInput, sessionLeaseFor } from './engine-step-plan.js'
import type { CapturePhaseBudget } from '../map/passive-capture.js'
import type { EngineClock } from './clock.js'
import { snapshotForDebugStep } from './debug-step-plan.js'

export type RunStepAtParams = {
  runId: string
  step: Step
  stepIndex: number
  scopePath?: string
  contextView: Record<string, JsonValue>
  snapshot: RunSnapshot
  grant: RunGrant
  secrets: readonly string[]
  evidencePolicy: ReturnType<typeof resolveEvidencePolicy>
  mapSourceType: MapRunSourceType
  mapBudget: CapturePhaseBudget
  sessionGrant?: SessionGrant
  authGate: { restored: boolean }
  consumedPauseBeforeStepIds: Set<string>
  clock: EngineClock
  stop: { signal: AbortSignal; fromDb: AbortSignal }
  yielding: () => boolean
  iterationUpdate?: FinishAttemptInput['iterationUpdate']
  headerFinish?: FinishAttemptInput['headerFinish']
  rootContextToPersist?: Record<string, JsonValue>
  suppressMediaEvidence?: boolean
  isLast?: boolean
  onStepSuccess?: CompleteAttemptInput['onStepSuccess']
}

export type RunStepAtResult = {
  action: ProcessLogExit | 'next' | 'await_hold' | 'retry' | 'skipped'
  sessionMustClose?: boolean
  output?: JsonValue
  error?: ExecutionError
}

export async function runStepAt(
  this: ExecutionEngine,
  params: RunStepAtParams,
): Promise<RunStepAtResult> {
  const db = this.handle
  const {
    runId,
    step: snapshotStep,
    scopePath = '',
    contextView,
    snapshot,
    grant,
    secrets,
    evidencePolicy,
    mapSourceType,
    mapBudget,
    sessionGrant,
    authGate,
    consumedPauseBeforeStepIds,
    clock,
    stop,
    yielding,
    iterationUpdate,
    headerFinish,
    rootContextToPersist,
    suppressMediaEvidence,
    isLast,
    onStepSuccess,
  } = params

  if (stop.signal.aborted) {
    if (!yielding()) await markRunCancelled(db, runId, { grant })
    return { action: yielding() ? 'yielded' : 'cancelled' }
  }

  const current = await loadRunLoopState(db, runId)
  if (!current) {
    return { action: 'stopped' }
  }
  if (current.cancelRequestedAt) {
    await markRunCancelled(db, runId, { grant })
    return { action: 'cancelled' }
  }
  if (current.status !== 'RUNNING' && current.status !== 'HOLDING') {
    return { action: 'stopped' }
  }

  const step = current.debugOverlay?.stepOverrides[snapshotStep.id]?.step ?? snapshotStep

  const debugMode = (current.debugMode ?? 'runThrough') as DebugMode
  const stepRuns = await loadRunStepStates(db, runId, scopePath)
  const stepRun = stepRunFor(stepRuns, step.id, scopePath)
  if (step.disabled) {
    await skipStepRuns(db, runId, [step.id], 'disabled', scopePath)
    return { action: 'skipped' }
  }
  if (!stepRun || !isRunnableStepRun(stepRun)) {
    return { action: 'skipped' }
  }

  const targetStopStepId = this.holds.getStopBeforeStep(runId)
  const isPauseBeforeStep =
    (Boolean(snapshot.pauseBeforeStepId && snapshot.pauseBeforeStepId === step.id) &&
      !consumedPauseBeforeStepIds.has(step.id)) ||
    Boolean(targetStopStepId === step.id)

  if ((isPauseBeforeStep || this.holds.consumePause(runId)) && debugMode !== 'runThrough') {
    if (snapshot.pauseBeforeStepId === step.id) {
      consumedPauseBeforeStepIds.add(step.id)
    }
    if (targetStopStepId === step.id) {
      this.holds.clearStopBeforeStep(runId)
    }
    const heldStep = stepRun
    const entered = await this.holdRun({
      runId,
      grant,
      debugMode,
      reason: 'author_pause',
      stepId: heldStep.stepId,
      stepOrdinal: heldStep.ordinal,
      contextKeys: Object.keys(contextView),
      sessionGrant,
      overlay: current.debugOverlay,
      scopePath,
    })
    if (!entered) {
      return { action: 'stopped' }
    }
    this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, {
      runId,
      reason: 'author_pause',
      stepId: heldStep.stepId,
    })
    const afterHold = await this.awaitHold({
      runId,
      grant,
      stop: stop.signal,
      yielding,
      sessionGrant,
    })
    if (afterHold === 'retry' || afterHold === 'continue') {
      return { action: 'retry' }
    }
    const exit = await this.exitAfterHold(db, runId, yielding)
    return { action: exit }
  }

  const overlayTarget = current.debugOverlay?.stepOverrides[step.id]?.target
  const resolved = resolveStepInput(step, contextView, overlayTarget, runId)
  const started = await startAttempt(db, {
    runId,
    stepRunId: stepRun.id,
    inputPayload: evidencePayloadForStep(step, resolved.input, Boolean(overlayTarget)),
    grant,
    secrets,
  })
  if (!started) {
    await this.finishAfterZeroRow(runId, grant, stop.signal, yielding)
    return { action: stop.signal.aborted && !yielding() ? 'cancelled' : yielding() ? 'yielded' : 'stopped' }
  }
  this.rememberAttempt(started.attemptId, {
    startedAt: clock.now(),
    clock,
    stepId: step.id,
    stepType: step.type,
    attemptNo: started.attemptNo,
    runId,
    stepRunId: stepRun.id,
    workerId: grant.holderWorkerId,
    leaseId: grant.leaseId,
  })

  if (!resolved.ok) {
    await this.close({
      runId,
      attemptId: started.attemptId,
      attemptStatus: 'FAILED',
      error: resolved.error,
      stepRunStatus: 'FAILED',
      runStatus: debugMode === 'runThrough' ? 'FAILED' : 'HOLDING',
      skipRemaining: debugMode === 'runThrough',
      scopePath,
      iterationUpdate,
      headerFinish,
      checkpoint:
        debugMode === 'runThrough'
          ? undefined
          : await this.buildCheckpoint({
              runId,
              debugMode,
              reason: 'step_failed',
              stepId: step.id,
              stepOrdinal: stepRun.ordinal,
              contextKeys: Object.keys(contextView),
              sessionGrant,
              grant,
              overlay: current.debugOverlay,
              scopePath,
            }),
      grant,
      sessionLease: sessionLeaseFor({ step, sessionGrant, grant }),
      secrets,
    })
    if (debugMode === 'runThrough') {
      return { action: 'failed', error: resolved.error }
    }
    this.emitProcess('log', PROCESS_LOG_EVENTS.runHolding, {
      runId,
      reason: 'step_failed',
      stepId: step.id,
    })
    const afterHold = await this.awaitHold({
      runId,
      grant,
      stop: stop.signal,
      yielding,
      sessionGrant,
    })
    // 与重构前的 indexAfterContinue 一致：当前步骤没有成功，「继续」即重跑当前步骤。
    if (afterHold === 'retry' || afterHold === 'continue') return { action: 'retry' }
    const exit = await this.exitAfterHold(db, runId, yielding)
    return { action: exit }
  }

  const attemptSnapshot = snapshotForDebugStep(
    snapshot,
    step.id,
    current.debugOverlay?.stepOverrides[step.id]?.step,
  )
  const policy = resolveStepPolicy(snapshot.policy, step.policy, step.type)
  // 循环作用域内只看本项的记录，不能据此判断整个 Run 是否收尾；收尾交给循环驱动。
  const last = isLast !== undefined ? isLast : scopePath ? false : isLastOpenStep({ stepRuns }, step.id)
  const taint = { hung: false }
  let lastStepOutput: JsonValue | undefined = undefined
  const finished = await this.completeAttempt({
    runId,
    grant,
    step,
    stepRunId: stepRun.id,
    stepOrdinal: stepRun.ordinal,
    attemptId: started.attemptId,
    attemptNo: started.attemptNo,
    input: resolved.input,
    policy,
    last,
    context: contextView,
    sessionGrant,
    targetId: snapshot.targetId,
    snapshot: attemptSnapshot,
    stop: stop.signal,
    yielding,
    clock,
    secrets,
    evidencePolicy,
    taint,
    debugMode,
    overlay: current.debugOverlay,
    mapSourceType,
    mapBudget,
    authGate,
    scopePath,
    iterationUpdate,
    headerFinish,
    rootContextToPersist,
    suppressMediaEvidence,
    onStepSuccess: onStepSuccess
      ? (stepOutput, fullContext, meta) => {
          lastStepOutput = stepOutput
          return onStepSuccess(stepOutput, fullContext, meta)
        }
      : undefined,
  })

  return {
    action: finished,
    sessionMustClose: taint.hung,
    output: lastStepOutput,
  }
}
