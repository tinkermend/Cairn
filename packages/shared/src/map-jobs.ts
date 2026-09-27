import { z } from 'zod'
import { isPublishedAccessPathPrefix, originsForAccessPurposes as originsFromPolicy } from './access-scope.js'
import { originsFromTargetUrls } from './origin.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { mapIngestProgressSchema, mapIngestScopeSchema, mapIngestSummarySchema, mapMenuEntrySchema } from './map-ingest.js'

export const MAP_JOBS_PROTOCOL = 'map-jobs@1' as const
export const MAP_JOBS_CONSUMER_VERSION = MAP_JOBS_PROTOCOL
export const MAP_JOB_POLICY_SCHEMA_VERSION = 1 as const
export const TARGET_ACCESS_POLICY_SCHEMA_VERSION = 1 as const

export const TARGET_ACCESS_PURPOSES = ['business_surface', 'authentication', 'resource'] as const
export type TargetAccessPurpose = (typeof TARGET_ACCESS_PURPOSES)[number]
export const targetAccessPurposeSchema = z.enum(TARGET_ACCESS_PURPOSES)

export const TARGET_ACCESS_EFFECTS = ['allow', 'deny'] as const
export const targetAccessEffectSchema = z.enum(TARGET_ACCESS_EFFECTS)

export const MAP_JOB_KINDS = ['map_ingest'] as const
export type MapJobKind = (typeof MAP_JOB_KINDS)[number]
export const mapJobKindSchema = z.enum(MAP_JOB_KINDS)

export const MAP_JOB_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const
export type MapJobStatus = (typeof MAP_JOB_STATUSES)[number]
export const mapJobStatusSchema = z.enum(MAP_JOB_STATUSES)

export const MAP_JOB_STOP_REASONS = [
  'completed',
  'cancelled',
  'budget_exhausted',
  'slice_failed',
  'auth_preparation_required',
  'user_run_waiting',
  'target_paused',
  'worker_unavailable',
  'compile_rejected',
  'active_slice_exists',
  'window_closed',
] as const
export type MapJobStopReason = (typeof MAP_JOB_STOP_REASONS)[number]
export const mapJobStopReasonSchema = z.enum(MAP_JOB_STOP_REASONS)

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'digest 须为 64 位小写 hex')
const originSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    } catch {
      return false
    }
  }, 'origin 须为 http(s) 且不含凭据')
const exactOriginSchema = originSchema.refine((value) => {
  const url = new URL(value)
  return url.pathname === '/' && !url.search && !url.hash
}, 'origin 不得包含路径、query 或 hash')

export const targetAccessRuleSchema = z.strictObject({
  origin: originSchema,
  purpose: targetAccessPurposeSchema,
  effect: targetAccessEffectSchema,
  pathPrefix: z.string().min(1).max(512).optional(),
})
export type TargetAccessRule = z.infer<typeof targetAccessRuleSchema>

export const targetAccessPolicySchema = z.strictObject({
  schemaVersion: z.literal(TARGET_ACCESS_POLICY_SCHEMA_VERSION),
  policyVersion: z.number().int().min(1),
  rules: z.array(targetAccessRuleSchema).max(64),
  readOnlyRequests: z.array(z.strictObject({
    method: z.literal('POST'),
    origin: originSchema,
    pathPattern: z.string().min(1).max(512).refine(isPublishedAccessPathPrefix, '只读请求路径须为明确的路径前缀'),
  })).max(32).default([]),
  /** Optional risk appetite for map ingestion. Absence preserves the existing explicit-rule behavior and digest. */
  postReadMode: z.literal('balanced').optional(),
  /** Blocked POSTs proven independent of the captured business surface. Never grants network access. */
  verifiedNonContentRequests: z.array(z.strictObject({
    method: z.literal('POST'),
    resourceType: z.enum(['xhr', 'fetch']),
    origin: exactOriginSchema,
    pathPattern: z.string().min(1).max(512).refine(
      value => isPublishedAccessPathPrefix(value) && !value.includes('*'), '非内容请求路径须为明确的精确路径'),
    evidence: z.string().trim().min(12).max(512),
  })).max(32).optional(),
})
export type TargetAccessPolicy = z.infer<typeof targetAccessPolicySchema>

export const frozenTargetAccessPolicySchema = z.strictObject({
  revision: z.number().int().min(1),
  digest: digestSchema,
  policy: targetAccessPolicySchema,
})
export type FrozenTargetAccessPolicy = z.infer<typeof frozenTargetAccessPolicySchema>

