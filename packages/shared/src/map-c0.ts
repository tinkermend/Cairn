import { z } from 'zod'
import { runGrantSchema } from './run-lease.js'
import { MAX_FRAME_DEPTH, frameStepSchema } from './target-descriptor.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type EntityId } from './wire.js'

export const MAP_FACTS_PROTOCOL = 'map-facts@1' as const
export const MAP_FACT_SCHEMA_VERSION = 1 as const
export const MAP_FACT_MAX_BYTES = 65_536
export const MAP_FACT_BATCH_MAX = 20
export const MAP_FACT_DEDUPE_MAX = 192
export const MAP_FACT_READ_LIMIT_DEFAULT = 50
export const MAP_FACT_READ_LIMIT_MAX = 200
export const MAP_FACT_CONTENT_RETAIN_DAYS = 90

export const mapUtcInstantSchema = utcInstantSchema.refine(
  (value) => value.endsWith('Z'),
  '地图时刻必须是 UTC（以 Z 结尾）',
)

const technicalKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{8,192}$/, '技术键须为 8–192 位 [A-Za-z0-9:._-]')
const collectorVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9.@_-]{1,64}$/, 'collectorVersion 须为 1–64 位 [A-Za-z0-9.@_-]')
const shortLabelSchema = z.string().trim().min(1).max(64)
const mediumLabelSchema = z.string().trim().min(1).max(128)
const originSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/\/\/[^/]*@/.test(value), 'origin 不得含凭据')

export const MAP_CONDITION_UNKNOWN_FIELDS = [
  'targetAccount',
  'permissionProfile',
  'workspace',
  'locale',
  'viewport',
  'featureVersion',
] as const
export type MapConditionUnknownField = (typeof MAP_CONDITION_UNKNOWN_FIELDS)[number]
export const mapConditionUnknownFieldSchema = z.enum(MAP_CONDITION_UNKNOWN_FIELDS)

export const mapAccountBindingSchema = z.discriminatedUnion('presence', [
  z.strictObject({
    presence: z.literal('known'),
    targetAccountId: entityIdSchema,
  }),
  z.strictObject({ presence: z.literal('anonymous') }),
  z.strictObject({ presence: z.literal('unknown') }),
])
export type MapAccountBinding = z.infer<typeof mapAccountBindingSchema>

export const mapPermissionProfileSchema = z.strictObject({
  source: shortLabelSchema,
  version: shortLabelSchema,
  label: mediumLabelSchema.optional(),
})
export type MapPermissionProfile = z.infer<typeof mapPermissionProfileSchema>

export const mapViewportSchema = z.strictObject({
  category: z.enum(['desktop', 'tablet', 'mobile', 'other']),
  widthPx: z.number().int().positive().max(16_384),
  heightPx: z.number().int().positive().max(16_384),
})
export type MapViewport = z.infer<typeof mapViewportSchema>

export const mapConditionSnapshotSchema = z
  .strictObject({
    targetId: entityIdSchema,
    accountBinding: mapAccountBindingSchema,
    permissionProfile: mapPermissionProfileSchema.optional(),
    workspace: shortLabelSchema.optional(),
    locale: shortLabelSchema.optional(),
    viewport: mapViewportSchema.optional(),
    featureVersion: shortLabelSchema.optional(),
    unknownFields: z.array(mapConditionUnknownFieldSchema).max(8),
  })
  .superRefine((value, ctx) => {
    const unknown = new Set(value.unknownFields)
    const known = {
      targetAccount: value.accountBinding.presence !== 'unknown',
      permissionProfile: value.permissionProfile !== undefined,
      workspace: value.workspace !== undefined,
      locale: value.locale !== undefined,
      viewport: value.viewport !== undefined,
      featureVersion: value.featureVersion !== undefined,
    } as const
    for (const key of MAP_CONDITION_UNKNOWN_FIELDS) {
      if (known[key] && unknown.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unknownFields'],
          message: `${key} 已有值，不能列入 unknownFields`,
        })
      }
    }
    if (value.accountBinding.presence === 'unknown' && !unknown.has('targetAccount')) {
      ctx.addIssue({
        code: 'custom',
        path: ['unknownFields'],
        message: '账号未知时必须将 targetAccount 列入 unknownFields',
      })
    }
  })
export type MapConditionSnapshot = z.infer<typeof mapConditionSnapshotSchema>

