import { MODULE_EXTERNAL_INFRA_ERROR_CODES, type ModuleInvocationAttribution } from './action-module-quality.js'
import {
  candidateGroupsOf,
  type CandidateGroup,
  type SelectionDecision,
  type SkipReason,
  SELECTION_DECISION_PROTOCOL,
} from './authoring-document.js'
import type { StepRunStatus } from './run.js'

export { candidateGroupsOf }

export function findCandidateGroup(
  groups: readonly CandidateGroup[],
  stepId: string,
): { group: CandidateGroup; alternativeIndex: number; stepIndex: number } | undefined {
  for (const group of groups) {
    for (const [alternativeIndex, alternative] of group.alternatives.entries()) {
      const stepIndex = alternative.stepIds.indexOf(stepId)
      if (stepIndex >= 0) return { group, alternativeIndex, stepIndex }
    }
  }
  return undefined
}

export function remainingStepIdsOfAlternative(
  group: CandidateGroup,
  alternativeIndex: number,
  afterStepId: string,
): string[] {
  const alternative = group.alternatives[alternativeIndex]
  if (!alternative) return []
  const index = alternative.stepIds.indexOf(afterStepId)
  if (index < 0) return []
  return alternative.stepIds.slice(index + 1)
}

export function laterAlternativeStepIds(group: CandidateGroup, alternativeIndex: number): string[] {
  return group.alternatives.slice(alternativeIndex + 1).flatMap((item) => item.stepIds)
}

export function commitStagedOutputs(
  context: Record<string, unknown>,
  staging: Record<string, string>,
): Record<string, unknown> {
  const next = { ...context }
  for (const [exposedKey, namespacedKey] of Object.entries(staging)) {
    if (namespacedKey in next) next[exposedKey] = next[namespacedKey]
  }
  return next
}

export function skipReasonForStep(input: {
  stepId: string
  group: CandidateGroup
  stepStatus: StepRunStatus
  selected?: string
  attemptedKeys: readonly string[]
}): SkipReason | undefined {
  if (input.stepStatus !== 'SKIPPED') return undefined
  const alternative = input.group.alternatives.find((item) => item.stepIds.includes(input.stepId))
  if (!alternative) return undefined
  if (input.attemptedKeys.includes(alternative.implementationKey)) {
    return alternative.implementationKey === input.selected ? undefined : 'fallback'
  }
  if (input.selected) return 'not_needed'
  return 'not_attempted'
}

const EXTERNAL_INFRA_CODES = new Set<string>(MODULE_EXTERNAL_INFRA_ERROR_CODES)

export function fallbackAttribution(
  error: { code?: string; category?: string } | null | undefined,
): Exclude<ModuleInvocationAttribution, 'UPSTREAM'> {
  if (error?.code && EXTERNAL_INFRA_CODES.has(error.code)) return 'EXTERNAL_INFRA'
  if (error?.category === 'INFRASTRUCTURE') return 'EXTERNAL_INFRA'
  if (error?.category === 'UNKNOWN' || !error?.category) return 'UNKNOWN'
  return 'MODULE'
}

export function shouldFallbackToNext(input: {
  attribution: ModuleInvocationAttribution
  runStatus?: 'FAILED' | 'NEEDS_REVIEW' | 'HOLDING' | 'SUCCEEDED'
  debugHold: boolean
  hasNextAlternative: boolean
}): boolean {
  if (input.debugHold || input.runStatus === 'NEEDS_REVIEW' || input.runStatus === 'HOLDING') return false
  if (!input.hasNextAlternative) return false
  return input.attribution === 'MODULE'
}

export function selectionDecisionFromGroup(input: {
  group: CandidateGroup
  attempted: Array<{
    implementationKey: string
    outcome: 'succeeded' | 'failed' | 'skipped'
    attribution?: Exclude<ModuleInvocationAttribution, 'UPSTREAM'>
    failedStepId?: string
  }>
  selected?: string
  runStatus?: string
}): SelectionDecision {
  const lastFailed = [...input.attempted].reverse().find((item) => item.outcome === 'failed')
  const reason = input.selected
    ? 'selected'
    : input.runStatus === 'NEEDS_REVIEW'
      ? 'needs_review'
      : lastFailed?.attribution === 'EXTERNAL_INFRA'
        ? 'external_infra'
        : lastFailed?.attribution === 'UNKNOWN'
          ? 'unknown'
          : 'all_failed'
  return {
    kind: 'module_selection_decision',
    protocol: SELECTION_DECISION_PROTOCOL,
    invocationId: input.group.invocationId,
    attempts: input.attempted,
    ...(input.selected ? { selected: input.selected } : {}),
    reason,
  }
}

export function isSelectionDecision(payload: unknown): payload is SelectionDecision {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as { protocol?: string }).protocol === SELECTION_DECISION_PROTOCOL &&
      (payload as { kind?: string }).kind === 'module_selection_decision',
  )
}