export const targetAccessPolicyDtoSchema = z.strictObject({
  targetId: entityIdSchema,
  revision: z.number().int().min(0),
  policy: targetAccessPolicySchema.nullable(),
  seeded: z.boolean(),
  resourceLoadsUnrestricted: z.literal(true),
  updatedAt: utcInstantSchema,
})
export type TargetAccessPolicyDto = z.infer<typeof targetAccessPolicyDtoSchema>

export const targetAccessPolicyUpdateBodySchema = z
  .strictObject({
    expectedRevision: z.number().int().min(0),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    rules: z.array(targetAccessRuleSchema).min(1).max(64),
    readOnlyRequests: targetAccessPolicySchema.shape.readOnlyRequests.optional(),
    postReadMode: z.enum(['explicit', 'balanced']).optional(),
    verifiedNonContentRequests: targetAccessPolicySchema.shape.verifiedNonContentRequests,
    reason: z.string().trim().min(1).max(512),
  })
  .superRefine((value, ctx) => {
    value.rules.forEach((rule, index) => {
      if (rule.pathPrefix !== undefined && !isPublishedAccessPathPrefix(rule.pathPrefix)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'pathPrefix'],
          message: 'pathPrefix 必须以 / 开头且不含 query 或 hash',
        })
      }
    })
  })
export type TargetAccessPolicyUpdateBody = z.infer<typeof targetAccessPolicyUpdateBodySchema>

export const mapJobPolicySchema = z.strictObject({
  schemaVersion: z.literal(MAP_JOB_POLICY_SCHEMA_VERSION),
  policyVersion: z.number().int().min(1),
  manualJobsEnabled: z.boolean(),
  sliceWorkSeconds: z.number().int().min(5).max(20).default(20),
  ingestMaxDepth: z.number().int().min(1).max(5).default(3),
  ingestMaxPagesPerEntry: z.number().int().min(1).max(100).default(30),
  ingestMaxPagesPerJob: z.number().int().min(1).max(500).default(200),
  ingestMaxJobSeconds: z.number().int().min(60).max(3600).default(1800),
  ingestNavTimeoutSeconds: z.number().int().min(1).max(30).default(15),
  ingestSettleTimeoutSeconds: z.number().int().min(1).max(10).default(5),
  ingestPageBudgetSeconds: z.number().int().min(5).max(60).default(25),
  ingestMaxViewsPerPage: z.number().int().min(1).max(20).default(8),
  ingestMaxOptionReadsPerPage: z.number().int().min(0).max(30).default(10),
})
export type MapJobPolicy = z.infer<typeof mapJobPolicySchema>

export const FACTORY_MAP_JOB_POLICY: MapJobPolicy = mapJobPolicySchema.parse({
  schemaVersion: 1,
  policyVersion: 1,
  manualJobsEnabled: false,
})

export const mapJobPolicyDtoSchema = z.strictObject({
  targetId: entityIdSchema,
  revision: z.number().int().min(0),
  policy: mapJobPolicySchema,
  updatedAt: utcInstantSchema,
})
export type MapJobPolicyDto = z.infer<typeof mapJobPolicyDtoSchema>

export const mapJobPolicyUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  manualJobsEnabled: z.boolean(),
  ingestMaxDepth: mapJobPolicySchema.shape.ingestMaxDepth.optional(),
  ingestMaxPagesPerEntry: mapJobPolicySchema.shape.ingestMaxPagesPerEntry.optional(),
  ingestMaxPagesPerJob: mapJobPolicySchema.shape.ingestMaxPagesPerJob.optional(),
  ingestMaxJobSeconds: mapJobPolicySchema.shape.ingestMaxJobSeconds.optional(),
  ingestNavTimeoutSeconds: mapJobPolicySchema.shape.ingestNavTimeoutSeconds.optional(),
  ingestSettleTimeoutSeconds: mapJobPolicySchema.shape.ingestSettleTimeoutSeconds.optional(),
  ingestPageBudgetSeconds: mapJobPolicySchema.shape.ingestPageBudgetSeconds.optional(),
  ingestMaxViewsPerPage: mapJobPolicySchema.shape.ingestMaxViewsPerPage.optional(),
  ingestMaxOptionReadsPerPage: mapJobPolicySchema.shape.ingestMaxOptionReadsPerPage.optional(),
  reason: z.string().trim().min(1).max(512),
})
export type MapJobPolicyUpdateBody = z.infer<typeof mapJobPolicyUpdateBodySchema>

