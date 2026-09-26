import {
  AI_STEP_TYPES,
  aiCommandSchema,
  aiAtomicActionInputSchema,
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

    // Resolve explicit contextBindings (B2)
    const contextValues: Record<string, JsonValue> = {}
    if ('contextBindings' in step && Array.isArray((step as any).contextBindings)) {
      const bindings = (step as any).contextBindings as import('@cairn/shared').ContextBinding[]
      for (const binding of bindings) {
        const value = resolveBindingValue(ctx.context, binding)
        if ((value === undefined || value === null) && binding.required !== false) {
          return fail({
            code: 'AI_REQUIRED_CONTEXT_MISSING',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `AI 步骤「${step.name}」必需的上下文绑定「${binding.name}」缺失 (source: ${binding.source})`,
          })
        }
        if (value !== undefined) {
          contextValues[binding.name] = value
        }
      }
    }

    const command = commandFor(step, snapshot, ctx.input, contextValues)
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
      sensitiveSelectors: snapshot.targetAuth?.sensitiveSelectors ?? [],
      runInput: ctx.input,
      contextBindings: contextValues,
      step,
      snapshot,
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

function commandFor(
  step: Step,
  snapshot: RunSnapshot,
  resolvedInput: JsonValue,
  contextValues?: Record<string, JsonValue>,
): AiCommand {
  const config = snapshot.aiExecution!
  const instruction =
    step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert'
      ? ('instruction' in step.input ? step.input.instruction : undefined)
      : ''
  return aiCommandSchema.parse({
    type: step.type as AiCommand['type'],
    ...(step.type === 'ai_action' && 'operation' in step.input
      ? { action: aiAtomicActionInputSchema.parse(resolvedInput) }
      : { instruction }),
    outputSchema: step.type === 'ai_extract' ? step.input.outputSchema : undefined,
    contextValues: contextValues && Object.keys(contextValues).length > 0 ? contextValues : undefined,
    maxCalls: config.maxCalls,
    maxOutputTokens: config.maxOutputTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    hangWaitMs: config.hangWaitMs,
    allowedOrigins: snapshot.allowedOrigins ?? [],
    loginOrigin: snapshot.loginOrigin,
    loginPath: snapshot.loginPath,
  })
}

export function resolveBindingValue(
  context: Readonly<Record<string, JsonValue>>,
  binding: import('@cairn/shared').ContextBinding,
): JsonValue | undefined {
  const { source, path, projection } = binding

  // Guard against prototype pollution
  if (
    source.includes('__proto__') ||
    source.includes('constructor') ||
    source.includes('prototype') ||
    (path && (path.includes('__proto__') || path.includes('constructor') || path.includes('prototype')))
  ) {
    return undefined
  }

  let base: any = context[source]

  if (base === undefined) {
    if (source.startsWith('input.')) {
      const key = source.slice('input.'.length)
      base = context[key] ?? (context.input as any)?.[key]
    } else if (source.startsWith('steps.')) {
      const parts = source.slice('steps.'.length).split('.')
      const stepId = parts[0]
      const field = parts[1]
      if (stepId) {
        base = field
          ? (context.steps as any)?.[stepId]?.[field] ?? context[`${stepId}.${field}`]
          : context[stepId] ?? (context.steps as any)?.[stepId]
      }
    }
  }

  let resolved: any = base
  if (path && resolved !== undefined && resolved !== null && typeof resolved === 'object') {
    const segments = path.split('.')
    for (const segment of segments) {
      if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
        return undefined
      }
      if (resolved && typeof resolved === 'object') {
        resolved = resolved[segment]
      } else {
        resolved = undefined
        break
      }
    }
  }

  if (resolved === undefined || resolved === null) {
    return resolved
  }

  // Apply projection if specified
  if (projection === 'summary') {
    if (Array.isArray(resolved)) {
      return { length: resolved.length, sample: resolved.slice(0, 3) } as JsonValue
    }
    if (typeof resolved === 'object') {
      const keys = Object.keys(resolved)
      return { keys, count: keys.length } as JsonValue
    }
    if (typeof resolved === 'string') {
      return (resolved.length > 200 ? `${resolved.slice(0, 200)}...` : resolved) as JsonValue
    }
  } else if (projection === 'list_sample') {
    if (Array.isArray(resolved)) {
      return resolved.slice(0, 5) as JsonValue
    }
  }

  return resolved as JsonValue
}

function fail(
  error: ExecutionError,
  output?: JsonValue,
  screenshot?: ScreenshotPointer,
  trace?: ScreenshotPointer,
): StepExecutionOutcome {
  return { kind: 'failed', error, output, screenshot, trace, timedOut: false, aborted: false }
}
