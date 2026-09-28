import type { AttemptDto, EvidenceMetadata, StepRunDto } from '@cairn/shared'

/** 沿路径读取未知结构里的字段；任一层不是对象就返回 undefined。 */
function fieldAt(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function outputMarksHealed(output: unknown): boolean {
  return fieldAt(output, 'healerResolved') === true || fieldAt(output, 'diagnostics', 'resolvedVia') === 'ai'
}

function logMarksHealed(evidence: EvidenceMetadata): boolean {
  if (evidence.type !== 'log') return false
  return (
    fieldAt(evidence.payload, 'resolvedVia') === 'ai' ||
    fieldAt(evidence.payload, 'suggestedPatch', 'kind') === 'ADD_CANDIDATE'
  )
}

/**
 * 判断单个 Attempt 是否由 AI 救活：
 * 1. 兼容原有 mock / 测试标记 healerResolved: true
 * 2. 兼容 output.diagnostics.resolvedVia === 'ai'
 * 3. 真实运行事实：读取关联证据列表中 type === 'log' 且 payload 标记为 AI 定位救活 (resolvedVia: 'ai' 或 suggestedPatch: ADD_CANDIDATE)
 */
export function isAttemptHealed(
  attempt: AttemptDto | undefined,
  evidenceItems?: EvidenceMetadata[],
): boolean {
  if (!attempt) return false
  if (outputMarksHealed(attempt.output)) return true
  return Boolean(evidenceItems?.some((e) => e.attemptId === attempt.id && logMarksHealed(e)))
}

/**
 * 判断某个 StepRun 是否存在 AI 救活的尝试
 */
export function isStepHealed(
  step: StepRunDto | undefined,
  evidenceItems?: EvidenceMetadata[],
): boolean {
  if (!step) return false
  if (step.attempts?.some((a) => outputMarksHealed(a.output))) return true
  return Boolean(evidenceItems?.some((e) => e.stepRunId === step.id && logMarksHealed(e)))
}

/** 读取尝试输出里的 AI 修复假设说明（healerHypothesis），没有则返回 undefined。 */
export function healerHypothesisOf(output: unknown): string | undefined {
  const value = fieldAt(output, 'healerHypothesis')
  return typeof value === 'string' && value ? value : undefined
}