export const frozenMapJobSchema = z.strictObject({
  jobId: entityIdSchema,
  sliceOrdinal: z.number().int().min(0),
  purpose: mapJobKindSchema,
  releaseId: entityIdSchema.optional(),
  policyRevision: z.number().int().min(1),
  remainingBudgetSeconds: z.number().int().min(0),
  consumerVersion: z.literal(MAP_JOBS_CONSUMER_VERSION),
  startBefore: utcInstantSchema.optional(),
  source: z.enum(['manual', 'scheduled']).default('manual'),
  occurrenceId: entityIdSchema.optional(),
  ingest: z.strictObject({
    scope: mapIngestScopeSchema,
    entries: z.array(mapMenuEntrySchema).max(64),
    accessPolicyRevision: z.number().int().min(0),
  }).optional(),
})
export type FrozenMapJob = z.infer<typeof frozenMapJobSchema>

export const mapJobSliceDtoSchema = z.strictObject({
  sliceOrdinal: z.number().int().min(0),
  runId: entityIdSchema,
  reservedSeconds: z.number().int().min(0),
  createdAt: utcInstantSchema,
})
export type MapJobSliceDto = z.infer<typeof mapJobSliceDtoSchema>

export const mapJobDtoSchema = z.strictObject({
  jobId: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  jobKind: mapJobKindSchema,
  jobStatus: mapJobStatusSchema,
  stopReason: mapJobStopReasonSchema.nullable(),
  revision: z.number().int().min(1),
  remainingBudgetSeconds: z.number().int().min(0),
  scope: mapIngestScopeSchema.optional(),
  ingestProgress: mapIngestProgressSchema.optional(),
  ingestSummary: mapIngestSummarySchema.nullable().optional(),
  releaseId: entityIdSchema.nullable(),
  updatedAt: utcInstantSchema.optional(),
  firstRunId: entityIdSchema.optional(),
  slices: z.array(mapJobSliceDtoSchema),
  createdAt: utcInstantSchema,
})
export type MapJobDto = z.infer<typeof mapJobDtoSchema>

export const mapIngestJobListResponseSchema = z.strictObject({
  items: z.array(mapJobDtoSchema),
  nextCursor: entityIdSchema.optional(),
})
export type MapIngestJobListResponse = z.infer<typeof mapIngestJobListResponseSchema>

export const mapJobCreateResponseSchema = z.strictObject({
  job: mapJobDtoSchema,
  created: z.boolean(),
})
export type MapJobCreateResponse = z.infer<typeof mapJobCreateResponseSchema>

export function seedTargetAccessRules(entryUrl: string, loginUrl?: string | null): TargetAccessRule[] {
  const [entryOrigin, loginOrigin] = (() => {
    const origins = originsFromTargetUrls(entryUrl, loginUrl)
    return [origins[0], origins.length > 1 ? origins[1] : origins[0]]
  })()
  if (!entryOrigin) return []
  const rules: TargetAccessRule[] = [
    { origin: entryOrigin, purpose: 'business_surface', effect: 'allow' },
  ]
  if (loginOrigin) {
    rules.push({ origin: loginOrigin, purpose: 'authentication', effect: 'allow' })
  }
  return targetAccessPolicySchema.shape.rules.parse(rules)
}

export function originsForAccessPurposes(
  policy: TargetAccessPolicy | null | undefined,
  purposes: readonly TargetAccessPurpose[],
): string[] {
  return originsFromPolicy(policy, purposes)
}

export function isMapJobRun(snapshot: { mapJob?: FrozenMapJob | null }): snapshot is { mapJob: FrozenMapJob } {
  return Boolean(snapshot.mapJob?.jobId)
}

/** 地图作业只积累观察事实，不采运行级截图、录像或 Trace。 */
export const MAP_JOB_EVIDENCE_POLICY = {
  screenshot: 'off',
  video: 'off',
  trace: 'off',
} as const

export function mapJobIdempotencyKey(input: {
  targetId: string
  targetAccountId: string
  manualId: string
}): string {
  return `map:manual:${input.targetId}:${input.targetAccountId}:${input.manualId}`
}

export function mapJobCommandKey(input: {
  source?: 'manual' | 'scheduled'
  targetId: string
  targetAccountId: string
  manualId?: string
  occurrenceId?: string
}): string {
  if (input.source === 'scheduled') {
    if (!input.occurrenceId) throw new Error('定时作业缺少 occurrenceId')
    return `map:scheduled:${input.occurrenceId}`
  }
  if (!input.manualId) throw new Error('手工作业缺少 manualId')
  return mapJobIdempotencyKey({
    targetId: input.targetId,
    targetAccountId: input.targetAccountId,
    manualId: input.manualId,
  })
}
