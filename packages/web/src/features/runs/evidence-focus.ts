import type { RunDetailDto, RunEvidenceListResponse } from '@cairn/shared'

export type RunEvidenceFocusSearch = {
  stepRunId?: string
  attemptId?: string
  evidenceId?: string
}

export function resolveRunEvidenceFocus(
  run: RunDetailDto,
  evidenceItems: RunEvidenceListResponse['items'],
  search: RunEvidenceFocusSearch,
): { stepRunId?: string; attemptId?: string; evidenceId?: string; mismatch: boolean } {
  if (search.evidenceId) {
    const item = evidenceItems.find((entry) => entry.id === search.evidenceId)
    if (!item) return { mismatch: true }
    if (search.stepRunId && item.stepRunId && item.stepRunId !== search.stepRunId) return { mismatch: true }
    if (search.attemptId && item.attemptId && item.attemptId !== search.attemptId) return { mismatch: true }
    return {
      mismatch: false,
      evidenceId: item.id,
      stepRunId: item.stepRunId ?? search.stepRunId,
      attemptId: item.attemptId ?? search.attemptId,
    }
  }
  if (search.stepRunId && !run.stepRuns.some((step) => step.id === search.stepRunId)) {
    return { mismatch: true }
  }
  if (
    search.attemptId &&
    !run.stepRuns.some((step) => step.attempts.some((attempt) => attempt.id === search.attemptId))
  ) {
    return { mismatch: true }
  }
  return {
    mismatch: false,
    stepRunId: search.stepRunId,
    attemptId: search.attemptId,
  }
}
