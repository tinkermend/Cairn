import {
  FIXTURE_STEP_TYPES,
  SYSTEM_STEP_TYPES,
  type FixtureStepType,
} from '@cairn/shared'
import { executeDelay, executeEcho, executeFail } from './executors.js'
import type {
  StepExecutionContext,
  StepExecutionOutcome,
  StepExecutor,
} from './step-executor.js'

export class FixtureStepExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...FIXTURE_STEP_TYPES, ...SYSTEM_STEP_TYPES]

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const { step, input, signal, clock, context } = ctx

    if (step.type === 'verify_context') {
      const keys =
        input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as any).keys)
          ? ((input as any).keys as string[])
          : step.input.keys
      const missing: string[] = []
      for (const key of keys) {
        const val = context[key]
        if (val === undefined || val === null) {
          missing.push(key)
        }
      }
      if (missing.length > 0) {
        return {
          kind: 'failed',
          error: {
            code: 'FAILED_VERIFICATION',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `模块声明的契约输出「${missing.join('、')}」未在上下文中产出`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      return { kind: 'success', output: { verified: true, keys } }
    }

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
