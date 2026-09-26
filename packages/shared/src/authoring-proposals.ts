import { z } from 'zod'
import { entityIdSchema, utcInstantSchema, jsonValueSchema, timeoutMsSchema } from './wire.js'
import {
  outcomeContractSchema,
  outcomeRuleSchema,
  outcomeSeveritySchema,
  outcomeOnViolationSchema,
  type OutcomeContract,
  type OutcomeSeverity,
  type OutcomeOnViolation,
} from './outcome.js'
import { scenarioOutputDeclSchema, type ScenarioOutputDecl } from './run-output.js'
import {
  contextKeySchema,
  effectTypeSchema,
  executableStepTypeSchema,
  scenarioInputTypeSchema,
  stepSchema,
  type EffectType,
  type ScenarioInputType,
  type Step,
  type ExecutableStepType,
} from './step.js'
import { authoringNodeSchema, type AuthoringNode } from './authoring-document.js'
import { compileDiagnosticSchema, type CompileDiagnostic } from './scenario.js'
import { dataBindingSchema, type DataBinding } from './dataset.js'

export const digestHexSchema = z.string().regex(/^[a-f0-9]{64}$/, '摘要须为 64 位十六进制 SHA-256')

// ---------------------------------------------------------------------------
// C0: Assistant Authoring Proposal & Operations (Structured Draft Editing)
// ---------------------------------------------------------------------------

export const AUTHORING_ALLOWED_STEP_TYPES = [
  'navigate',
  'click',
  'fill',
  'extract',
  'assert',
  'select',
  'keyboard',
  'wait',
  'ai_action',
  'ai_extract',
  'ai_assert',
] as const
export type AuthoringAllowedStepType = (typeof AUTHORING_ALLOWED_STEP_TYPES)[number]
export const authoringAllowedStepTypeSchema = z.enum(AUTHORING_ALLOWED_STEP_TYPES)

export function isAuthoringAllowedStepType(type: string): type is AuthoringAllowedStepType {
  return (AUTHORING_ALLOWED_STEP_TYPES as readonly string[]).includes(type)
}

export const AUTHORING_STEP_FIELD_POLICIES: Record<
  AuthoringAllowedStepType,
  {
    allowedInputKeys: readonly string[]
    allowsOutputKey: boolean
  }
> = {
  navigate: {
    allowedInputKeys: ['url'],
    allowsOutputKey: false,
  },
  click: {
    allowedInputKeys: ['target'],
    allowsOutputKey: false,
  },
  select: {
    allowedInputKeys: ['target', 'value', 'label'],
    allowsOutputKey: false,
  },
  keyboard: {
    allowedInputKeys: ['target', 'key'],
    allowsOutputKey: false,
  },
  wait: {
    allowedInputKeys: ['target', 'condition', 'timeoutMs', 'kind', 'durationMs', 'urlPattern', 'text'],
    allowsOutputKey: false,
  },
  fill: {
    allowedInputKeys: ['target', 'from', 'fromField', 'value', 'sensitive'],
    allowsOutputKey: false,
  },
  extract: {
    allowedInputKeys: ['target', 'as', 'attribute', 'many'],
    allowsOutputKey: true,
  },
  assert: {
    allowedInputKeys: ['target', 'expect'],
    allowsOutputKey: false,
  },
  ai_action: {
    allowedInputKeys: ['instruction'],
    allowsOutputKey: false,
  },
  ai_extract: {
    allowedInputKeys: ['instruction', 'schema'],
    allowsOutputKey: true,
  },
  ai_assert: {
    allowedInputKeys: ['instruction'],
    allowsOutputKey: false,
  },
}

export const authoringInsertStepOperationSchema = z.strictObject({
  kind: z.literal('insert_step'),
  id: z.string().min(1).max(128),
  step: stepSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  anchorStepId: z.string().min(1).max(128).nullable().optional(),
})
export type AuthoringInsertStepOperation = z.infer<typeof authoringInsertStepOperationSchema>

