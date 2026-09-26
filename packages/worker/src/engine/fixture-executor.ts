import {
  FIXTURE_STEP_TYPES,
  SYSTEM_STEP_TYPES,
  evaluateExpression,
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

    if (step.type === 'decide') {
      const condition = step.input.condition
      const evalRes = evaluateExpression(condition, context)
      if (!evalRes.ok) {
        return {
          kind: 'failed',
          error: {
            code: 'EXPRESSION_EVALUATION_FAILED',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `条件表达式计算失败: ${evalRes.message}`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      if (typeof evalRes.value !== 'boolean') {
        return {
          kind: 'failed',
          error: {
            code: 'EXPRESSION_EVALUATION_FAILED',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: '条件表达式的结果不是布尔值',
          },
          timedOut: false,
          aborted: false,
        }
      }
      const blockId = step.input.blockId
      const block = ctx.snapshot.controlFlow?.blocks?.find((b) => b.blockId === blockId)
      const hasElse = Boolean(block && block.kind === 'if' && block.branches.some((b) => b.key === 'else' && b.stepIds.length > 0))
      const branch: 'then' | 'else' | 'none' = evalRes.value ? 'then' : (hasElse ? 'else' : 'none')
      return {
        kind: 'success',
        output: {
          branch,
          value: evalRes.value,
          operands: evalRes.operands,
        },
      }
    }

    if (step.type === 'compute') {
      const expr = step.input.expression
      const evalRes = evaluateExpression(expr, context)
      if (!evalRes.ok) {
        return {
          kind: 'failed',
          error: {
            code: 'EXPRESSION_EVALUATION_FAILED',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `计算表达式执行失败: ${evalRes.message}`,
          },
          timedOut: false,
          aborted: false,
        }
      }
      return {
        kind: 'success',
        output: evalRes.value,
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
