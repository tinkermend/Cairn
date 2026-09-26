import {
  candidateGroupsOf,
  commitStagedOutputs,
  fallbackAttribution,
  findCandidateGroup,
  laterAlternativeStepIds,
  remainingStepIdsOfAlternative,
  selectionDecisionFromGroup,
  shouldFallbackToNext,
  stepRunMapByStep,
  type CandidateGroup,
  type ExecutionError,
  type JsonValue,
  type RunDetailDto,
  type RunSnapshot,
  type SelectionDecision,
  type StepSkipReason,
} from '@cairn/shared'
import { jsonContext } from './engine-step-plan.js'

export type CandidatePlanDetail = {
  stepRuns: Array<{
    stepId: string
    status: string
    attempts?: Array<{ status: string; error?: ExecutionError | null }>
  }>
}

export function attemptedFromDetail(
  group: CandidateGroup,
  detail: CandidatePlanDetail | null | undefined,
  current: { implementationKey: string; outcome: 'succeeded' | 'failed'; attribution?: 'MODULE' | 'EXTERNAL_INFRA' | 'UNKNOWN'; failedStepId?: string },
) {
  const byId = stepRunMapByStep(detail?.stepRuns ?? [])
  const attempts = group.alternatives.map((alternative) => {
    if (alternative.implementationKey === current.implementationKey) return current
    const failed = alternative.stepIds.find((stepId) => byId.get(stepId)?.status === 'FAILED')
    if (failed) {
      const error = byId.get(failed)?.attempts?.find((item) => item.status === 'FAILED')?.error
      return {
        implementationKey: alternative.implementationKey,
        outcome: 'failed' as const,
        attribution: fallbackAttribution(error),
        failedStepId: failed,
      }
    }
    if (alternative.stepIds.every((stepId) => byId.get(stepId)?.status === 'SUCCEEDED')) {
      return { implementationKey: alternative.implementationKey, outcome: 'succeeded' as const }
    }
    if (alternative.stepIds.some((stepId) => byId.get(stepId)?.status === 'SKIPPED' || byId.get(stepId)?.status === 'PENDING')) {
      return { implementationKey: alternative.implementationKey, outcome: 'skipped' as const }
    }
    return { implementationKey: alternative.implementationKey, outcome: 'skipped' as const }
  })
  return attempts
}

export function planCandidateSuccess(input: {
  snapshot: RunSnapshot
  stepId: string
  context: Record<string, JsonValue>
  last: boolean
  detail: CandidatePlanDetail | null
}): { context?: Record<string, JsonValue>; skipStepIds?: string[]; skips?: Array<{ stepIds: string[]; reason: StepSkipReason }>; selectionDecision?: SelectionDecision; last: boolean } | undefined {
  const found = findCandidateGroup(candidateGroupsOf(input.snapshot), input.stepId)
  if (!found) return undefined
  const alternative = found.group.alternatives[found.alternativeIndex]!
  if (found.stepIndex !== alternative.stepIds.length - 1) return { last: input.last }
  const skipStepIds = laterAlternativeStepIds(found.group, found.alternativeIndex)
  const last =
    input.last ||
    Boolean(
      input.detail &&
        input.detail.stepRuns.every(
          (item) =>
            item.stepId === input.stepId ||
            skipStepIds.includes(item.stepId) ||
            (item.status !== 'PENDING' && item.status !== 'RUNNING'),
        ),
    )
  return {
    context: jsonContext(commitStagedOutputs(input.context, alternative.outputStaging)),
    skipStepIds,
    skips: skipStepIds.length > 0 ? [{ stepIds: skipStepIds, reason: 'fallback_not_selected' as const }] : undefined,
    selectionDecision: selectionDecisionFromGroup({
      group: found.group,
      attempted: attemptedFromDetail(found.group, input.detail, {
        implementationKey: alternative.implementationKey,
        outcome: 'succeeded',
      }),
      selected: alternative.implementationKey,
    }),
    last,
  }
}

export function planCandidateFailure(input: {
  snapshot: RunSnapshot
  stepId: string
  error: ExecutionError
  debugHold: boolean
  detail: CandidatePlanDetail | null
}): { keepRunOpen?: boolean; skipStepIds?: string[]; skips?: Array<{ stepIds: string[]; reason: StepSkipReason }>; selectionDecision?: SelectionDecision } | undefined {
  const found = findCandidateGroup(candidateGroupsOf(input.snapshot), input.stepId)
  if (!found) return undefined
  const attribution = fallbackAttribution(input.error)
  const hasNext = found.alternativeIndex < found.group.alternatives.length - 1
  const current = {
    implementationKey: found.group.alternatives[found.alternativeIndex]!.implementationKey,
    outcome: 'failed' as const,
    attribution,
    failedStepId: input.stepId,
  }
  if (
    shouldFallbackToNext({
      attribution,
      debugHold: input.debugHold,
      hasNextAlternative: hasNext,
    })
  ) {
    const skipStepIds = remainingStepIdsOfAlternative(found.group, found.alternativeIndex, input.stepId)
    return {
      keepRunOpen: true,
      skipStepIds,
      skips: skipStepIds.length > 0 ? [{ stepIds: skipStepIds, reason: 'fallback_abandoned' as const }] : undefined,
    }
  }
  return {
    selectionDecision: selectionDecisionFromGroup({
      group: found.group,
      attempted: attemptedFromDetail(found.group, input.detail, current),
      runStatus: 'FAILED',
    }),
  }
}

export function planCandidateHalt(input: {
  snapshot: RunSnapshot
  stepId: string
  error: ExecutionError
  runStatus: 'NEEDS_REVIEW'
  detail: CandidatePlanDetail | null
}): { skipStepIds?: string[]; skips?: Array<{ stepIds: string[]; reason: StepSkipReason }>; selectionDecision?: SelectionDecision } | undefined {
  const found = findCandidateGroup(candidateGroupsOf(input.snapshot), input.stepId)
  if (!found) return undefined
  const skipStepIds = [
    ...remainingStepIdsOfAlternative(found.group, found.alternativeIndex, input.stepId),
    ...laterAlternativeStepIds(found.group, found.alternativeIndex),
  ]
  return {
    skipStepIds,
    skips: skipStepIds.length > 0 ? [{ stepIds: skipStepIds, reason: 'run_halted' as const }] : undefined,
    selectionDecision: selectionDecisionFromGroup({
      group: found.group,
      attempted: attemptedFromDetail(found.group, input.detail, {
        implementationKey: found.group.alternatives[found.alternativeIndex]!.implementationKey,
        outcome: 'failed',
        attribution: fallbackAttribution(input.error),
        failedStepId: input.stepId,
      }),
      runStatus: input.runStatus,
    }),
  }
}
