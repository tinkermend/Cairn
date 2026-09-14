import {
  FIXTURE_STEP_TYPES,
  type FixtureStepType,
} from '@cairn/shared'
import { executeDelay, executeEcho, executeFail } from './executors.js'
import type {
  StepExecutionContext,
  StepExecutionOutcome,
  StepExecutor,
} from './step-executor.js'

export class FixtureStepExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...FIXTURE_STEP_TYPES]

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const { step, input, signal, clock } = ctx

    if (step.type === 'echo') {
      return { kind: 'success', output: executeEcho(input) }
    }

    if (step.type === 'delay') {
      const result = await executeDelay(step.input.durationMs, signal, clock)
      return { kind: 'success', output: result }
    }

    if (step.type === 'fail') {
      return {
        kind: 'failed',
        error: executeFail(step.input),
        timedOut: false,
        aborted: false,
      }
    }

    return {
      kind: 'failed',
      error: {
        code: 'EXECUTOR_UNSUPPORTED_TYPE',
        category: 'EXECUTOR',
        retryable: false,
        safeMessage: `FixtureStepExecutor 不支持步骤类型：${step.type}`,
      },
      timedOut: false,
      aborted: false,
    }
  }
}