export const mapAssetRefSchema = z
  .strictObject({
    targetId: entityIdSchema,
    pageId: entityIdSchema.optional(),
    objectId: entityIdSchema.optional(),
    implementationKey: shortLabelSchema.optional(),
    descriptorVersion: z.number().int().positive().max(1_000_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.descriptorVersion !== undefined &&
      (value.objectId === undefined || value.implementationKey === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'descriptorVersion 必须同时提供 objectId 与 implementationKey',
      })
    }
  })
export type MapAssetRef = z.infer<typeof mapAssetRefSchema>

export const MAP_SOURCE_TYPES = [
  'formal_run',
  'trial',
  'recorder',
  'user_confirmed',
  'probe',
  'refresh',
  'ai_explore',
  'imported_metadata',
] as const
export type MapSourceType = (typeof MAP_SOURCE_TYPES)[number]
export const mapSourceTypeSchema = z.enum(MAP_SOURCE_TYPES)
export const MAP_RUN_SOURCE_TYPES = [
  'formal_run',
  'trial',
  'probe',
  'refresh',
  'ai_explore',
] as const
export type MapRunSourceType = (typeof MAP_RUN_SOURCE_TYPES)[number]

export const mapRunSourceRefSchema = z.strictObject({
  sourceType: z.enum(MAP_RUN_SOURCE_TYPES),
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  attemptId: entityIdSchema.optional(),
})
export const mapRecorderSourceRefSchema = z.strictObject({
  sourceType: z.literal('recorder'),
  recordingId: entityIdSchema,
  sourceVersion: shortLabelSchema,
  originalEventIndex: z.number().int().nonnegative().max(1_000_000),
  sourceIndexes: z.array(z.number().int().nonnegative().max(1_000_000)).max(32).optional(),
})
export const mapUserConfirmedSourceRefSchema = z.strictObject({
  sourceType: z.literal('user_confirmed'),
  actorId: entityIdSchema,
  decisionId: entityIdSchema,
  scope: z.string().trim().min(1).max(256),
})
export const mapImportedSourceRefSchema = z.strictObject({
  sourceType: z.literal('imported_metadata'),
  importId: entityIdSchema,
  sourceVersion: shortLabelSchema,
})
export const mapSourceRefSchema = z.discriminatedUnion('sourceType', [
  mapRunSourceRefSchema,
  mapRecorderSourceRefSchema,
  mapUserConfirmedSourceRefSchema,
  mapImportedSourceRefSchema,
])
export type MapSourceRef = z.infer<typeof mapSourceRefSchema>

export const MAP_OBSERVATION_PHASES = ['before_action', 'after_action', 'step_skipped'] as const
export type MapObservationPhase = (typeof MAP_OBSERVATION_PHASES)[number]
export const mapObservationPhaseSchema = z.enum(MAP_OBSERVATION_PHASES)

export const MAP_CAPTURE_STATUSES = ['observed', 'missing', 'skipped'] as const
export type MapCaptureStatus = (typeof MAP_CAPTURE_STATUSES)[number]
export const mapCaptureStatusSchema = z.enum(MAP_CAPTURE_STATUSES)

export const MAP_NODE_SET_KINDS = [
  'action_object',
  'region',
  'result_region',
  'chrome',
  'unknown',
] as const
export type MapNodeSetKind = (typeof MAP_NODE_SET_KINDS)[number]
export const mapNodeSetKindSchema = z.enum(MAP_NODE_SET_KINDS)

export const MAP_COMPLETENESS = ['complete', 'partial', 'none'] as const
export type MapCompleteness = (typeof MAP_COMPLETENESS)[number]
export const mapCompletenessSchema = z.enum(MAP_COMPLETENESS)

export const MAP_MISSING_REASONS = [
  'TIME_BUDGET',
  'SURFACE_CHANGED',
  'CAPABILITY_MISSING',
  'REDACTION',
  'PROCESS_LOST',
  'NOT_APPLICABLE',
  'OBJECT_MISSING',
  'BASELINE_UNAVAILABLE',
  'TRUNCATED',
] as const
export type MapMissingReason = (typeof MAP_MISSING_REASONS)[number]
export const mapMissingReasonSchema = z.enum(MAP_MISSING_REASONS)

export const mapSurfaceCapabilitySchema = z.strictObject({
  frames: z.enum(['ok', 'blocked', 'unknown']),
  a11y: z.enum(['ok', 'limited', 'missing', 'unknown']),
  canvas: z.enum(['ok', 'unsupported', 'unknown']),
  shadow: z.enum(['ok', 'closed', 'unknown']),
})
export type MapSurfaceCapability = z.infer<typeof mapSurfaceCapabilitySchema>

export const mapRegionRefSchema = z.strictObject({
  key: shortLabelSchema,
  kind: mapNodeSetKindSchema,
})
export type MapRegionRef = z.infer<typeof mapRegionRefSchema>

