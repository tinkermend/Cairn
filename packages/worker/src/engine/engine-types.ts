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
  /** 轮询取消请求的间隔。取消只能查库发现（NOTIFY 属 P7），测试用它把窗口压小。 */
  cancelPollMs?: number
}

/** 取消请求的轮询间隔：更密只增加查询，不会更早发现取消。 */
export const DEFAULT_CANCEL_POLL_MS = 250

export type ExecutorOutcome = StepExecutionOutcome & {
  timedOut: boolean
  aborted: boolean
}