export const authoringUpdateStepOperationSchema = z.strictObject({
  kind: z.literal('update_step'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  patch: z.strictObject({
    name: z.string().trim().min(1).max(128).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    outputKey: contextKeySchema.optional(),
  }),
})
export type AuthoringUpdateStepOperation = z.infer<typeof authoringUpdateStepOperationSchema>

export const authoringRemoveStepOperationSchema = z.strictObject({
  kind: z.literal('remove_step'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
})
export type AuthoringRemoveStepOperation = z.infer<typeof authoringRemoveStepOperationSchema>

export const authoringMoveStepOperationSchema = z.strictObject({
  kind: z.literal('move_step'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  anchorStepId: z.string().min(1).max(128).nullable().optional(),
})
export type AuthoringMoveStepOperation = z.infer<typeof authoringMoveStepOperationSchema>

export const authoringSetStepPolicyOperationSchema = z.strictObject({
  kind: z.literal('set_step_policy'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  timeoutMs: timeoutMsSchema.optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
})
export type AuthoringSetStepPolicyOperation = z.infer<typeof authoringSetStepPolicyOperationSchema>

export const authoringAddOutcomeOperationSchema = z.strictObject({
  kind: z.literal('add_outcome'),
  id: z.string().min(1).max(128),
  stepId: entityIdSchema,
  meaning: z.string().min(1).max(512),
  rule: outcomeRuleSchema,
  severity: outcomeSeveritySchema.default('SHOULD'),
  onViolation: outcomeOnViolationSchema.default('continue'),
})
export type AuthoringAddOutcomeOperation = z.infer<typeof authoringAddOutcomeOperationSchema>

export const authoringOperationSchema = z.discriminatedUnion('kind', [
  authoringInsertStepOperationSchema,
  authoringUpdateStepOperationSchema,
  authoringRemoveStepOperationSchema,
  authoringMoveStepOperationSchema,
  authoringSetStepPolicyOperationSchema,
  authoringAddOutcomeOperationSchema,
])
export type AuthoringOperation = z.infer<typeof authoringOperationSchema>

export const authoringDiffAddSchema = z.strictObject({
  type: z.literal('add'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  index: z.number().int().nonnegative(),
  detail: z.string().max(512).optional(),
  riskLevel: effectTypeSchema.optional(),
})
export type AuthoringDiffAdd = z.infer<typeof authoringDiffAddSchema>

export const authoringDiffRemoveSchema = z.strictObject({
  type: z.literal('remove'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  index: z.number().int().nonnegative(),
  detail: z.string().max(512).optional(),
  riskLevel: effectTypeSchema.optional(),
})
export type AuthoringDiffRemove = z.infer<typeof authoringDiffRemoveSchema>

export const authoringDiffModifySchema = z.strictObject({
  type: z.literal('modify'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  fieldPath: z.array(z.string().min(1)).max(8),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  sensitive: z.boolean().optional(),
})
export type AuthoringDiffModify = z.infer<typeof authoringDiffModifySchema>

export const authoringDiffMoveSchema = z.strictObject({
  type: z.literal('move'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  stepType: executableStepTypeSchema,
  parentBlockId: entityIdSchema.optional(),
  branchKey: z.enum(['then', 'else', 'body']).optional(),
  fromIndex: z.number().int().nonnegative(),
  toIndex: z.number().int().nonnegative(),
  detail: z.string().max(512).optional(),
})
export type AuthoringDiffMove = z.infer<typeof authoringDiffMoveSchema>

export const authoringDiffOutcomeAddSchema = z.strictObject({
  type: z.literal('outcome_add'),
  stepId: entityIdSchema,
  stepName: z.string().min(1).max(128),
  contractId: entityIdSchema,
  meaning: z.string().min(1).max(512),
  ruleKind: z.enum(['deterministic', 'ai']),
  severity: outcomeSeveritySchema,
  onViolation: outcomeOnViolationSchema,
  detail: z.string().max(512).optional(),
})
export type AuthoringDiffOutcomeAdd = z.infer<typeof authoringDiffOutcomeAddSchema>

export const authoringDiffSchema = z.discriminatedUnion('type', [
  authoringDiffAddSchema,
  authoringDiffRemoveSchema,
  authoringDiffModifySchema,
  authoringDiffMoveSchema,
  authoringDiffOutcomeAddSchema,
])
export type AuthoringDiff = z.infer<typeof authoringDiffSchema>

export const authoringIntentCoverageItemSchema = z.strictObject({
  intentId: z.string().min(1).max(128),
  operationIds: z.array(z.string().min(1).max(128)),
})
export type AuthoringIntentCoverageItem = z.infer<typeof authoringIntentCoverageItemSchema>

export const assistantAuthoringProposalSchema = z.strictObject({
  kind: z.literal('authoring_proposal'),
  proposalId: entityIdSchema,
  scenarioId: entityIdSchema,
  base: z.strictObject({
    draftRevision: z.number().int().nonnegative(),
    documentDigest: digestHexSchema,
    dependencyFingerprint: z.string().min(1).max(128),
  }),
  operations: z.array(authoringOperationSchema).min(1).max(4),
  candidateDigest: digestHexSchema,
  intentCoverage: z.array(authoringIntentCoverageItemSchema),
  diffs: z.array(authoringDiffSchema),
  diagnostics: z.array(compileDiagnosticSchema),
  executable: z.boolean(),
  validation: z.strictObject({
    schema: z.literal('passed'),
    expansion: z.literal('passed'),
    compiler: z.enum(['passed', 'baseline_errors']),
  }),
})
export type AssistantAuthoringProposal = z.infer<typeof assistantAuthoringProposalSchema>


// ---------------------------------------------------------------------------
// C1: Authoring Edit Proposal (V2 Scenario / Module)
// ---------------------------------------------------------------------------

export const missingSlotSchema = z.strictObject({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  reason: z.string().min(1).max(512),
})
export type MissingSlot = z.infer<typeof missingSlotSchema>

export const authoringEditProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  scenarioId: entityIdSchema,
  expectedDraftRevision: z.number().int().nonnegative(),
  diffSummary: z.string().max(2048),
  nodes: z.array(authoringNodeSchema),
  missingSlots: z.array(missingSlotSchema).default([]),
  diagnostics: z.array(compileDiagnosticSchema).default([]),
  proposalDigest: digestHexSchema,
  createdAt: utcInstantSchema,
})
export type AuthoringEditProposal = z.infer<typeof authoringEditProposalSchema>

// ---------------------------------------------------------------------------
// C2: Outcome & Output Assist Proposal
// ---------------------------------------------------------------------------

export const outcomeAssistProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  businessIntent: z.string().min(1).max(2048),
  candidateOutcomes: z.array(outcomeContractSchema).default([]),
  candidateOutputs: z.array(scenarioOutputDeclSchema).default([]),
  uncoveredRequirements: z.array(z.string().max(512)).default([]),
  unsupportedRequirements: z.array(z.string().max(512)).default([]),
  proposalDigest: digestHexSchema,
  createdAt: utcInstantSchema,
})
export type OutcomeAssistProposal = z.infer<typeof outcomeAssistProposalSchema>

// ---------------------------------------------------------------------------
// C3: Demonstration Semantic Proposal (Recording Understanding & Grouping)
// ---------------------------------------------------------------------------

export const demonstrationBusinessGroupSchema = z.strictObject({
  groupId: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  effectType: effectTypeSchema,
  sourceIds: z.array(z.string().min(1).max(128)).min(1),
  targetStepIds: z.array(entityIdSchema).optional(),
})
export type DemonstrationBusinessGroup = z.infer<typeof demonstrationBusinessGroupSchema>

export const demonstrationSemanticSourceMapItemSchema = z.strictObject({
  sourceId: z.string().min(1).max(128),
  groupId: z.string().min(1).max(128),
  disposition: z.enum(['accept', 'replace', 'discard', 'unresolved']),
  reason: z.string().max(256).optional(),
})
export type DemonstrationSemanticSourceMapItem = z.infer<typeof demonstrationSemanticSourceMapItemSchema>

export const demonstrationParamCandidateSchema = z.strictObject({
  sourceId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  type: scenarioInputTypeSchema,
  sampleValue: z.string().max(1024),
})
export type DemonstrationParamCandidate = z.infer<typeof demonstrationParamCandidateSchema>

export const demonstrationSemanticProposalSchema = z.strictObject({
  recordingDraftId: entityIdSchema,
  factDigest: digestHexSchema,
  modelProposalDigest: digestHexSchema,
  businessGroups: z.array(demonstrationBusinessGroupSchema),
  sourceMap: z.array(demonstrationSemanticSourceMapItemSchema),
  paramCandidates: z.array(demonstrationParamCandidateSchema).default([]),
  unknownActions: z.array(z.string().min(1).max(128)).default([]),
  createdAt: utcInstantSchema,
})
export type DemonstrationSemanticProposal = z.infer<typeof demonstrationSemanticProposalSchema>

// ---------------------------------------------------------------------------
// C4.1: Dataset Profile & Data Mapping Proposal
// ---------------------------------------------------------------------------

export const datasetColumnProfileSchema = z.strictObject({
  name: z.string().min(1).max(128),
  inferredType: scenarioInputTypeSchema,
  nullCount: z.number().int().nonnegative(),
  nullRate: z.number().min(0).max(1),
  distinctCount: z.number().int().nonnegative(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  sampleAnomalies: z.array(z.string().max(512)).default([]),
})
export type DatasetColumnProfile = z.infer<typeof datasetColumnProfileSchema>

export const datasetProfileSchema = z.strictObject({
  datasetId: entityIdSchema,
  totalRows: z.number().int().nonnegative(),
  analyzedRows: z.number().int().nonnegative(),
  isSampled: z.boolean(),
  columns: z.array(datasetColumnProfileSchema),
  algorithmVersion: z.string().min(1).max(64),
  createdAt: utcInstantSchema,
})
export type DatasetProfile = z.infer<typeof datasetProfileSchema>

export const unresolvedInputMappingSchema = z.strictObject({
  inputKey: z.string().min(1).max(128),
  reason: z.string().min(1).max(512),
})
export type UnresolvedInputMapping = z.infer<typeof unresolvedInputMappingSchema>

export const dataMappingProposalSchema = z.strictObject({
  datasetId: entityIdSchema,
  scenarioId: entityIdSchema.optional(),
  binding: dataBindingSchema,
  unresolvedInputs: z.array(unresolvedInputMappingSchema).default([]),
  confidence: z.number().min(0).max(1),
  sampleEvaluations: z.array(
    z.strictObject({
      rowIndex: z.number().int().nonnegative(),
      values: z.record(z.string(), jsonValueSchema),
    }),
  ).default([]),
  createdAt: utcInstantSchema,
})
export type DataMappingProposal = z.infer<typeof dataMappingProposalSchema>

export const SYNC_PREFLIGHT_MAX_ROWS = 2000
