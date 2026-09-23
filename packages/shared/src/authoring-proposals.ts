import { z } from 'zod'
import { entityIdSchema, utcInstantSchema, jsonValueSchema } from './wire.js'
import { outcomeContractSchema, type OutcomeContract } from './outcome.js'
import { scenarioOutputDeclSchema, type ScenarioOutputDecl } from './run-output.js'
import { effectTypeSchema, scenarioInputTypeSchema, type EffectType, type ScenarioInputType } from './step.js'
import { authoringNodeSchema, type AuthoringNode } from './authoring-document.js'
import { compileDiagnosticSchema, type CompileDiagnostic } from './scenario.js'
import { dataBindingSchema, type DataBinding } from './dataset.js'

export const digestHexSchema = z.string().regex(/^[a-f0-9]{64}$/, '摘要须为 64 位十六进制 SHA-256')

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