export const mapInstanceBindingSchema = z.strictObject({
  key: shortLabelSchema,
  valueDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'valueDigest 须为 64 位小写 hex')
    .optional(),
})
export type MapInstanceBinding = z.infer<typeof mapInstanceBindingSchema>

export const mapActionRefSchema = z.strictObject({
  stepId: entityIdSchema.optional(),
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  actionKind: shortLabelSchema.optional(),
  instanceBinding: mapInstanceBindingSchema.optional(),
})
export type MapActionRef = z.infer<typeof mapActionRefSchema>

export const mapBaselineRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observation'), observationId: entityIdSchema }),
  z.strictObject({ kind: z.literal('object'), objectId: entityIdSchema }),
])
export type MapBaselineRef = z.infer<typeof mapBaselineRefSchema>

export const mapEvidenceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('object'),
    objectId: entityIdSchema.optional(),
    objectKey: z.string().min(1).max(512).optional(),
    availability: z.enum(['available', 'missing']),
    missingReason: mapMissingReasonSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('evidence'),
    evidenceId: entityIdSchema,
    availability: z.enum(['available', 'missing']).default('available'),
  }),
])
export type MapEvidenceRef = z.infer<typeof mapEvidenceRefSchema>

export const mapJudgementSchema = z.strictObject({
  identity: z
    .strictObject({
      verdict: z.enum(['unknown', 'candidate', 'confirmed']),
      revision: shortLabelSchema.optional(),
      note: z.string().trim().min(1).max(256).optional(),
    })
    .optional(),
  locator: z
    .strictObject({
      verdict: z.enum(['unknown', 'candidate', 'confirmed']),
      revision: shortLabelSchema.optional(),
      note: z.string().trim().min(1).max(256).optional(),
    })
    .optional(),
})
export type MapJudgement = z.infer<typeof mapJudgementSchema>

const urlPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/\/\/[^/]*@/.test(value), 'URL 模式不得含凭据')

export const mapSemanticSummarySchema = z.strictObject({
  predicates: z
    .array(
      z.strictObject({
        name: shortLabelSchema,
        value: jsonValueSchema,
      }),
    )
    .max(32)
    .default([]),
})
export type MapSemanticSummary = z.infer<typeof mapSemanticSummarySchema>

export const mapStateSummarySchema = z.strictObject({
  regions: z.record(z.string().min(1).max(64), jsonValueSchema).default({}),
})
export type MapStateSummary = z.infer<typeof mapStateSummarySchema>

export const mapStructuralSummarySchema = z.strictObject({
  nodeCount: z.number().int().nonnegative().max(10_000),
  truncated: z.boolean(),
  features: jsonValueSchema.optional(),
})
export type MapStructuralSummary = z.infer<typeof mapStructuralSummarySchema>

export const mapObservationSchema = z
  .strictObject({
    id: entityIdSchema,
    schemaVersion: z.literal(MAP_FACT_SCHEMA_VERSION),
    targetId: entityIdSchema,
    dedupeKey: technicalKeySchema,
    observedAt: mapUtcInstantSchema,
    collectorVersion: collectorVersionSchema,
    sourceType: mapSourceTypeSchema,
    sourceRef: mapSourceRefSchema,
    phase: mapObservationPhaseSchema,
    localSequence: z.number().int().min(0).max(999),
    sourceEventKey: technicalKeySchema,
    conditionSnapshot: mapConditionSnapshotSchema,
    topUrlPattern: urlPatternSchema,
    framePath: z.array(frameStepSchema).max(MAX_FRAME_DEPTH),
    originChain: z.array(originSchema).max(8),
    surfaceCapability: mapSurfaceCapabilitySchema,
    boundaryRevision: shortLabelSchema.optional(),
    regionRefs: z.array(mapRegionRefSchema).max(8),
    nodeSetKind: mapNodeSetKindSchema,
    completeness: mapCompletenessSchema,
    truncated: z.boolean(),
    missingReasons: z.array(mapMissingReasonSchema).max(8),
    semanticSummary: mapSemanticSummarySchema,
    stateSummary: mapStateSummarySchema,
    structuralSummary: mapStructuralSummarySchema,
    assetRef: mapAssetRefSchema.optional(),
    actionRef: mapActionRefSchema.optional(),
    baselineRef: mapBaselineRefSchema.optional(),
    evidenceRefs: z.array(mapEvidenceRefSchema).max(16),
    captureStatus: mapCaptureStatusSchema,
    captureReason: mapMissingReasonSchema.optional(),
    judgement: mapJudgementSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceRef.sourceType !== value.sourceType) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceRef', 'sourceType'],
        message: 'sourceRef.sourceType 必须与 sourceType 一致',
      })
    }
    if (value.conditionSnapshot.targetId !== value.targetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditionSnapshot', 'targetId'],
        message: '条件快照 targetId 必须与观察 targetId 一致',
      })
    }
    if (value.assetRef && value.assetRef.targetId !== value.targetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['assetRef', 'targetId'],
        message: '资产引用不得跨 Target',
      })
    }
    if (value.phase === 'step_skipped' && 'attemptId' in value.sourceRef && value.sourceRef.attemptId) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceRef', 'attemptId'],
        message: '跳过步骤不得伪造 Attempt',
      })
    }
    if (value.captureStatus === 'missing' && value.missingReasons.length === 0 && !value.captureReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['captureReason'],
        message: '采集缺口必须给出 captureReason 或 missingReasons',
      })
    }
  })
