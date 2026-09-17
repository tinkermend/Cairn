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
