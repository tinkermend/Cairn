import {
  type ControlFlowLoopBlock,
  type ExecutionError,
  type JsonValue,
  type MapRunSourceType,
  type ProcessLogExit,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
  evaluateExpression,
  readContextValue,
  type resolveEvidencePolicy,
  stepRunFor,
} from '@cairn/shared'
import {
  formatScopePath,
  loadLoopFrozenItems,
  loadRunIterations,
  loadRunLoopState,
  loadRunStepStates,
  startAttempt,
  failRunValidation,
  settleLoopIteration,
  startIteration,
} from '@cairn/db'
import type { ExecutionEngine } from './engine.js'
import type { CapturePhaseBudget } from '../map/passive-capture.js'
import { isLastOpenStep } from './engine-step-plan.js'
import type { EngineClock } from './clock.js'

export type RunLoopParams = {
  runId: string
  headerStep: Step
  block: ControlFlowLoopBlock
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
}

export type RunLoopResult = {
  exit: ProcessLogExit | 'next'
  lastIndex: number
  sessionMustClose?: boolean
}

async function waitWithCancellation(
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (ms <= 0) return true
  if (signal.aborted) return false
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function runLoop(
  this: ExecutionEngine,
  params: RunLoopParams,
): Promise<RunLoopResult> {
  const db = this.handle
  const {
    runId,
    headerStep,
    block,
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
  } = params

  const bodyStepIds = new Set(block.bodyStepIds)
  const bodySteps = snapshot.steps.filter((s) => bodyStepIds.has(s.id))
  const stepIndices = new Map(snapshot.steps.map((s, idx) => [s.id, idx + 1]))

  let lastIndex = -1
  snapshot.steps.forEach((s, idx) => {
    if (bodyStepIds.has(s.id)) {
      lastIndex = Math.max(lastIndex, idx)
    }
  })
  if (lastIndex < 0) {
    lastIndex = snapshot.steps.findIndex((s) => s.id === headerStep.id)
  }

  const headerIndex = snapshot.steps.findIndex((s) => s.id === headerStep.id)
  const headerOrdinal = headerIndex + 1

  const rootStepStates = await loadRunStepStates(db, runId, '')
  const headerStepRun = stepRunFor(rootStepStates, headerStep.id)
  if (!headerStepRun) {
    return { exit: 'failed', lastIndex }
  }
  if (headerStepRun.status === 'SUCCEEDED') {
    return { exit: 'next', lastIndex }
  }
  if (headerStepRun.status === 'FAILED') {
    return { exit: 'failed', lastIndex }
  }

  let frozenItems: JsonValue[] = []

  // 1. 准备尝试与集合冻结
  if (headerStepRun.status === 'PENDING') {
    const started = await startAttempt(db, {
      runId,
      stepRunId: headerStepRun.id,
      inputPayload: headerStep.input,
      grant,
      secrets,
    })
    if (!started) {
      await this.finishAfterZeroRow(runId, grant, stop.signal, yielding)
      return {
        exit: stop.signal.aborted && !yielding() ? 'cancelled' : yielding() ? 'yielded' : 'stopped',
        lastIndex,
      }
    }
    this.rememberAttempt(started.attemptId, {
      startedAt: clock.now(),
      clock,
      stepId: headerStep.id,
      stepType: headerStep.type,
      attemptNo: started.attemptNo,
      runId,
      stepRunId: headerStepRun.id,
      workerId: grant.holderWorkerId,
      leaseId: grant.leaseId,
    })

    const loopState = await loadRunLoopState(db, runId)
    const currentContext = loopState?.context ?? {}

    if (block.kind === 'for_each') {
      const control = (headerStep.input as any)?.control ?? {}
      const over = control.over
      if (!over || !over.from) {
        await this.close({
          runId,
          attemptId: started.attemptId,
          attemptStatus: 'FAILED',
          stepRunStatus: 'FAILED',
          runStatus: 'FAILED',
          skipRemaining: true,
          error: {
            code: 'LOOP_INPUT_INVALID',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: '逐项遍历缺少 over 引用',
          },
          grant,
          secrets,
        })
        return { exit: 'failed', lastIndex }
      }
      const overRes = readContextValue(currentContext, over.from, over.fromField)
      if (!overRes.ok || !Array.isArray(overRes.value)) {
        await this.close({
          runId,
          attemptId: started.attemptId,
          attemptStatus: 'FAILED',
          stepRunStatus: 'FAILED',
          runStatus: 'FAILED',
          skipRemaining: true,
          error: {
            code: 'LOOP_INPUT_INVALID',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: overRes.ok ? '逐项遍历目标不是列表类型' : overRes.message,
          },
          grant,
          secrets,
        })
        return { exit: 'failed', lastIndex }
      }

      const items = overRes.value
      const serializedTotal = JSON.stringify(items)
      if (Buffer.byteLength(serializedTotal, 'utf8') > 256 * 1024) {
        await this.close({
          runId,
          attemptId: started.attemptId,
          attemptStatus: 'FAILED',
          stepRunStatus: 'FAILED',
          runStatus: 'FAILED',
          skipRemaining: true,
          error: {
            code: 'LOOP_PAYLOAD_TOO_LARGE',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: '循环总集合体积超过 256 KB 上限',
          },
          grant,
          secrets,
        })
        return { exit: 'failed', lastIndex }
      }

      for (const it of items) {
        if (Buffer.byteLength(JSON.stringify(it), 'utf8') > 8 * 1024) {
          await this.close({
            runId,
            attemptId: started.attemptId,
            attemptStatus: 'FAILED',
            stepRunStatus: 'FAILED',
            runStatus: 'FAILED',
            skipRemaining: true,
            error: {
              code: 'LOOP_PAYLOAD_TOO_LARGE',
              category: 'VALIDATION',
              retryable: false,
              safeMessage: '循环单项体积超过 8 KB 上限',
            },
            grant,
            secrets,
          })
          return { exit: 'failed', lastIndex }
        }
      }

      const maxItems = control.maxItems ?? block.limits?.maxItems ?? 50
      if (items.length > maxItems) {
        await this.close({
          runId,
          attemptId: started.attemptId,
          attemptStatus: 'FAILED',
          stepRunStatus: 'FAILED',
          runStatus: 'FAILED',
          skipRemaining: true,
          error: {
            code: 'LOOP_TOO_MANY_ITEMS',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `循环项数 ${items.length} 超过上限 ${maxItems}`,
          },
          grant,
          secrets,
        })
        return { exit: 'failed', lastIndex }
      }

      // 空集合直接成功闭环
      if (items.length === 0) {
        const emptyCollects: Record<string, JsonValue> = {}
        for (const c of block.collect ?? []) {
          emptyCollects[c.into] = []
        }
        const isLastStep = isLastOpenStep({ stepRuns: rootStepStates }, headerStep.id)
        await this.close({
          runId,
          attemptId: started.attemptId,
          attemptStatus: 'SUCCEEDED',
          stepRunStatus: 'SUCCEEDED',
          output: { frozenItems: [] },
          context: { ...currentContext, ...emptyCollects },
          runStatus: isLastStep ? 'SUCCEEDED' : undefined,
          grant,
          secrets,
        })
        return { exit: isLastStep ? 'completed' : 'next', lastIndex }
      }

      frozenItems = items
      const initCollects: Record<string, JsonValue> = {}
      for (const c of block.collect ?? []) {
        initCollects[c.into] = []
      }
      await this.close({
        runId,
        attemptId: started.attemptId,
        attemptStatus: 'SUCCEEDED',
        stepRunStatus: 'RUNNING',
        output: { frozenItems },
        context: { ...currentContext, ...initCollects },
        grant,
        secrets,
      })
    } else {
      // repeat 块
      const initCollects: Record<string, JsonValue> = {}
      for (const c of block.collect ?? []) {
        initCollects[c.into] = []
      }
      await this.close({
        runId,
        attemptId: started.attemptId,
        attemptStatus: 'SUCCEEDED',
        stepRunStatus: 'RUNNING',
        output: { kind: 'repeat' },
        context: { ...currentContext, ...initCollects },
        grant,
        secrets,
      })
    }
  } else if (headerStepRun.status === 'RUNNING') {
    // 续跑：从尝试输出还原冻结集合
    if (block.kind === 'for_each') {
      const items = await loadLoopFrozenItems(db, runId, headerStep.id)
      frozenItems = items ?? []
    }
  }

  // 2. 迭代推进
  const control = (headerStep.input as any)?.control ?? {}
  const totalIterations =
    block.kind === 'for_each'
      ? frozenItems.length
      : (control.maxIterations ?? block.limits?.maxIterations ?? 20)

  const { iterations: existingIterations } = await loadRunIterations(db, runId, {
    blockId: block.blockId,
  })
  const iterationByIndex = new Map(existingIterations.map((it) => [it.iterationIndex, it]))

  let loopSucceeded = false
  let loopFinished = false
  let sessionMustClose = false

  for (let iterIdx = 0; iterIdx < totalIterations; iterIdx++) {
    const existingIter = iterationByIndex.get(iterIdx)
    if (existingIter?.status === 'SUCCEEDED') {
      if (
        (existingIter.stopDecision as any)?.stoppedEarly ||
        (existingIter.stopDecision as any)?.untilMet
      ) {
        loopFinished = true
        loopSucceeded = true
        break
      }
      continue
    }
    if (existingIter?.status === 'FAILED') {
      return { exit: 'failed', lastIndex }
    }

    const scopePath = formatScopePath(headerOrdinal, iterIdx)
    const item = block.kind === 'for_each' ? frozenItems[iterIdx] : undefined
    const initialFrame: Record<string, unknown> = {}
    if (control.as && item !== undefined) initialFrame[control.as] = item
    if (control.indexAs) initialFrame[control.indexAs] = iterIdx

    const startedIter = await startIteration(db, {
      runId,
      blockId: block.blockId,
      headerStepId: headerStep.id,
      headerOrdinal,
      iterationIndex: iterIdx,
      item,
      frame: initialFrame,
      bodySteps,
      stepIndices,
    })

    const currentFrame = { ...(startedIter.iteration.frame as Record<string, JsonValue>) }
    // 本项是否已随某一步的收尾事务一并收尾；没有（末尾步骤停用、全部停用、恢复时已全部收口）则走兜底收尾。
    let iterationFinalized = false

    for (let sIdx = 0; !startedIter.allDisabled && sIdx < bodySteps.length; sIdx++) {
      const bodyStep = bodySteps[sIdx]!

      if (stop.signal.aborted) {
        return { exit: yielding() ? 'yielded' : 'cancelled', lastIndex, sessionMustClose }
      }
      const currentLoopState = await loadRunLoopState(db, runId)
      // 与根循环一致：单步重试时 Run 仍是 HOLDING，由 startAttempt 切回 RUNNING。
      if (!currentLoopState || (currentLoopState.status !== 'RUNNING' && currentLoopState.status !== 'HOLDING')) {
        return { exit: 'stopped', lastIndex, sessionMustClose }
      }

      const contextView: Record<string, JsonValue> = {
        ...currentLoopState.context,
        ...currentFrame,
      }
      if (control.as && item !== undefined) contextView[control.as] = item
      if (control.indexAs) contextView[control.indexAs] = iterIdx

      const rootStepStatesFresh = await loadRunStepStates(db, runId, '')
      const isBounded = snapshot.evidencePolicy?.iterationEvidence === 'bounded'
      const isFirstOrLast =
        iterIdx === 0 || (block.kind === 'for_each' && iterIdx === totalIterations - 1)
      const suppressMedia = isBounded && !isFirstOrLast

      const onStepSuccess = (
        stepOutput: JsonValue | undefined,
        fullContext: Record<string, JsonValue>,
        meta: { endsScope: boolean },
      ) => {
        // 取 completeAttempt 已按步骤类型解包后的上下文值，与根作用域写入的形状一致。
        if (bodyStep.outputKey && stepOutput !== undefined && fullContext[bodyStep.outputKey] !== undefined) {
          currentFrame[bodyStep.outputKey] = fullContext[bodyStep.outputKey]!
        }
        if (!meta.endsScope) {
          return { iterationUpdate: { frame: currentFrame } }
        }
        const plan = planIterationEnd({
          block,
          control,
          iterIdx,
          totalIterations,
          frame: currentFrame,
          evalContext: { ...fullContext, ...currentFrame },
          rootContext: currentLoopState.context,
          headerStepId: headerStep.id,
          rootStepStates: rootStepStatesFresh,
        })
        loopFinished = plan.loopFinished
        loopSucceeded = plan.loopSucceeded
        iterationFinalized = true
        return plan.stepPlan
      }

      const stepResult = await this.runStepAt({
        runId,
        step: bodyStep,
        stepIndex: stepIndices.get(bodyStep.id) ?? 0,
        scopePath,
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
        suppressMediaEvidence: suppressMedia,
        onStepSuccess,
      })

      if (stepResult.sessionMustClose) sessionMustClose = true

      if (
        stepResult.action === 'failed' ||
        stepResult.action === 'stopped' ||
        stepResult.action === 'cancelled' ||
        stepResult.action === 'yielded'
      ) {
        return { exit: stepResult.action, lastIndex, sessionMustClose }
      }

      if (stepResult.action === 'retry') {
        // 断点挂起后继续或重试：当前步骤尚未执行，原地再跑一次。
        sIdx -= 1
        continue
      }
      if (stepResult.action === 'await_hold') {
        const afterHold = await this.awaitHold({
          runId,
          grant,
          stop: stop.signal,
          yielding,
          sessionGrant,
        })
        if (afterHold === 'retry') {
          sIdx -= 1
          continue
        }
        if (afterHold === 'continue') {
          // 与根作用域一致：只有当前步骤已成功（或已被跳过）才前进，失败挂起后的「继续」即重跑当前步骤。
          const states = await loadRunStepStates(db, runId, scopePath)
          const current = stepRunFor(states, bodyStep.id, scopePath)
          if (current && (current.status === 'PENDING' || current.status === 'FAILED' || current.status === 'RUNNING')) {
            sIdx -= 1
          }
          continue
        }
        const exit = await this.exitAfterHold(db, runId, yielding)
        return { exit, lastIndex, sessionMustClose }
      }
    } // 循环体内各步骤执行结束

    if (!iterationFinalized) {
      const settled = await settleIterationWithoutAttempt.call(this, {
        runId,
        grant,
        scopePath,
        block,
        control,
        iterIdx,
        totalIterations,
        frame: currentFrame,
        headerStepId: headerStep.id,
      })
      if (settled.exit) return { exit: settled.exit, lastIndex, sessionMustClose }
      loopFinished = settled.loopFinished
      loopSucceeded = settled.loopSucceeded
    }

    if (loopFinished) break

    // repeat 的等待间隔
    const intervalMs = control.intervalMs ?? block.limits?.intervalMs ?? 0
    if (intervalMs > 0 && !loopFinished) {
      const waited = await waitWithCancellation(intervalMs, stop.signal)
      if (!waited) {
        return {
          exit: yielding() ? 'yielded' : 'cancelled',
          lastIndex,
          sessionMustClose,
        }
      }
    }
  } // 各项迭代结束

  if (loopFinished) {
    if (!loopSucceeded) return { exit: 'failed', lastIndex, sessionMustClose }
    // 只有收尾事务已把 Run 写成成功才算 completed；否则交给根循环继续，最后由 finishRunIfDrained 收尾。
    const after = await loadRunLoopState(db, runId)
    return { exit: after?.status === 'SUCCEEDED' ? 'completed' : 'next', lastIndex, sessionMustClose }
  }

  return { exit: 'next', lastIndex, sessionMustClose }
}

export function isLoopBodyStep(snapshot: RunSnapshot, stepId: string): boolean {
  const blocks = snapshot.controlFlow?.blocks
  if (!blocks) return false
  return blocks.some(
    (b) => (b.kind === 'for_each' || b.kind === 'repeat') && b.bodyStepIds.includes(stepId),
  )
}

export function findLoopBlock(snapshot: RunSnapshot, step: Step) {
  const blocks = snapshot.controlFlow?.blocks
  if (!blocks) return undefined
  const blockId = (step.input as any)?.blockId
  return blocks.find(
    (b) =>
      (b.kind === 'for_each' || b.kind === 'repeat') &&
      (b.headerStepId === step.id || (blockId && b.blockId === blockId)),
  ) as ControlFlowLoopBlock | undefined
}


type LoopControl = {
  stopWhen?: import('@cairn/shared').Expr
  until?: import('@cairn/shared').Expr
  onLimit?: 'fail' | 'stop'
}

type IterationEndPlan = {
  loopFinished: boolean
  loopSucceeded: boolean
  error?: ExecutionError
  stepPlan: {
    iterationUpdate: { status: 'SUCCEEDED' | 'FAILED'; frame: Record<string, JsonValue>; stopDecision: JsonValue }
    headerFinish?: { headerStepId: string; status: 'SUCCEEDED' | 'FAILED'; error?: ExecutionError }
    rootContextToPersist: Record<string, JsonValue>
    isLast?: boolean
    runStatus?: 'SUCCEEDED' | 'FAILED'
    skipRemaining?: boolean
  }
}

/**
 * 一项结束时的纯计算：汇集、结束条件、循环与 Run 是否随之收尾。
 * 结束条件求值出错（如引用缺失）按失败处理，不当作「不成立」一直跑到上限。
 */
export function planIterationEnd(input: {
  block: ControlFlowLoopBlock
  control: LoopControl
  iterIdx: number
  totalIterations: number
  frame: Record<string, JsonValue>
  evalContext: Record<string, JsonValue>
  rootContext: Record<string, JsonValue>
  headerStepId: string
  rootStepStates: Array<{ stepId: string; ordinal: number; status: string }>
}): IterationEndPlan {
  const { block, control, iterIdx, totalIterations } = input
  const condition = block.kind === 'for_each' ? control.stopWhen : control.until
  let stopTriggered = false
  let evalError: ExecutionError | undefined
  let stopDecision: Record<string, JsonValue> = {}
  if (condition) {
    const res = evaluateExpression(condition, input.evalContext)
    if (!res.ok) {
      evalError = {
        code: 'LOOP_CONDITION_INVALID',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: `${block.kind === 'for_each' ? '提前结束条件' : '结束条件'}无法判定：${res.message}`,
      }
      stopDecision = { evaluated: false, error: evalError.safeMessage }
    } else {
      stopTriggered = res.value === true
      stopDecision = {
        evaluated: true,
        value: res.value as JsonValue,
        operands: (res.operands ?? {}) as JsonValue,
        ...(stopTriggered ? (block.kind === 'for_each' ? { stoppedEarly: true } : { untilMet: true }) : {}),
      }
    }
  }

  const rootContextToPersist = { ...input.rootContext }
  for (const rule of block.collect ?? []) {
    const val = readContextValue(input.frame, rule.from, rule.fromField)
    const list = Array.isArray(rootContextToPersist[rule.into]) ? [...(rootContextToPersist[rule.into] as JsonValue[])] : []
    list.push(val.ok ? val.value : null)
    rootContextToPersist[rule.into] = list
  }

  if (evalError) {
    return {
      loopFinished: true,
      loopSucceeded: false,
      error: evalError,
      stepPlan: {
        iterationUpdate: { status: 'FAILED', frame: input.frame, stopDecision },
        headerFinish: { headerStepId: input.headerStepId, status: 'FAILED', error: evalError },
        rootContextToPersist,
        runStatus: 'FAILED',
        skipRemaining: true,
      },
    }
  }

  const reachedLimit = iterIdx + 1 >= totalIterations
  const loopFinished = stopTriggered || reachedLimit
  let loopSucceeded = true
  let error: ExecutionError | undefined
  if (loopFinished && block.kind === 'repeat' && !stopTriggered) {
    const onLimit = control.onLimit ?? block.limits?.onLimit ?? 'fail'
    if (onLimit === 'stop') {
      stopDecision = { ...stopDecision, limitReached: true }
    } else {
      loopSucceeded = false
      error = {
        code: 'LOOP_LIMIT_REACHED',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: `重复 ${totalIterations} 次仍未满足结束条件`,
      }
    }
  }

  const isLast =
    loopFinished && loopSucceeded ? isLastOpenStep({ stepRuns: input.rootStepStates }, input.headerStepId) : false
  return {
    loopFinished,
    loopSucceeded,
    error,
    stepPlan: {
      iterationUpdate: { status: 'SUCCEEDED', frame: input.frame, stopDecision },
      headerFinish: loopFinished
        ? { headerStepId: input.headerStepId, status: loopSucceeded ? 'SUCCEEDED' : 'FAILED', ...(error ? { error } : {}) }
        : undefined,
      rootContextToPersist,
      isLast,
      runStatus: loopFinished ? (loopSucceeded ? (isLast ? 'SUCCEEDED' : undefined) : 'FAILED') : undefined,
      skipRemaining: loopFinished && !loopSucceeded,
    },
  }
}

async function settleIterationWithoutAttempt(
  this: ExecutionEngine,
  input: {
    runId: string
    grant: RunGrant
    scopePath: string
    block: ControlFlowLoopBlock
    control: LoopControl
    iterIdx: number
    totalIterations: number
    frame: Record<string, JsonValue>
    headerStepId: string
  },
): Promise<{ exit?: ProcessLogExit; loopFinished: boolean; loopSucceeded: boolean }> {
  const db = this.handle
  const state = await loadRunLoopState(db, input.runId)
  if (!state || state.status !== 'RUNNING') return { exit: 'stopped', loopFinished: false, loopSucceeded: false }
  const scoped = await loadRunStepStates(db, input.runId, input.scopePath)
  // 本项还有未收口或失败的步骤：不能当作正常结束（失败会由 Run 终态处理）。
  if (scoped.some((item) => item.status !== 'SUCCEEDED' && item.status !== 'SKIPPED')) {
    return { exit: 'stopped', loopFinished: false, loopSucceeded: false }
  }
  const rootStates = await loadRunStepStates(db, input.runId, '')
  const plan = planIterationEnd({
    ...input,
    evalContext: { ...state.context, ...input.frame },
    rootContext: state.context,
    rootStepStates: rootStates,
  })
  const settled = await settleLoopIteration(db, {
    grant: input.grant,
    runId: input.runId,
    scopePath: input.scopePath,
    iterationUpdate: plan.stepPlan.iterationUpdate,
    rootContext: plan.stepPlan.rootContextToPersist,
    headerFinish: plan.stepPlan.headerFinish,
  })
  if (!settled.settled) return { exit: 'stopped', loopFinished: false, loopSucceeded: false }
  if (plan.loopFinished && !plan.loopSucceeded) {
    await failRunValidation(db, input.runId, { grant: input.grant }, plan.error)
    return { exit: 'failed', loopFinished: true, loopSucceeded: false }
  }
  return { loopFinished: plan.loopFinished, loopSucceeded: plan.loopSucceeded }
}