export type MapObservation = z.infer<typeof mapObservationSchema>

export const MAP_VERIFICATION_DIMENSIONS = ['identity', 'locator', 'action', 'business'] as const
export type MapVerificationDimension = (typeof MAP_VERIFICATION_DIMENSIONS)[number]
export const mapVerificationDimensionSchema = z.enum(MAP_VERIFICATION_DIMENSIONS)

export const MAP_VERIFICATION_VERDICTS = ['confirmed', 'rejected', 'unknown', 'not_observed'] as const
export type MapVerificationVerdict = (typeof MAP_VERIFICATION_VERDICTS)[number]
export const mapVerificationVerdictSchema = z.enum(MAP_VERIFICATION_VERDICTS)

export const mapVerificationClaimSchema = z
  .strictObject({
    proposition: z.string().trim().min(1).max(512),
    instanceBinding: mapInstanceBindingSchema.optional(),
    condition: mapConditionSnapshotSchema.optional(),
    coverage: z
      .strictObject({
        regionRefs: z.array(mapRegionRefSchema).max(8),
        completeness: mapCompletenessSchema,
      })
      .optional(),
    expected: jsonValueSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.expected && typeof value.expected === 'object' && !Array.isArray(value.expected)) {
      const keys = Object.keys(value.expected)
      if (keys.length === 1 && (keys[0] === 'success' || keys[0] === 'ok')) {
        ctx.addIssue({
          code: 'custom',
          path: ['expected'],
          message: 'claim 不能只是单个 boolean success/ok',
        })
      }
    }
  })
export type MapVerificationClaim = z.infer<typeof mapVerificationClaimSchema>

export const mapVerificationSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('rule'),
    runId: entityIdSchema,
    stepRunId: entityIdSchema,
    attemptId: entityIdSchema.optional(),
    ruleRef: mediumLabelSchema,
    sourceEventKey: technicalKeySchema,
    sourceVersion: shortLabelSchema,
  }),
  z.strictObject({
    kind: z.literal('model'),
    runId: entityIdSchema,
    stepRunId: entityIdSchema,
    attemptId: entityIdSchema.optional(),
    modelAuditRef: mediumLabelSchema,
    sourceEventKey: technicalKeySchema,
    sourceVersion: shortLabelSchema,
  }),
  z.strictObject({
    kind: z.literal('user_confirmed'),
    actorId: entityIdSchema,
    decisionId: entityIdSchema,
    sourceEventKey: technicalKeySchema,
    sourceVersion: shortLabelSchema,
  }),
  z.strictObject({
    kind: z.literal('receipt'),
    serviceId: entityIdSchema,
    receiptId: entityIdSchema,
    sourceEventKey: technicalKeySchema,
    sourceVersion: shortLabelSchema,
  }),
])
export type MapVerificationSource = z.infer<typeof mapVerificationSourceSchema>

export const mapVerificationSchema = z
  .strictObject({
    id: entityIdSchema,
    schemaVersion: z.literal(MAP_FACT_SCHEMA_VERSION),
    targetId: entityIdSchema,
    dedupeKey: technicalKeySchema,
    observationIds: z.array(entityIdSchema).min(1).max(MAP_FACT_BATCH_MAX),
    actionRef: mapActionRefSchema.optional(),
    dimension: mapVerificationDimensionSchema,
    verdict: mapVerificationVerdictSchema,
    claim: mapVerificationClaimSchema,
    evidenceRefs: z.array(mapEvidenceRefSchema).max(16),
    evaluatedAt: mapUtcInstantSchema,
    evaluatorVersion: collectorVersionSchema,
    verificationSource: mapVerificationSourceSchema,
    supersedesVerificationId: entityIdSchema.optional(),
    supersedeReason: z.string().trim().min(1).max(256).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.claim.condition && value.claim.condition.targetId !== value.targetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['claim', 'condition', 'targetId'],
        message: 'claim 条件不得跨 Target',
      })
    }
    if (value.supersedesVerificationId && !value.supersedeReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedeReason'],
        message: '更正评价必须说明原因',
      })
    }
    if (new Set(value.observationIds).size !== value.observationIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['observationIds'],
        message: 'observationIds 不得重复',
      })
    }
  })
