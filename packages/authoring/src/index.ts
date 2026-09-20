export { compileScenarioDocument } from './compiler.js'
export { compileForAssistant } from './assistant-compile.js'
export { compileModuleContent } from './module-compile.js'
export {
  deriveOutcomeManifest,
  deriveRuntimeInvariantManifest,
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
