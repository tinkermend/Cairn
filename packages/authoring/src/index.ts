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
export { aiTraceToDemonstrationSource, type AiTraceToDemonstrationSourceInput } from './ai-trace-adapter.js'
export { validationSubjectDigest, validationRunDigests, classifyValidationSample } from './validation.js'
export {
  canonicalizeJson,
  stripNonSemanticFields,
  computeContractDigest,
  computeExecutionDigest,
  computeSourceDefinitionDigest,
  computeTargetDigest,
} from './digest.js'
export {
  evaluatePatchGuards,
  computeDigestManifest,
  type EvaluatePatchGuardsOptions,
} from './patch-guard.js'
export {
  applyPatchToDocument,
  findStepInDocument,
  PatchApplyError,
} from './patch-apply.js'
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
export {
  applyAuthoringOperations,
  type ApplyAuthoringOperationsResult,
  type ApplyAuthoringOperationsOptions,
} from './authoring-operations.js'
export {
  foldRecordingGeneralization,
  type FoldRecordingGeneralizationResult,
} from './recording-generalization.js'
export {
  generateQuickActionRound,
  interpretGeneralizationIntent,
  type GenerateQuickActionRoundOptions,
  type GenerateQuickActionRoundResult,
  type InterpretGeneralizationIntentOptions,
  type TargetDataset,
  type TargetDatasetColumn,
} from './recording-rules.js'
