import { z } from 'zod'
import { mapAssetRefSchema, mapConditionSnapshotSchema } from './map-c0.js'
import { nextCursorSchema } from './rbac.js'
import { scenarioDocumentSchema } from './scenario.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const KNOWLEDGE_LIST_LIMIT_DEFAULT = 20
export const KNOWLEDGE_LIST_LIMIT_MAX = 100

export const KNOWLEDGE_ERROR_CODES = [
  'KNOWLEDGE_NOT_FOUND',
  'KNOWLEDGE_REVISION_CONFLICT',
  'KNOWLEDGE_IDEMPOTENCY_CONFLICT',
  'KNOWLEDGE_STEP_LIMIT',
  'KNOWLEDGE_CONDITION_UNKNOWN',
  'KNOWLEDGE_INVALID_PROPOSAL',
  'AUTHORING_PROPOSAL_STALE',
  'AUTHORING_SCHEMA_UNSUPPORTED',
] as const
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number]

export const TERM_STATUSES = ['candidate', 'confirmed', 'retired'] as const
export type TermStatus = (typeof TERM_STATUSES)[number]
export const termStatusSchema = z.enum(TERM_STATUSES)

export const AUTHORING_PROPOSAL_STATUSES = [
  'requested',
  'generating',
  'proposed',
  'needs_input',
  'unsupported',
  'failed',
  'cancelled',
  'accepted',
  'stale',
  'rejected',
] as const
export type AuthoringProposalStatus = (typeof AUTHORING_PROPOSAL_STATUSES)[number]
export const authoringProposalStatusSchema = z.enum(AUTHORING_PROPOSAL_STATUSES)

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'idempotencyKey 须为 8–128 位 [A-Za-z0-9._:-]')
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'digest 须为 64 位小写 hex')
const termNameSchema = z.string().trim().min(1).max(128)
const aliasSchema = z.string().trim().min(1).max(128)
const meaningSchema = z.string().trim().min(1).max(2048)

export const knowledgeSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('map_asset'),
    assetRef: mapAssetRefSchema,
    mapReleaseId: entityIdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('map_observation'), observationId: entityIdSchema }),
  z.strictObject({ kind: z.literal('map_verification'), verificationId: entityIdSchema }),
  z.strictObject({ kind: z.literal('term'), termId: entityIdSchema, revision: z.number().int().min(1) }),
  z.strictObject({
    kind: z.literal('module_version'),
    moduleId: entityIdSchema,
    moduleVersionId: entityIdSchema,
    contentDigest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal('attempt'),
    attemptId: entityIdSchema,
    runId: entityIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('evidence'),
    evidenceId: entityIdSchema,
    attemptId: entityIdSchema.optional(),
  }),
])
export type KnowledgeSourceRef = z.infer<typeof knowledgeSourceRefSchema>

export const terminologyEntrySchema = z.strictObject({
  termId: entityIdSchema,
  targetId: entityIdSchema,
  canonicalName: termNameSchema,
  aliases: z.array(aliasSchema).max(16),
  meaning: meaningSchema,
  conditionSnapshot: mapConditionSnapshotSchema.optional(),
  termStatus: termStatusSchema,
  revision: z.number().int().min(1),
  sources: z.array(knowledgeSourceRefSchema).max(8),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type TerminologyEntry = z.infer<typeof terminologyEntrySchema>

export const terminologyListQuerySchema = z.object({
  q: z.string().trim().min(1).max(128).optional(),
  status: termStatusSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(KNOWLEDGE_LIST_LIMIT_MAX).default(KNOWLEDGE_LIST_LIMIT_DEFAULT),
})
export type TerminologyListQuery = z.input<typeof terminologyListQuerySchema>

export const terminologyListResponseSchema = z.strictObject({
  items: z.array(terminologyEntrySchema).max(KNOWLEDGE_LIST_LIMIT_MAX),
  nextCursor: nextCursorSchema,
})
export type TerminologyListResponse = z.infer<typeof terminologyListResponseSchema>

export const terminologyMatchQuerySchema = z.object({
  alias: z.string().trim().min(1).max(128),
})
export type TerminologyMatchQuery = z.input<typeof terminologyMatchQuerySchema>

export const terminologyMatchResponseSchema = z.strictObject({
  items: z.array(terminologyEntrySchema).max(32),
})
export type TerminologyMatchResponse = z.infer<typeof terminologyMatchResponseSchema>

export const createTerminologyBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  canonicalName: termNameSchema,
  aliases: z.array(aliasSchema).max(16).default([]),
  meaning: meaningSchema,
  conditionSnapshot: mapConditionSnapshotSchema.optional(),
  sources: z.array(knowledgeSourceRefSchema).max(8).default([]),
  termStatus: z.enum(['candidate', 'confirmed']).default('candidate'),
})
export type CreateTerminologyBody = z.input<typeof createTerminologyBodySchema>

