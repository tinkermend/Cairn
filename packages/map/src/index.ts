export {
  classifyRoute,
  cluesFromObservation,
  matchObjectIdentity,
  matchPageIdentity,
  objectAllocationKey,
  stableObjectToken,
} from './identity.js'
export { chooseImplementation, evaluateCondition, isMoreSpecific, knownConditionFields } from './conditions.js'
export { applyDimension, attributeVerification, lifecycleFromEvidence, mergeLocalState } from './verification.js'
export { emptyProjectionPlan, planProjectionBatch } from './projection.js'
export { queryMap } from './query.js'
export {
  applyGovernanceOverlay,
  mapListQueryKey,
  mapCursorPayload,
  parseMapCursorPayload,
  proposeMapReferenceCandidates,
  cluesFromScenarioStep,
  gradeMapImpact,
  resolveBindingAfterIdentity,
  groupMapDiagnosisClues,
  overlayLifecycleMap,
  applyDetailApplicability,
} from './governance.js'
export type { ScenarioStepClue, MapScanAsset, MapReferenceCandidate } from './governance.js'
export {
  composeKnowledgeSuggestion,
  copyModuleStepsAsIndependent,
  matchPublishedModules,
  matchTerminologyCandidates,
  redactKnowledgeQuestion,
} from './authoring.js'
export type {
  KnowledgeComposeInput,
  KnowledgeComposeResult,
  PublishedModuleKnowledge,
  TerminologyMatchInput,
} from './authoring.js'
export {
  isStepEligibleForMapConsumption,
  operableBindingsForStep,
  applicabilityReason,
  chooseUniqueLocatedCandidate,
  preserveConsumptionScope,
  reasonForBaselineError,
  canEnterCandidateBranch,
} from './consumption.js'
export type { LocatedCandidate } from './consumption.js'
export { isUnsafeMapActionName, toMapJobCompileAssets, selectMapJobAssets, compileMapJobSlice } from './jobs.js'
export type { MapJobCompileAsset } from './jobs.js'
export {
  seedUrlsForExploration,
  buildObservationBundle,
  proposeExploreHop,
  decideExploreGuard,
} from './exploration.js'
export type { FactReader, MapFactPageItem, MapQueryPort, ProjectionWriter } from './ports.js'
