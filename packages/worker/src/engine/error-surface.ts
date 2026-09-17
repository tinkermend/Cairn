import type { OutcomeResultInsertItem } from '@cairn/db'
import {
  classifyErrorSurface,
  type ErrorSurfaceNode,
  type JsonValue,
  type RuntimeInvariant,
  type RunSnapshot,
  type Step,
} from '@cairn/shared'

export function errorSurfaceInvariants(snapshot: RunSnapshot): RuntimeInvariant[] {
  return (snapshot.runtimeInvariantManifest?.entries ?? []).filter((item) => item.kind === 'error_surface')
}

export function shouldProbeErrorSurface(
  snapshot: RunSnapshot,
  step: Step,
  phase: 'before' | 'after',
): boolean {
  const invariants = errorSurfaceInvariants(snapshot)
  if (invariants.length === 0) return false
  if (phase === 'before') {
    return (
      step.effectType === 'SIDE_EFFECT' &&
      invariants.some((item) => item.evaluateAt === 'before_side_effect')
    )
  }
  return invariants.some((item) => item.evaluateAt === 'each_step')
}

export function mergeErrorSurfaceOutput(
  output: unknown,
  fact: { probed: boolean; matches: ErrorSurfaceNode[] },
): JsonValue {
  const base = output && typeof output === 'object' && !Array.isArray(output) ? { ...(output as object) } : {}
  return { ...base, errorSurface: fact } as JsonValue
}

export function collectErrorSurfaceResults(input: {
  snapshot: RunSnapshot
  stepRunId: string
  attemptId: string
  now: Date
  matches: ErrorSurfaceNode[]
}): { results: OutcomeResultInsertItem[]; halt: boolean; violated: boolean } {
  const classified = classifyErrorSurface(input.matches)
  const results: OutcomeResultInsertItem[] = []
  let halt = false
  for (const invariant of errorSurfaceInvariants(input.snapshot)) {
    results.push({
      contractId: invariant.id,
      scope: 'scenario',
      meaning: invariant.meaning,
      severity: invariant.severity,
      onViolation: invariant.onViolation,
      provenance: 'runtime_invariant',
      verdict: classified.violated ? 'FAIL' : 'PASS',
      expected: { kind: 'error_surface', surface: 'none' },
      actual: { matches: classified.matches },
      details: { evaluateAt: invariant.evaluateAt, probed: true },
      evaluatedAt: input.now,
    })
    if (classified.violated && invariant.onViolation === 'halt') halt = true
  }
  return { results, halt, violated: classified.violated }
}

export const ERROR_SURFACE_VIOLATED = {
  code: 'ERROR_SURFACE_VIOLATED',
  category: 'VALIDATION' as const,
  retryable: false,
  safeMessage: '页面出现系统错误弹窗，运行期约束要求停止后续步骤',
}
