import {
  asRunFileHandle,
  fillTextFromContext,
  jsonValueSchema,
  readContextValue,
  runObjectIdFromKey,
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
  currentRunId?: string,
): { ok: true; input: JsonValue } | { ok: false; input: JsonValue; error: ExecutionError } {
  let baseInput: any = step.input
  if (step.fieldRefs && Object.keys(step.fieldRefs).length > 0) {
    baseInput = JSON.parse(JSON.stringify(step.input))
    for (const [field, ref] of Object.entries(step.fieldRefs)) {
      const resolved = readContextValue(context, ref.from, ref.fromField)
      if (!resolved.ok) {
        return {
          ok: false,
          input: baseInput,
          error: {
            code: resolved.code,
            category: 'VALIDATION',
            retryable: false,
            safeMessage: resolved.message,
          },
        }
      }
      if (field === 'navigate.url') {
        baseInput.url = String(resolved.value)
      } else if (field === 'target.anchor.withinText') {
        if (baseInput.target?.anchor) {
          baseInput.target.anchor.withinText = String(resolved.value)
        }
      } else if (field === 'target.candidate.name') {
        if (baseInput.target?.candidates?.[0]) {
          baseInput.target.candidates[0].name = String(resolved.value)
        }
      } else if (field === 'target.candidate.value') {
        if (baseInput.target?.candidates?.[0]) {
          baseInput.target.candidates[0].value = String(resolved.value)
        }
      } else if (field === 'assert.expect.value') {
        if (baseInput.expect) {
          if (baseInput.expect.kind === 'number_compare') {
            const num = typeof resolved.value === 'number' ? resolved.value : Number(resolved.value)
            if (Number.isNaN(num)) {
              return {
                ok: false,
                input: baseInput,
                error: {
                  code: 'ASSERT_VALUE_INVALID',
                  category: 'VALIDATION',
                  retryable: false,
                  safeMessage: `断言值「${resolved.value}」不是有效的数字`,
                },
              }
            }
            baseInput.expect.value = num
          } else {
            baseInput.expect.value = String(resolved.value)
          }
        }
      }
    }
  }

  if (step.type === 'echo') {
    if (baseInput.value !== undefined) return { ok: true, input: baseInput.value }
    const from = baseInput.from!
    const resolved = readContextValue(context, from, baseInput.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          from,
          ...(baseInput.fromField ? { fromField: baseInput.fromField } : {}),
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
    const target = overlayTarget ?? baseInput.target
    if (baseInput.value !== undefined) {
      return { ok: true, input: { target, value: baseInput.value } }
    }
    const from = baseInput.from!
    const resolved = fillTextFromContext(context, from, baseInput.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: {
          target,
          from,
          ...(baseInput.fromField ? { fromField: baseInput.fromField } : {}),
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
  if (step.type === 'ai_action' && 'operation' in baseInput && baseInput.operation === 'input') {
    const { from, fromField, ...action } = baseInput
    if (action.mode === 'clear') return { ok: true, input: action }
    const resolved = from ? fillTextFromContext(context, from, fromField) : { ok: true as const, text: action.value ?? '' }
    if (!resolved.ok || !resolved.text) {
      return { ok: false, input: baseInput, error: {
        code: resolved.ok ? 'AI_INPUT_EMPTY' : resolved.code,
        category: 'VALIDATION', retryable: false,
        safeMessage: resolved.ok ? 'AI 输入值为空；清空请使用 clear 操作' : resolved.message,
      } }
    }
    return { ok: true, input: { ...action, value: resolved.text } }
  }
  if (step.type === 'select') {
    const target = overlayTarget ?? baseInput.target
    if (baseInput.by === 'index' || baseInput.value !== undefined) {
      return { ok: true, input: { ...baseInput, target } }
    }
    const from = baseInput.from!
    const resolved = fillTextFromContext(context, from, baseInput.fromField)
    if (!resolved.ok) {
      return {
        ok: false,
        input: { ...baseInput, target },
        error: {
          code: resolved.code,
          category: 'VALIDATION',
          retryable: false,
          safeMessage: resolved.message,
        },
      }
    }
    return { ok: true, input: { ...baseInput, target, value: resolved.text } }
  }
  if (step.type === 'upload') {
    const target = overlayTarget ?? step.input.target
    const resolvedFiles: Array<JsonValue> = []

    for (const fileItem of step.input.files) {
      if (fileItem.source === 'asset') {
        resolvedFiles.push({
          source: 'asset',
          fixtureId: fileItem.fixtureId,
          digest: fileItem.digest,
          ...(fileItem.name ? { name: fileItem.name } : {}),
        })
      } else if (fileItem.source === 'context') {
        const from = fileItem.from
        const resolved = readContextValue(context, from, fileItem.fromField)
        if (!resolved.ok) {
          return {
            ok: false,
            input: { target, files: step.input.files as unknown as JsonValue },
            error: {
              code: resolved.code,
              category: 'VALIDATION',
              retryable: false,
              safeMessage: resolved.message,
            },
          }
        }
        const handle = asRunFileHandle(resolved.value)
        if (!handle) {
          return {
            ok: false,
            input: { target, files: step.input.files as unknown as JsonValue },
            error: {
              code: 'FILE_HANDLE_INVALID',
              category: 'VALIDATION',
              retryable: false,
              safeMessage: `上下文「${from}」的值不是合法的文件句柄`,
            },
          }
        }
        if (
          handle.scope === 'run' &&
          currentRunId &&
          (handle.runId !== currentRunId || !runObjectIdFromKey(handle.objectKey, currentRunId))
        ) {
          return {
            ok: false,
            input: { target, files: step.input.files as unknown as JsonValue },
            error: {
              code: 'FILE_HANDLE_FOREIGN_RUN',
              category: 'VALIDATION',
              retryable: false,
              safeMessage:
                handle.runId !== currentRunId
                  ? `文件句柄所属 Run「${handle.runId}」与当前 Run「${currentRunId}」不一致`
                  : '文件句柄的对象键不属于当前 Run',
            },
          }
        }
        resolvedFiles.push({
          source: 'context',
          from: fileItem.from,
          ...(fileItem.fromField ? { fromField: fileItem.fromField } : {}),
          ...(fileItem.name ? { name: fileItem.name } : {}),
          handle: handle as unknown as JsonValue,
        })
      }
    }
    return {
      ok: true,
      input: {
        target,
        files: resolvedFiles,
      },
    }
  }
  if (overlayTarget && baseInput && typeof baseInput === 'object' && 'target' in baseInput) {
    return { ok: true, input: { ...baseInput, target: overlayTarget } }
  }
  return { ok: true, input: baseInput }
}

/** 可被 Engine 推进：未开始，或已在跑但没有未关闭的 Attempt（接管收孤儿后）。 */
export function jsonContext(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonValueSchema.parse(item)]),
  )
}

export function isRunnableStepRun(stepRun: {
  status: string
  attempts: Array<{ status: string }>
}): boolean {
  if (stepRun.status === 'PENDING' || stepRun.status === 'FAILED') return true
  if (stepRun.status !== 'RUNNING') return false
  return !stepRun.attempts.some((attempt) => attempt.status === 'RUNNING')
}

/**
 * 当前步骤是否为「最后一个未完成步骤」。
 * RUNNING 与 PENDING 都算未完成——接管后不得把后面的步骤当成最后一步写 SUCCEEDED。
 */
export function isLastOpenStep(
  detail: { stepRuns: Array<{ stepId: string; ordinal: number; status: string }> },
  stepId: string,
): boolean {
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

export function chargedAttemptCount(
  detail: { stepRuns: Array<{ id: string; attempts: Array<{ error?: ExecutionError | null }> }> },
  stepRunId: string,
): number {
  return detail.stepRuns.find((step) => step.id === stepRunId)?.attempts.filter((attempt) =>
    !(attempt.error?.code === 'AUTH_GATE_CLOSED' && (attempt.error.cause as any)?.code === 'not_dispatched'),
  ).length ?? 1
}
