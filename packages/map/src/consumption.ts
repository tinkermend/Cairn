import { canonicalJson } from '@cairn/shared'
import { evaluateCondition } from './conditions.js'
import type {
  MapConditionSnapshot,
  MapConditionTri,
  MapConsumptionAllowedStepType,
  MapConsumptionPolicy,
  MapFrozenBinding,
  MapSelectionReasonCode,
  Step,
  TargetDescriptor,
} from '@cairn/shared'

export function isStepEligibleForMapConsumption(
  step: Pick<Step, 'type' | 'effectType'>,
  policy: MapConsumptionPolicy,
): { ok: true } | { ok: false; reasonCode: MapSelectionReasonCode } {
  if (step.effectType !== 'READ_ONLY') return { ok: false, reasonCode: 'EFFECT_NOT_READ_ONLY' }
  if (!policy.allowedStepTypes.includes(step.type as MapConsumptionAllowedStepType)) {
    return { ok: false, reasonCode: 'STEP_NOT_ELIGIBLE' }
  }
  return { ok: true }
}

export function operableBindingsForStep(
  bindings: readonly MapFrozenBinding[],
  stepId: string,
): { operable: MapFrozenBinding[]; pageOnly: boolean; none: boolean } {
  const forStep = bindings.filter((item) => item.stepId === stepId)
  const operable = forStep.filter(
    (item) =>
      Boolean(item.assetRef.objectId) &&
      Boolean(item.assetRef.implementationKey) &&
      item.assetRef.descriptorVersion != null,
  )
  return {
    operable,
    pageOnly: forStep.length > 0 && operable.length === 0,
    none: forStep.length === 0,
  }
}

export function applicabilityReason(
  required: MapConditionSnapshot | undefined,
  observed: MapConditionSnapshot,
): { match: MapConditionTri; reasonCode?: MapSelectionReasonCode } {
  if (!required) return { match: 'unknown', reasonCode: 'CONDITION_UNKNOWN' }
  const match = evaluateCondition(required, observed)
  if (match === 'unknown') return { match, reasonCode: 'CONDITION_UNKNOWN' }
  if (match === 'unsatisfied') return { match, reasonCode: 'CONDITION_UNSATISFIED' }
  return { match }
}

export type LocatedCandidate = {
  binding: MapFrozenBinding
  descriptor: TargetDescriptor
  objectId: string
  matches: number
  outcome: 'FOUND' | 'NOT_FOUND' | 'AMBIGUOUS' | 'SURFACE_LOST' | 'CAPABILITY_MISSING' | 'SKIPPED'
}

export function chooseUniqueLocatedCandidate(located: readonly LocatedCandidate[]): {
  selected?: LocatedCandidate
  reasonCode: MapSelectionReasonCode
} {
  const found = located.filter((item) => item.outcome === 'FOUND' && item.matches === 1)
  if (found.length === 0) return { reasonCode: 'LOCATE_FAILED' }
  const objects = new Set(found.map((item) => item.objectId))
  if (objects.size > 1) return { reasonCode: 'AMBIGUOUS_CANDIDATES' }
  // Two implementations can still resolve to different DOM nodes of the same business object.
  if (found.length > 1 || located.some(item => item.outcome === 'AMBIGUOUS')) return { reasonCode: 'AMBIGUOUS_CANDIDATES' }
  return { selected: found[0], reasonCode: found[0] ? 'FALLBACK_USED' : 'NO_UNIQUE_CANDIDATE' }
}

export function reasonForBaselineError(code: string | undefined): MapSelectionReasonCode {
  if (code === 'TARGET_NOT_FOUND') return 'TARGET_NOT_FOUND'
  if (code === 'TARGET_AMBIGUOUS') return 'BASELINE_AMBIGUOUS'
  if (code === 'SURFACE_LOST') return 'BASELINE_SURFACE_LOST'
  return 'BASELINE_OTHER'
}

export function canEnterCandidateBranch(input: {
  baselineOk: boolean
  errorCode?: string
  cancelled?: boolean
  remainingMs: number
}): { enter: boolean; reasonCode?: MapSelectionReasonCode } {
  if (input.cancelled) return { enter: false, reasonCode: 'CANCELLED' }
  if (input.remainingMs <= 0) return { enter: false, reasonCode: 'BUDGET_EXHAUSTED' }
  if (input.baselineOk) return { enter: false, reasonCode: 'BASELINE_FOUND' }
  if (input.errorCode !== 'TARGET_NOT_FOUND') {
    return { enter: false, reasonCode: reasonForBaselineError(input.errorCode) }
  }
  return { enter: true }
}

/** A locator may change; the original frame and business-record scope may not. */
export function preserveConsumptionScope(original: TargetDescriptor, candidate: TargetDescriptor): TargetDescriptor | undefined {
  if (canonicalJson(original.framePath) !== canonicalJson(candidate.framePath)) return undefined
  if (candidate.anchor && canonicalJson(candidate.anchor) !== canonicalJson(original.anchor ?? null)) return undefined
  return { ...candidate, ...(original.anchor ? { anchor: original.anchor } : {}) }
}
