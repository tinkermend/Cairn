import {
  MAP_VERIFY_RULE_VERSION,
  type MapDimensionStat,
  type MapObservation,
  type MapVerification,
  type MapVerificationDimension,
  type MapVerificationVerdict,
  type MapWritableLifecycle,
} from '@cairn/shared'

export type Attribution = {
  ruleVersion: typeof MAP_VERIFY_RULE_VERSION
  dimension: MapVerificationDimension
  verdict: MapVerificationVerdict
  allowSuccessCount: boolean
  importanceDelta: 0
  coverage: 'observed' | 'unknown' | 'not_observed'
  deleteObject: false
  miss: false
  reasons: string[]
}

const UNKNOWN_COVERAGE_REASONS = new Set([
  'TIME_BUDGET',
  'TRUNCATED',
  'BASELINE_UNAVAILABLE',
  'CAPABILITY_MISSING',
  'SURFACE_CHANGED',
  'PROCESS_LOST',
])

function observationSignals(observations: MapObservation[]) {
  const missing = observations.flatMap((item) => item.missingReasons)
  const captureReasons = observations.flatMap((item) => (item.captureReason ? [item.captureReason] : []))
  const truncated = observations.some((item) => item.truncated || item.completeness !== 'complete')
  const loading = observations.some((item) =>
    item.semanticSummary.predicates.some((predicate) => predicate.name === 'loading' && predicate.value === true),
  )
  const virtual = observations.some((item) =>
    item.semanticSummary.predicates.some(
      (predicate) => predicate.name === 'virtualized' && predicate.value === true,
    ),
  )
  const identityRejected = observations.some(
    (item) =>
      item.judgement?.identity?.note === 'wrong-click' ||
      item.semanticSummary.predicates.some((predicate) => predicate.name === 'identityWrong' && predicate.value === true),
  )
  const identityConfirmed = observations.some((item) => item.judgement?.identity?.verdict === 'confirmed')
  const locatorConfirmed = observations.some((item) => item.judgement?.locator?.verdict === 'confirmed')
  return {
    missing,
    captureReasons,
    truncated,
    loading,
    virtual,
    identityRejected,
    identityConfirmed,
    locatorConfirmed,
  }
}

export function attributeVerification(input: {
  verification: MapVerification
  observations: MapObservation[]
}): Attribution {
  const signals = observationSignals(input.observations)
  const reasons = [`ruleVersion:${MAP_VERIFY_RULE_VERSION}`]
  if (
    signals.truncated ||
    signals.loading ||
    signals.virtual ||
    [...signals.missing, ...signals.captureReasons].some((reason) => UNKNOWN_COVERAGE_REASONS.has(reason))
  ) {
    reasons.push('coverage-unknown')
    return {
      ruleVersion: MAP_VERIFY_RULE_VERSION,
      dimension: input.verification.dimension,
      verdict: 'not_observed',
      allowSuccessCount: false,
      importanceDelta: 0,
      coverage: 'unknown',
      deleteObject: false,
      miss: false,
      reasons,
    }
  }
  if (input.verification.dimension === 'business' && input.verification.verdict === 'rejected') {
    reasons.push('business-rejected-keep-locator')
    return {
      ruleVersion: MAP_VERIFY_RULE_VERSION,
      dimension: 'business',
      verdict: 'rejected',
      allowSuccessCount: false,
      importanceDelta: 0,
      coverage: 'observed',
      deleteObject: false,
      miss: false,
      reasons,
    }
  }
  if (input.verification.dimension === 'identity' && input.verification.verdict === 'rejected') {
    reasons.push('wrong-target-no-success')
    return {
      ruleVersion: MAP_VERIFY_RULE_VERSION,
      dimension: 'identity',
      verdict: 'rejected',
      allowSuccessCount: false,
      importanceDelta: 0,
      coverage: 'observed',
      deleteObject: false,
      miss: false,
      reasons,
    }
  }
  if (
    input.verification.dimension === 'action' &&
    input.verification.verdict === 'confirmed' &&
    (signals.identityConfirmed || signals.locatorConfirmed)
  ) {
    reasons.push('action-confirmed-not-business')
    return {
      ruleVersion: MAP_VERIFY_RULE_VERSION,
      dimension: 'action',
      verdict: 'confirmed',
      allowSuccessCount: true,
      importanceDelta: 0,
      coverage: 'observed',
      deleteObject: false,
      miss: false,
      reasons,
    }
  }
  if (signals.identityRejected && input.verification.verdict === 'confirmed') {
    reasons.push('toast-success-after-wrong-click')
    return {
      ruleVersion: MAP_VERIFY_RULE_VERSION,
      dimension: input.verification.dimension,
      verdict: input.verification.verdict,
      allowSuccessCount: false,
      importanceDelta: 0,
      coverage: 'observed',
      deleteObject: false,
      miss: false,
      reasons,
    }
  }
  return {
    ruleVersion: MAP_VERIFY_RULE_VERSION,
    dimension: input.verification.dimension,
    verdict: input.verification.verdict,
    allowSuccessCount: input.verification.verdict === 'confirmed',
    importanceDelta: 0,
    coverage: 'observed',
    deleteObject: false,
    miss: false,
    reasons,
  }
}

export function applyDimension(existing: MapDimensionStat | undefined, attribution: Attribution): MapDimensionStat {
  const next: MapDimensionStat = existing
    ? { ...existing }
    : {
        dimension: attribution.dimension,
        verdict: attribution.verdict,
        confirmedCount: 0,
        rejectedCount: 0,
        unknownCount: 0,
      }
  next.dimension = attribution.dimension
  next.verdict = attribution.verdict
  if (attribution.verdict === 'confirmed' && attribution.allowSuccessCount) next.confirmedCount += 1
  else if (attribution.verdict === 'rejected') next.rejectedCount += 1
  else next.unknownCount += 1
  return next
}

export function lifecycleFromEvidence(input: {
  hasObservation: boolean
  dimensions: MapDimensionStat[]
}): MapWritableLifecycle {
  if (input.dimensions.some((item) => item.verdict === 'rejected')) return 'DEGRADED'
  if (input.dimensions.some((item) => item.verdict === 'confirmed')) return 'VERIFIED'
  if (input.hasObservation) return 'OBSERVED'
  return 'DISCOVERED'
}

export function mergeLocalState(
  current: Record<string, unknown> | undefined,
  observation: MapObservation,
): Record<string, unknown> {
  return {
    ...(current ?? {}),
    ...observation.stateSummary.regions,
    predicates: observation.semanticSummary.predicates,
  }
}
