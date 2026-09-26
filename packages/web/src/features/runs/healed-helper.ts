import type { AttemptDto, EvidenceMetadata, StepRunDto } from '@cairn/shared'

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
  if ((attempt.output as any)?.healerResolved === true) return true
  if ((attempt.output as any)?.diagnostics?.resolvedVia === 'ai') return true
  if (evidenceItems && evidenceItems.length > 0) {
    return evidenceItems.some((e) => {
      const matchAttempt = e.attemptId === attempt.id
      if (!matchAttempt) return false
      if (e.type !== 'log') return false
      const payload = e.payload as any
      return (
        payload?.resolvedVia === 'ai' ||
        payload?.suggestedPatch?.kind === 'ADD_CANDIDATE'
      )
    })
  }
  return false
}

/**
 * 判断某个 StepRun 是否存在 AI 救活的尝试
 */
export function isStepHealed(
  step: StepRunDto | undefined,
  evidenceItems?: EvidenceMetadata[],
): boolean {
  if (!step) return false
  if (step.attempts?.some((a) => (a.output as any)?.healerResolved === true)) return true
  if (step.attempts?.some((a) => (a.output as any)?.diagnostics?.resolvedVia === 'ai')) return true
  if (evidenceItems && evidenceItems.length > 0) {
    return evidenceItems.some((e) => {
      const matchStep = e.stepRunId === step.id
      if (!matchStep) return false
      if (e.type !== 'log') return false
      const payload = e.payload as any
      return (
        payload?.resolvedVia === 'ai' ||
        payload?.suggestedPatch?.kind === 'ADD_CANDIDATE'
      )
    })
  }
  return false
}
