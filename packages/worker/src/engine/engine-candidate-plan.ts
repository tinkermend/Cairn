import {
  candidateGroupsOf,
  commitStagedOutputs,
  fallbackAttribution,
  findCandidateGroup,
  laterAlternativeStepIds,
  remainingStepIdsOfAlternative,
  selectionDecisionFromGroup,
  shouldFallbackToNext,
  type CandidateGroup,
  type ExecutionError,
  type JsonValue,
  type RunDetailDto,
  type RunSnapshot,
  type SelectionDecision,
} from '@cairn/shared'
import { jsonContext } from './engine-step-plan.js'

export function attemptedFromDetail(
  group: CandidateGroup,
  detail: RunDetailDto | null | undefined,
  current: { implementationKey: string; outcome: 'succeeded' | 'failed'; attribution?: 'MODULE' | 'EXTERNAL_INFRA' | 'UNKNOWN'; failedStepId?: string },
) {
  const byId = new Map(detail?.stepRuns.map((item) => [item.stepId, item]) ?? [])
  const attempts = group.alternatives.map((alternative) => {
    if (alternative.implementationKey === current.implementationKey) return current
    const failed = alternative.stepIds.find((stepId) => byId.get(stepId)?.status === 'FAILED')
    if (failed) {
      const error = byId.get(failed)?.attempts.find((item) => item.status === 'FAILED')?.error
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
  detail: RunDetailDto | null
}): { context?: Record<string, JsonValue>; skipStepIds?: string[]; selectionDecision?: SelectionDecision; last: boolean } | undefined {
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
  detail: RunDetailDto | null
}): { keepRunOpen?: boolean; skipStepIds?: string[]; selectionDecision?: SelectionDecision } | undefined {
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
    return {
      keepRunOpen: true,
      skipStepIds: remainingStepIdsOfAlternative(found.group, found.alternativeIndex, input.stepId),
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
  detail: RunDetailDto | null
}): { skipStepIds?: string[]; selectionDecision?: SelectionDecision } | undefined {
  const found = findCandidateGroup(candidateGroupsOf(input.snapshot), input.stepId)
  if (!found) return undefined
  return {
    skipStepIds: [
      ...remainingStepIdsOfAlternative(found.group, found.alternativeIndex, input.stepId),
      ...laterAlternativeStepIds(found.group, found.alternativeIndex),
    ],
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
