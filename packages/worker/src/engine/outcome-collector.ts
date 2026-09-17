import type { OutcomeResultInsertItem } from '@cairn/db'
import type { JsonValue, OutcomeManifestEntry, RunSnapshot, Step } from '@cairn/shared'
import type { ExecutorOutcome } from './engine-types.js'

export type OutcomeCollection = {
  outcomeResults: OutcomeResultInsertItem[]
  continueMode: boolean
}

export function collectAttemptOutcomeResults(input: {
  snapshot: RunSnapshot
  step: Step
  outcome: ExecutorOutcome
  attemptId: string
  now: Date
}): OutcomeCollection {
  const entries = input.snapshot.outcomeManifest?.entries.filter((e) => e.stepId === input.step.id) ?? []
  if (entries.length === 0) {
    return { outcomeResults: [], continueMode: false }
  }

  const { outcome, step, now } = input

  // 1. 成功完成
  if (outcome.kind === 'success') {
    const actual = extractActual(outcome.output)
    const details = extractDetails(outcome.output)

    const results: OutcomeResultInsertItem[] = entries.map((e) => ({
      contractId: e.contractId,
      scope: e.scope,
      meaning: e.meaning,
      severity: e.severity,
      onViolation: e.onViolation,
      provenance: e.provenance,
      verdict: 'PASS',
      expected: extractExpected(step, e),
      actual,
      details,
      evaluatedAt: now,
    }))
    return { outcomeResults: results, continueMode: false }
  }

  // 2. 失败分支
  const isAssertionFailure =
    outcome.error.code === 'ASSERT_FAILED' || outcome.error.code === 'VALIDATION'

  if (isAssertionFailure) {
    const actual = extractActual(outcome.output)
    const details = extractDetails(outcome.output)
    const continueMode = entries.every((e) => e.onViolation === 'continue')

    const results: OutcomeResultInsertItem[] = entries.map((e) => ({
      contractId: e.contractId,
      scope: e.scope,
      meaning: e.meaning,
      severity: e.severity,
      onViolation: e.onViolation,
      provenance: e.provenance,
      verdict: 'FAIL',
      expected:
        extractExpected(step, e) ??
        (outcome.output && typeof outcome.output === 'object' && 'expected' in outcome.output
          ? (outcome.output as { expected: JsonValue }).expected
          : null),
      actual,
      details,
      evaluatedAt: now,
    }))
    return { outcomeResults: results, continueMode }
  }

  // 3. 非断言基础设施异常（TARGET_NOT_FOUND, TIMEOUT, PAGE_CRASH, SURFACE_LOST 等）
  // 规范明文要求：取值定位失败判 UNKNOWN，不判 FAIL
  const results: OutcomeResultInsertItem[] = entries.map((e) => ({
    contractId: e.contractId,
    scope: e.scope,
    meaning: e.meaning,
    severity: e.severity,
    onViolation: e.onViolation,
    provenance: e.provenance,
    verdict: 'UNKNOWN',
    expected: extractExpected(step, e),
    actual: null,
    details: { code: outcome.error.code, safeMessage: outcome.error.safeMessage },
    evaluatedAt: now,
  }))
  return { outcomeResults: results, continueMode: false }
}

function extractExpected(step: Step, entry?: OutcomeManifestEntry): JsonValue | null {
  if (step.type === 'assert' && step.input && typeof step.input === 'object' && 'expect' in step.input) {
    return (step.input as { expect: JsonValue }).expect
  }
  if (step.type === 'ai_assert' && step.input && typeof step.input === 'object' && 'instruction' in step.input) {
    return (step.input as { instruction: JsonValue }).instruction
  }
  if (entry?.rule) {
    if (entry.rule.kind === 'deterministic') {
      return entry.rule.expect as unknown as JsonValue
    }
    if (entry.rule.kind === 'ai') {
      return entry.rule.instruction as unknown as JsonValue
    }
  }
  return null
}

function extractActual(output: unknown): JsonValue | null {
  if (!output || typeof output !== 'object') return null
  if ('actual' in output) {
    return (output as { actual: JsonValue }).actual
  }
  if ('passed' in output) {
    return (output as { passed: JsonValue }).passed
  }
  return output as JsonValue
}

function extractDetails(output: unknown): Record<string, JsonValue> | null {
  if (!output || typeof output !== 'object') return null
  const res: Record<string, JsonValue> = {}
  if ('reason' in output && typeof (output as { reason: unknown }).reason === 'string') {
    res.reason = (output as { reason: string }).reason
  }
  if ('model' in output && typeof (output as { model: unknown }).model === 'string') {
    res.model = (output as { model: string }).model
  }
  if ('latencyMs' in output && typeof (output as { latencyMs: unknown }).latencyMs === 'number') {
    res.latencyMs = (output as { latencyMs: number }).latencyMs
  }
  if ('usage' in output && (output as { usage: unknown }).usage && typeof (output as { usage: unknown }).usage === 'object') {
    res.usage = (output as { usage: JsonValue }).usage
  }
  if ('cost' in output && typeof (output as { cost: unknown }).cost === 'number') {
    res.cost = (output as { cost: number }).cost
  }
  if ('tokens' in output && (output as { tokens: unknown }).tokens && typeof (output as { tokens: unknown }).tokens === 'object') {
    res.tokens = (output as { tokens: JsonValue }).tokens
  }
  return Object.keys(res).length > 0 ? res : null
}
