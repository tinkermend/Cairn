import {
  fillTextFromContext,
  jsonValueSchema,
  readContextValue,
  REDACTED,
  stepUsesBrowser,
  type ExecutionError,
  type JsonValue,
  type RunDetailDto,
  type RunGrant,
  type SessionGrant,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import type { FinishAttemptInput } from '@cairn/db'

export function resolveStepInput(
  step: Step,
  context: Record<string, JsonValue>,
  overlayTarget?: TargetDescriptor,
): { ok: true; input: JsonValue } | { ok: false; input: JsonValue; error: ExecutionError } {
  if (step.type === 'echo') {
    if (step.input.value !== undefined) return { ok: true, input: step.input.value }
    const from = step.input.from!
    const resolved = readContextValue(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          from,
          ...(step.input.fromField ? { fromField: step.input.fromField } : {}),
        },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: resolved.value }
  }
  if (step.type === 'fill') {
    const target = overlayTarget ?? step.input.target
    if (step.input.value !== undefined) {
      return { ok: true, input: { target, value: step.input.value } }
    }
    const from = step.input.from!
    const resolved = fillTextFromContext(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          target,
          from,
          ...(step.input.fromField ? { fromField: step.input.fromField } : {}),
        },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: { target, value: resolved.text } }
  }
  if (step.type === 'select') {
    const target = overlayTarget ?? step.input.target
    if (step.input.by === 'index' || step.input.value !== undefined) {
      return { ok: true, input: { ...step.input, target } }
    }
    const from = step.input.from!
    const resolved = fillTextFromContext(context, from, step.input.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: { ...step.input, target },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: { ...step.input, target, value: resolved.text } }
  }
  if (overlayTarget && step.input && typeof step.input === 'object' && 'target' in step.input) {
    return { ok: true, input: { ...step.input, target: overlayTarget } }
  }
  return { ok: true, input: step.input }
}

/** 可被 Engine 推进：未开始，或已在跑但没有未关闭的 Attempt（接管收孤儿后）。 */
export function jsonContext(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonValueSchema.parse(item)]),
  )
}

export function isRunnableStepRun(stepRun: RunDetailDto['stepRuns'][number]): boolean {
  if (stepRun.status === 'PENDING' || stepRun.status === 'FAILED') return true
  if (stepRun.status !== 'RUNNING') return false
  return !stepRun.attempts.some((attempt) => attempt.status === 'RUNNING')
}

/**
 * 当前步骤是否为「最后一个未完成步骤」。
 * RUNNING 与 PENDING 都算未完成——接管后不得把后面的步骤当成最后一步写 SUCCEEDED。
 */
export function isLastOpenStep(detail: RunDetailDto, stepId: string): boolean {
  const current = detail.stepRuns.find((item) => item.stepId === stepId)
  if (!current) return false
  return detail.stepRuns.every(
    (item) =>
      item.ordinal <= current.ordinal || (item.status !== 'PENDING' && item.status !== 'RUNNING'),
  )
}

export function sessionLeaseFor(input: {
  step: Step
  sessionGrant?: SessionGrant
  grant: RunGrant
}): FinishAttemptInput['sessionLease'] {
  if (!input.sessionGrant || !stepUsesBrowser(input.step.type)) return undefined
  return {
    ...input.sessionGrant,
    holderWorkerId: input.grant.holderWorkerId,
    effectType: input.step.effectType,
  }
}

export function contextValue(step: Step, output: JsonValue): JsonValue {
  if (
    step.type === 'extract' &&
    output &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    'value' in output
  ) {
    return jsonValueSchema.parse(output.value)
  }
  return output
}

export function evidencePayloadForStep(step: Step, input: JsonValue, targetOverride = false): JsonValue {
  const withOverride = (value: { [key: string]: JsonValue }): JsonValue =>
    targetOverride ? { ...value, targetOverride: true } : value
  if (
    step.type === 'fill' &&
    step.input.sensitive &&
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) {
    return withOverride({ ...input, value: REDACTED })
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return withOverride({ ...input })
  }
  return targetOverride ? { value: input, targetOverride: true } : input
}

export function chargedAttemptCount(detail: RunDetailDto, stepRunId: string): number {
  return detail.stepRuns.find((step) => step.id === stepRunId)?.attempts.filter((attempt) =>
    !(attempt.error?.code === 'AUTH_GATE_CLOSED' && attempt.error.cause?.code === 'not_dispatched'),
  ).length ?? 1
}
