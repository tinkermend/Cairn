import type { ProcessLogExit } from '@cairn/shared'
import type { StepExecutionOutcome } from './step-executor.js'
import type { EngineClock } from './clock.js'
import type { RunGrant } from '@cairn/shared'

export type AttemptOutcome = 'next' | 'await_hold' | ProcessLogExit

export type AttemptLogState = {
  startedAt: number
  clock: EngineClock
  stepId: string
  stepType: string
  attemptNo: number
  runId: string
  stepRunId: string
  workerId: string
  leaseId: string
}

export type ExecuteOptions = {
  grant: RunGrant
  signal?: AbortSignal
  clock?: EngineClock
  /** 兜底核验间隔覆盖值；测试用它把取消发现窗口压小。 */
  cancelPollMs?: number
}

/** 变化提示不可用时，维持原有的取消发现窗口。 */
export const DEFAULT_CANCEL_POLL_MS = 250

/** 变化提示可用时，低频核验持久化事实以覆盖丢失的提示。 */
export const DEFAULT_CANCEL_RECONCILE_MS = 5_000

export type ExecutorOutcome = StepExecutionOutcome & {
  timedOut: boolean
  aborted: boolean
}
