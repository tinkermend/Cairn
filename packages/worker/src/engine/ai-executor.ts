import {
  AI_STEP_TYPES,
  ASSERT_FAILED_CODE,
  retainUntilFor,
  type AiCommand,
  type ExecutionError,
  type JsonValue,
  type RunSnapshot,
  type ScreenshotPointer,
  type Step,
} from '@cairn/shared'
import type { AiPort } from './ports.js'
import type { StepExecutionContext, StepExecutionOutcome, StepExecutor } from './step-executor.js'

export class AiStepExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...AI_STEP_TYPES]

  constructor(private readonly ai: AiPort) {}

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const { step, signal, sessionGrant, runId, stepRunId, attemptId, evidencePolicy, snapshot } = ctx
    if (!sessionGrant) {
      return fail({
        code: 'BROWSER_UNAVAILABLE',
        category: 'INFRASTRUCTURE',
        retryable: true,
        safeMessage: 'AI 步骤没有可用会话',
      })
    }
    if (!snapshot.aiExecution) {
      return fail({
        code: 'AI_CONFIG_INVALID',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: '运行快照缺少 AI 执行配置',
      })
    }
    if (!snapshot.allowedOrigins?.length) {
      return fail({
        code: 'SESSION_TARGET_MISSING',
        category: 'VALIDATION',
        retryable: false,
        safeMessage: '运行快照没有冻结页面范围',
      })
    }
    const command = commandFor(step, snapshot)
    const result = await this.ai.execute(sessionGrant, command, signal, {
      runId,
      stepRunId,
      attemptId,
      screenshot: evidencePolicy.screenshot,
      trace: evidencePolicy.trace,
      screenshotRetainUntil: retainUntilFor('screenshot', evidencePolicy).toISOString(),
      traceRetainUntil: retainUntilFor('trace', evidencePolicy).toISOString(),
      grant: ctx.grant,
      maxCalls: snapshot.aiExecution.maxCalls,
      model: snapshot.aiExecution.modelName,
      config: snapshot.aiExecution,
    })

    if (result.hung) {
      return {
        kind: 'needs_review',
        error: {
          code: 'AI_HUNG',
          category: 'UNKNOWN',
          retryable: false,
          safeMessage: result.summary ?? 'AI 调用未落定，会话不可复用',
        },
        screenshot: result.screenshot,
        trace: result.trace,
        hung: true,
      }
    }
    if (!result.ok) {
      // 端口给了结构化错误就原样使用：丢租且已放行过动作记 UNKNOWN，副作用步骤由引擎转人工核查。
      if (result.error) return fail(result.error, undefined, result.screenshot, result.trace)
      const budget = result.summary?.includes('预算')
      return fail(
        {
          code: budget ? 'AI_BUDGET_EXCEEDED' : 'AI_EXECUTION_FAILED',
          category: budget ? 'VALIDATION' : 'EXECUTOR',
          retryable: !budget && step.type !== 'ai_action',
          safeMessage: result.summary ?? 'AI 执行失败',
        },
        undefined,
        result.screenshot,
        result.trace,
      )
    }
    if (step.type === 'ai_assert') {
      const output = result.output
      if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.passed !== 'boolean') {
        return fail(
          {
            code: 'AI_OUTPUT_INVALID',
            category: 'EXECUTOR',
            retryable: true,
            safeMessage: 'AI 断言没有返回 passed',
          },
          undefined,
          result.screenshot,
          result.trace,
        )
      }
      if (!output.passed) {
        return fail(
          {
            code: ASSERT_FAILED_CODE,
            category: 'VALIDATION',
            retryable: false,
            safeMessage: typeof output.reason === 'string' ? output.reason : '断言不成立',
          },
          output,
          result.screenshot,
          result.trace,
        )
      }
    }
    return {
      kind: 'success',
      output: result.output ?? { summary: result.summary ?? 'ok' },
      screenshot: result.screenshot,
      trace: result.trace,
    }
  }
}

function commandFor(step: Step, snapshot: RunSnapshot): AiCommand {
  const config = snapshot.aiExecution!
  const instruction =
    step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert'
      ? step.input.instruction
      : ''
  return {
    type: step.type as AiCommand['type'],
    instruction,
    outputSchema: step.type === 'ai_extract' ? step.input.outputSchema : undefined,
    maxCalls: config.maxCalls,
    maxOutputTokens: config.maxOutputTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    hangWaitMs: config.hangWaitMs,
    allowedOrigins: snapshot.allowedOrigins ?? [],
    loginOrigin: snapshot.loginOrigin,
    loginPath: snapshot.loginPath,
  }
}

function fail(
  error: ExecutionError,
  output?: JsonValue,
  screenshot?: ScreenshotPointer,
  trace?: ScreenshotPointer,
): StepExecutionOutcome {
  return { kind: 'failed', error, output, screenshot, trace, timedOut: false, aborted: false }
}
