import { z } from 'zod'
import { analysisBudgetSchema, analysisModeSchema, analysisSourceScopeSchema } from './schedules.js'
import { nextCursorSchema } from './rbac.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { scenarioDocumentSchema } from './scenario.js'

export const KNOWLEDGE_ANALYSIS_PROTOCOL = 'knowledge-analysis@1' as const
export const ANALYSIS_STRATEGY_VERSION = 'analysis-strategy@1' as const
export const ANALYSIS_LEASE_TTL_MS = 60_000
export const ANALYSIS_MAX_ATTEMPTS = 3

export const ANALYSIS_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUSES)[number]
export const analysisJobStatusSchema = z.enum(ANALYSIS_JOB_STATUSES)

export const ANALYSIS_CANDIDATE_KINDS = [
  'term',
  'experience',
  'failure_mode',
  'knowledge_revision',
  'map_refresh_suggestion',
] as const
export type AnalysisCandidateKind = (typeof ANALYSIS_CANDIDATE_KINDS)[number]
export const analysisCandidateKindSchema = z.enum(ANALYSIS_CANDIDATE_KINDS)

export const ANALYSIS_CANDIDATE_STATUSES = ['pending', 'proposed', 'accepted', 'rejected'] as const
export type AnalysisCandidateStatus = (typeof ANALYSIS_CANDIDATE_STATUSES)[number]
export const analysisCandidateStatusSchema = z.enum(ANALYSIS_CANDIDATE_STATUSES)

export const analysisModelUsageSchema = z.strictObject({
  model: z.string().min(1).max(256).nullable(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
  costMicros: z.number().int().min(0).optional(),
  invoked: z.boolean(),
  reservedTokens: z.number().int().min(0).optional(),
})
export type AnalysisModelUsage = z.infer<typeof analysisModelUsageSchema>

export const analysisModelResultSchema = z.strictObject({ candidates: z.array(z.strictObject({
  kind: analysisCandidateKindSchema,
  title: z.string().min(1).max(200), summary: z.string().min(1).max(2000),
  sourceIndexes: z.array(z.number().int().min(0)).min(1).max(50),
})).max(20) })

export const analysisJobAttemptDtoSchema = z.strictObject({
  attemptId: entityIdSchema,
  attemptNo: z.number().int().min(1),
  status: z.string().min(1).max(32),
  fencingToken: z.number().int().min(0),
  startedAt: utcInstantSchema.nullable(),
  finishedAt: utcInstantSchema.nullable(),
  error: z.string().max(2000).nullable(),
  modelUsage: analysisModelUsageSchema.nullable().optional(),
})
export type AnalysisJobAttemptDto = z.infer<typeof analysisJobAttemptDtoSchema>

export const analysisCandidateReviewSchema = z.strictObject({
  actorId: entityIdSchema,
  reviewedAt: utcInstantSchema,
  destination: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('proposal'), scenarioId: entityIdSchema, proposalId: entityIdSchema }),
    z.strictObject({ kind: z.literal('term'), termId: entityIdSchema, revision: z.number().int().positive() }),
    z.strictObject({ kind: z.literal('map_refresh'), scheduleId: entityIdSchema, revision: z.number().int().positive() }),
    z.strictObject({ kind: z.literal('reject'), reason: z.string().min(1).max(512) }),
  ]),
})
export type AnalysisCandidateReview = z.infer<typeof analysisCandidateReviewSchema>

const reviewBase = { idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), expectedRevision: z.number().int().positive() }
export const reviewAnalysisCandidateBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...reviewBase, kind: z.literal('proposal'), scenarioId: entityIdSchema,
    expectedDraftRevision: z.number().int().positive(), documentDigest: z.string().regex(/^[a-f0-9]{64}$/), document: scenarioDocumentSchema }),
  z.strictObject({ ...reviewBase, kind: z.literal('term'), canonicalName: z.string().trim().min(1).max(128),
    aliases: z.array(z.string().trim().min(1).max(128)).max(16), meaning: z.string().trim().min(1).max(2048),
    existingTerm: z.strictObject({ termId: entityIdSchema, expectedRevision: z.number().int().positive() }).optional() }),
  z.strictObject({ ...reviewBase, kind: z.literal('map_refresh'), scheduleId: entityIdSchema, expectedScheduleRevision: z.number().int().positive() }),
  z.strictObject({ ...reviewBase, kind: z.literal('reject'), reason: z.string().trim().min(1).max(512) }),
])
export type ReviewAnalysisCandidateBody = z.infer<typeof reviewAnalysisCandidateBodySchema>

export const analysisCandidateDtoSchema = z.strictObject({
  candidateId: entityIdSchema,
  jobId: entityIdSchema,
  kind: analysisCandidateKindSchema,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  sources: z.array(z.record(z.string(), z.unknown())),
  status: analysisCandidateStatusSchema,
  revision: z.number().int().positive().default(1),
  review: analysisCandidateReviewSchema.nullable().default(null),
  proposalStatus: z.string().optional(),
  createdAt: utcInstantSchema,
})
export type AnalysisCandidateDto = z.infer<typeof analysisCandidateDtoSchema>

export const analysisJobDtoSchema = z.strictObject({
  analysisJobId: entityIdSchema,
  targetId: entityIdSchema,
  scheduleId: entityIdSchema.nullable(),
  occurrenceId: entityIdSchema.nullable(),
  mode: analysisModeSchema,
  status: analysisJobStatusSchema,
  source: analysisSourceScopeSchema,
  strategyVersion: z.string().min(1).max(64),
  budget: analysisBudgetSchema,
  afterSeq: z.number().int().min(0),
  throughSeq: z.number().int().min(0).nullable(),
  checkpointSeq: z.number().int().min(0),
  result: z.record(z.string(), z.unknown()).nullable(),
  coverageGaps: z.array(z.string().min(1).max(128)),
  modelUsage: analysisModelUsageSchema.nullable(),
  attemptCount: z.number().int().min(0),
  fencingToken: z.number().int().min(0),
  cancelRequestedAt: utcInstantSchema.nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  attempts: z.array(analysisJobAttemptDtoSchema).optional(),
  candidates: z.array(analysisCandidateDtoSchema).optional(),
})
export type AnalysisJobDto = z.infer<typeof analysisJobDtoSchema>

export const analysisJobEventDtoSchema = z.strictObject({
  eventId: entityIdSchema,
  jobId: entityIdSchema,
  seq: z.number().int().min(1),
  eventType: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  createdAt: utcInstantSchema,
})
export type AnalysisJobEventDto = z.infer<typeof analysisJobEventDtoSchema>

export const analysisJobObserveQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).default(0),
})
export type AnalysisJobObserveQuery = z.infer<typeof analysisJobObserveQuerySchema>

export const analysisJobCancelBodySchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
})
export type AnalysisJobCancelBody = z.infer<typeof analysisJobCancelBodySchema>

export const analysisJobListQuerySchema = z.strictObject({
  targetId: entityIdSchema.optional(),
  status: analysisJobStatusSchema.optional(),
  cursor: nextCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type AnalysisJobListQuery = z.infer<typeof analysisJobListQuerySchema>