export const updateTerminologyBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  canonicalName: termNameSchema.optional(),
  aliases: z.array(aliasSchema).max(16).optional(),
  meaning: meaningSchema.optional(),
  conditionSnapshot: mapConditionSnapshotSchema.nullable().optional(),
  sources: z.array(knowledgeSourceRefSchema).max(8).optional(),
  termStatus: z.enum(['candidate', 'confirmed']).optional(),
})
export type UpdateTerminologyBody = z.infer<typeof updateTerminologyBodySchema>

export const retireTerminologyBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(512),
})
export type RetireTerminologyBody = z.infer<typeof retireTerminologyBodySchema>

export const knowledgeDiagnosticSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  fieldPath: z.array(z.string().min(1).max(64)).max(8).optional(),
  termId: entityIdSchema.optional(),
  moduleVersionId: entityIdSchema.optional(),
  stepId: entityIdSchema.optional(),
})
export type KnowledgeDiagnostic = z.infer<typeof knowledgeDiagnosticSchema>

export const knowledgeDiffSchema = z.strictObject({
  fieldPath: z.array(z.string().min(1)).max(8),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
})
export type KnowledgeDiff = z.infer<typeof knowledgeDiffSchema>

export const knowledgeTermCandidateSchema = z.strictObject({
  termId: entityIdSchema,
  revision: z.number().int().min(1),
  canonicalName: termNameSchema,
  aliases: z.array(aliasSchema).max(16),
  meaning: meaningSchema,
})
export type KnowledgeTermCandidate = z.infer<typeof knowledgeTermCandidateSchema>

export const knowledgeSuggestedModuleSchema = z.strictObject({
  moduleId: entityIdSchema,
  moduleVersionId: entityIdSchema,
  name: z.string().min(1).max(128),
  contentDigest: digestSchema,
  manualRequirement: z.boolean(),
})
export type KnowledgeSuggestedModule = z.infer<typeof knowledgeSuggestedModuleSchema>

export const knowledgeSuggestedBindingSchema = z.strictObject({
  stepId: entityIdSchema,
  assetRef: mapAssetRefSchema,
})
export type KnowledgeSuggestedBinding = z.infer<typeof knowledgeSuggestedBindingSchema>

export const authoringProposalBaselineSchema = z.strictObject({
  draftRevision: z.number().int().min(1),
  documentDigest: digestSchema,
  mapReleaseId: entityIdSchema.optional(),
  selectedTermRevisions: z
    .array(z.strictObject({ termId: entityIdSchema, revision: z.number().int().min(1) }))
    .max(16),
  selectedModuleVersionIds: z.array(entityIdSchema).max(8),
  platformAiConfigRevision: z.number().int().min(0),
})
export type AuthoringProposalBaseline = z.infer<typeof authoringProposalBaselineSchema>

export const authoringProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  targetId: entityIdSchema,
  scenarioId: entityIdSchema,
  proposalStatus: authoringProposalStatusSchema,
  question: z.string().min(1).max(2000),
  baseline: authoringProposalBaselineSchema,
  document: scenarioDocumentSchema.optional(),
  diffs: z.array(knowledgeDiffSchema).max(64),
  diagnostics: z.array(knowledgeDiagnosticSchema).max(32),
  sources: z.array(knowledgeSourceRefSchema).max(16),
  unknowns: z.array(z.string().min(1).max(256)).max(16),
  termCandidates: z.array(knowledgeTermCandidateSchema).max(16),
  suggestedModules: z.array(knowledgeSuggestedModuleSchema).max(8),
  suggestedBindings: z.array(knowledgeSuggestedBindingSchema).max(16),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type AuthoringProposal = z.infer<typeof authoringProposalSchema>

export const createKnowledgeProposalBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  question: z.string().trim().min(1).max(2000),
  expectedDraftRevision: z.number().int().min(1),
  documentDigest: digestSchema,
  mapReleaseId: entityIdSchema.optional(),
  selectedTermIds: z.array(entityIdSchema).max(8).default([]),
  selectedModuleVersionIds: z.array(entityIdSchema).max(8).default([]),
  attemptId: entityIdSchema.optional(),
})
export type CreateKnowledgeProposalBody = z.input<typeof createKnowledgeProposalBodySchema>

export const acceptKnowledgeProposalBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  expectedDraftRevision: z.number().int().min(1),
  documentDigest: digestSchema,
})
export type AcceptKnowledgeProposalBody = z.infer<typeof acceptKnowledgeProposalBodySchema>

export const rejectKnowledgeProposalBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(512).optional(),
})
export type RejectKnowledgeProposalBody = z.infer<typeof rejectKnowledgeProposalBodySchema>

export const knowledgeProposalAcceptedSchema = z.strictObject({
  proposal: authoringProposalSchema,
  draftRevision: z.number().int().min(1),
})
export type KnowledgeProposalAccepted = z.infer<typeof knowledgeProposalAcceptedSchema>