export type MapVerification = z.infer<typeof mapVerificationSchema>

export const mapFactCallerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), grant: runGrantSchema }),
  z.strictObject({ kind: z.literal('service'), serviceId: entityIdSchema }),
  z.strictObject({ kind: z.literal('console'), actorId: entityIdSchema }),
])
export type MapFactCaller = z.infer<typeof mapFactCallerSchema>

export const MAP_FACT_TYPES = ['observation', 'verification'] as const
export type MapFactType = (typeof MAP_FACT_TYPES)[number]
export const mapFactTypeSchema = z.enum(MAP_FACT_TYPES)

export const mapFactBatchItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('observation'), observation: mapObservationSchema }),
  z.strictObject({ type: z.literal('verification'), verification: mapVerificationSchema }),
])
export type MapFactBatchItem = z.infer<typeof mapFactBatchItemSchema>

export const MAP_SOURCE_AVAILABILITIES = ['live', 'deleted', 'unknown'] as const
export type MapSourceAvailability = (typeof MAP_SOURCE_AVAILABILITIES)[number]
export const mapSourceAvailabilitySchema = z.enum(MAP_SOURCE_AVAILABILITIES)

export const MAP_CONTENT_AVAILABILITIES = ['available', 'expired', 'missing'] as const
export type MapContentAvailability = (typeof MAP_CONTENT_AVAILABILITIES)[number]
export const mapContentAvailabilitySchema = z.enum(MAP_CONTENT_AVAILABILITIES)

export const MAP_FACT_ERROR_CODES = [
  'MAP_FACT_IDEMPOTENCY_CONFLICT',
  'MAP_FACT_STALE_OWNER',
  'MAP_SCHEMA_UNSUPPORTED',
  'MAP_FACT_TOO_LARGE',
  'MAP_FACT_SENSITIVE_CONTENT',
  'MAP_TARGET_MISMATCH',
  'MAP_TARGET_GONE',
  'MAP_BASELINE_UNAVAILABLE',
  'MAP_SOURCE_UNAVAILABLE',
  'MAP_WRITE_CLOSED',
  'MAP_FACT_NOT_FOUND',
] as const
export type MapFactErrorCode = (typeof MAP_FACT_ERROR_CODES)[number]
export const mapFactErrorCodeSchema = z.enum(MAP_FACT_ERROR_CODES)

const SENSITIVE_KEY =
  /^(password|passwd|passphrase|secret|token|cookie|set-cookie|authorization|api[_-]?key|access[_-]?key|private[_-]?key)$/i

export function containsSensitiveMapFields(value: unknown, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsSensitiveMapFields(value[index], `${path}[${index}]`)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key
    if (SENSITIVE_KEY.test(key)) return next
    const found = containsSensitiveMapFields(child, next)
    if (found) return found
  }
  return undefined
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function assertMapFactSize(value: unknown, label: string): void {
  const bytes = utf8ByteLength(JSON.stringify(value))
  if (bytes > MAP_FACT_MAX_BYTES) {
    const error = new Error(`${label} 超过 ${MAP_FACT_MAX_BYTES} 字节`)
    error.name = 'MAP_FACT_TOO_LARGE'
    throw error
  }
}

export function mapObservationDigestPayload(observation: MapObservation): unknown {
  const { id: _id, ...rest } = observation
  return rest
}

export function mapVerificationDigestPayload(verification: MapVerification): unknown {
  const { id: _id, ...rest } = verification
  return rest
}

export function splitMapObservation(observation: MapObservation): {
  envelope: Omit<
    MapObservation,
    'semanticSummary' | 'stateSummary' | 'structuralSummary'
  >
  content: Pick<MapObservation, 'semanticSummary' | 'stateSummary' | 'structuralSummary'>
} {
  const {
    semanticSummary,
    stateSummary,
    structuralSummary,
    ...envelope
  } = observation
  return { envelope, content: { semanticSummary, stateSummary, structuralSummary } }
}

export type ObservationId = EntityId
export type VerificationId = EntityId
export type TargetId = EntityId
