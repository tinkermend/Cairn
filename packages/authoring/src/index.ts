export { compileScenarioDocument, validateAriaSnapshotTemplate } from './compiler.js'
export { compileForAssistant } from './assistant-compile.js'
export { compileModuleContent } from './module-compile.js'
export {
  deriveOutcomeManifest,
  deriveRuntimeInvariantManifest,
  deriveControlFlowManifest,
  deterministicStepId,
  resolveOutcomeWriteback,
  expandAuthoringDocument,
  moduleContentDigest,
  singleImplementationDigest,
  type LoadedModuleVersion,
  type ExpansionContext,
  type ExpansionResult,
} from './expand.js'
export {
  applyModuleReplace,
  applyModuleUpgrade,
  buildExtractedModuleContent,
  buildReplaceInvocation,
  compareReplaceSteps,
  diffModuleVersions,
  proposeModuleFromSteps,
  unconfirmedUpgradeWarnings,
  unresolvedUpgradeBlockers,
} from './upgrade.js'
export {
  collectAvailableContextKeys,
  decideResolveStatus,
  extractLiteralCandidates,
  insertModuleInvocation,
  resolveModulesByRules,
  suggestModuleInputs,
  suggestionToBinding,
} from './resolver.js'
export { DemonstrationParseError, parseDemonstrationFile, sanitizeDemonstrationSource, sanitizeDemonstrationUrl, demonstrationFactDigest } from './demonstration-adapters.js'
export { suggestDemonstration, previewDemonstration, applyDemonstrationToDocument, DemonstrationApplyError } from './demonstration.js'
export { validationSubjectDigest, validationRunDigests, classifyValidationSample } from './validation.js'
export {
  canonicalizeJson,
  stripNonSemanticFields,
  computeContractDigest,
  computeExecutionDigest,
  computeSourceDefinitionDigest,
} from './digest.js'
export {
  evaluatePatchGuards,
  computeDigestManifest,
  type EvaluatePatchGuardsOptions,
} from './patch-guard.js'
export {
  buildDemonstrationSemanticProposal,
  type BuildDemonstrationSemanticProposalOptions,
  type ModelGroupInput,
} from './demonstration-semantic.js'
export {
  computeDatasetProfile,
  type ComputeDatasetProfileOptions,
} from './dataset-profiler.js'
export {
  buildV2AuthoringSlice,
  type SlicedAuthoringResult,
} from './authoring-slice.js'
