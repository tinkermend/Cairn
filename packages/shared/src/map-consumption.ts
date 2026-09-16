import { z } from 'zod'
import {
  mapAssetRefSchema,
  mapConditionSnapshotSchema,
  mapEvidenceRefSchema,
} from './map-c0.js'
import { nextCursorSchema } from './rbac.js'
import { MAX_LOCATOR_CANDIDATES } from './target-descriptor.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const MAP_CONSUMPTION_PROTOCOL = 'map-consumption@1' as const
export const MAP_CONSUMPTION_CONSUMER_VERSION = MAP_CONSUMPTION_PROTOCOL
export const MAP_CONSUMPTION_POLICY_SCHEMA_VERSION = 1 as const
export const MAP_CONSUMPTION_MAX_CANDIDATES = MAX_LOCATOR_CANDIDATES
export const MAP_CONSUMPTION_DEFAULT_CANDIDATES = 2
export const MAP_CONSUMPTION_DEFAULT_RESOLVE_MS = 1_000

export const MAP_CONSUMPTION_MODES = ['off', 'shadow', 'read_only_fallback'] as const
export type MapConsumptionMode = (typeof MAP_CONSUMPTION_MODES)[number]
export const mapConsumptionModeSchema = z.enum(MAP_CONSUMPTION_MODES)

export const MAP_CONSUMPTION_ALLOWED_STEP_TYPES = ['extract', 'assert'] as const
export type MapConsumptionAllowedStepType = (typeof MAP_CONSUMPTION_ALLOWED_STEP_TYPES)[number]
export const mapConsumptionAllowedStepTypeSchema = z.enum(MAP_CONSUMPTION_ALLOWED_STEP_TYPES)

export const MAP_SELECTION_DECISIONS = [
  'baseline',
  'shadow_only',
  'selected',
  'skipped',
  'blocked',
] as const
export type MapSelectionDecisionKind = (typeof MAP_SELECTION_DECISIONS)[number]
export const mapSelectionDecisionKindSchema = z.enum(MAP_SELECTION_DECISIONS)

export const MAP_SELECTION_REASON_CODES = [
  'OFF',
  'STEP_NOT_ELIGIBLE',
  'EFFECT_NOT_READ_ONLY',
  'BASELINE_FOUND',
  'BASELINE_AMBIGUOUS',
  'BASELINE_SURFACE_LOST',
  'BASELINE_OTHER',
  'TARGET_NOT_FOUND',
  'NO_BINDING',
  'PAGE_ONLY_REF',
  'CONDITION_UNKNOWN',
  'CONDITION_UNSATISFIED',
  'NO_UNIQUE_CANDIDATE',
  'AMBIGUOUS_CANDIDATES',
  'LOCATE_FAILED',
  'BUDGET_EXHAUSTED',
  'MANIFEST_INTEGRITY',
  'QUERY_UNAVAILABLE',
  'CANCELLED',
  'LEASE_LOST',
  'PERSISTENCE_FAILED',
  'ELIGIBILITY_CLOSED',
  'FALLBACK_USED',
  'SHADOW_WOULD_USE',
] as const
export type MapSelectionReasonCode = (typeof MAP_SELECTION_REASON_CODES)[number]
export const mapSelectionReasonCodeSchema = z.enum(MAP_SELECTION_REASON_CODES)

export const MAP_CONSUMPTION_ERROR_CODES = [
  'MAP_CONSUMER_UNAVAILABLE',
  'MAP_CONSUMPTION_NOT_ELIGIBLE',
  'MAP_DECISION_PERSISTENCE_FAILED',
  'MAP_RELEASE_NOT_PUBLISHED',
  'MAP_RELEASE_WITHDRAWN',
] as const
export type MapConsumptionErrorCode = (typeof MAP_CONSUMPTION_ERROR_CODES)[number]

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'digest 须为 64 位小写 hex')

export const mapConsumptionPolicySchema = z.strictObject({
  schemaVersion: z.literal(MAP_CONSUMPTION_POLICY_SCHEMA_VERSION),
  policyVersion: z.number().int().min(1).max(1_000_000).default(1),
  mode: mapConsumptionModeSchema,
  allowedStepTypes: z
    .array(mapConsumptionAllowedStepTypeSchema)
    .min(1)
    .max(2)
    .default(['extract', 'assert']),
  allowedAssetRefs: z.array(mapAssetRefSchema).max(64).default([]),
  maxCandidateCount: z
    .number()
    .int()
    .min(1)
    .max(MAP_CONSUMPTION_MAX_CANDIDATES)
    .default(MAP_CONSUMPTION_DEFAULT_CANDIDATES),
  maxResolveMs: z.number().int().min(1).max(5_000).default(MAP_CONSUMPTION_DEFAULT_RESOLVE_MS),
  maxExtraAiCalls: z.literal(0).default(0),
  onUnavailable: z.literal('baseline').default('baseline'),
})
export type MapConsumptionPolicy = z.infer<typeof mapConsumptionPolicySchema>

export const FACTORY_MAP_CONSUMPTION_POLICY: MapConsumptionPolicy = mapConsumptionPolicySchema.parse({
  schemaVersion: MAP_CONSUMPTION_POLICY_SCHEMA_VERSION,
  mode: 'off',
})

export const mapFrozenBindingSchema = z
  .strictObject({
    stepId: entityIdSchema,
    slotKey: z
      .string()
      .regex(/^[A-Za-z0-9:._-]{1,192}$/, 'slotKey 须为 1–192 位 [A-Za-z0-9:._-]'),
    assetRef: mapAssetRefSchema,
    bindingDigest: digestSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.assetRef.objectId || !value.assetRef.implementationKey || value.assetRef.descriptorVersion == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['assetRef'],
        message: '可操作绑定必须含 objectId、implementationKey 与 descriptorVersion',
      })
    }
  })
export type MapFrozenBinding = z.infer<typeof mapFrozenBindingSchema>

const enabledMapConsumptionSchema = z
  .strictObject({
    mode: z.enum(['shadow', 'read_only_fallback']),
    releaseId: entityIdSchema,
    targetId: entityIdSchema,
    manifestDigest: digestSchema,
    sourceWatermark: z.number().int().nonnegative(),
    policy: mapConsumptionPolicySchema,
    bindings: z.array(mapFrozenBindingSchema).max(64),
    consumerVersion: z.literal(MAP_CONSUMPTION_CONSUMER_VERSION),
    frozenAt: utcInstantSchema,
  })
  .superRefine((value, ctx) => {
    if (value.policy.mode !== value.mode) {
      ctx.addIssue({
        code: 'custom',
        path: ['policy', 'mode'],
        message: '启用冻结的 policy.mode 必须与外层 mode 相同',
      })
    }
    for (const [index, binding] of value.bindings.entries()) {
      if (binding.assetRef.targetId !== value.targetId) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'assetRef', 'targetId'],
          message: '绑定不得跨 Target',
        })
      }
    }
  })

export const frozenMapConsumptionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off') }),
  enabledMapConsumptionSchema,
])
export type FrozenMapConsumption = z.infer<typeof frozenMapConsumptionSchema>
export type EnabledMapConsumption = Extract<FrozenMapConsumption, { mode: 'shadow' | 'read_only_fallback' }>

export const mapConsumptionOverrideSchema = z.strictObject({
  mode: z.literal('off').optional(),
  releaseId: entityIdSchema.optional(),
})
export type MapConsumptionOverride = z.infer<typeof mapConsumptionOverrideSchema>

export const mapCandidateEvaluationSchema = z.strictObject({
  objectId: entityIdSchema.optional(),
  implementationKey: z.string().min(1).max(192).optional(),
  descriptorVersion: z.number().int().nonnegative().optional(),
  matches: z.number().int().nonnegative(),
  outcome: z.enum(['FOUND', 'NOT_FOUND', 'AMBIGUOUS', 'SURFACE_LOST', 'CAPABILITY_MISSING', 'SKIPPED']),
  reasonCode: mapSelectionReasonCodeSchema.optional(),
})
export type MapCandidateEvaluation = z.infer<typeof mapCandidateEvaluationSchema>

export const mapSelectionDecisionSchema = z.strictObject({
  decisionId: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  attemptId: entityIdSchema,
  decisionOrdinal: z.number().int().min(0).max(32),
  targetId: entityIdSchema,
  releaseId: entityIdSchema.optional(),
  manifestDigest: digestSchema.optional(),
  policyVersion: z.number().int().positive().optional(),
  consumerVersion: z.string().min(1).max(64).optional(),
  assetRef: mapAssetRefSchema.optional(),
  conditionSnapshot: mapConditionSnapshotSchema.optional(),
  coverage: z.string().min(1).max(64).optional(),
  baselineOutcome: z.string().min(1).max(64),
  candidatesEvaluated: z.array(mapCandidateEvaluationSchema).max(8),
  selectedDescriptorVersion: z.number().int().nonnegative().optional(),
  selectedDescriptorDigest: digestSchema.optional(),
  mode: mapConsumptionModeSchema,
  decision: mapSelectionDecisionKindSchema,
  reasonCode: mapSelectionReasonCodeSchema,
  spentMs: z.number().int().nonnegative().max(120_000),
  extraAiCalls: z.literal(0).default(0),
  evidenceRefs: z.array(mapEvidenceRefSchema).max(16).default([]),
})
export type MapSelectionDecision = z.infer<typeof mapSelectionDecisionSchema>

export const mapConsumptionEligibilitySchema = z.strictObject({
  reportId: z
    .string()
    .regex(/^[A-Za-z0-9:._-]{8,128}$/, 'reportId 须为 8–128 位 [A-Za-z0-9:._-]'),
  eligibleStepTypes: z.array(mapConsumptionAllowedStepTypeSchema).min(1).max(2),
  recordedAt: utcInstantSchema,
  /** A confirmed wrong match blocks new fallback runs until a new T report re-grants it. */
  suspendedAt: utcInstantSchema.optional(),
  suspensionReason: z.string().trim().min(1).max(256).optional(),
})
export type MapConsumptionEligibility = z.infer<typeof mapConsumptionEligibilitySchema>

export const mapConsumptionPolicyDtoSchema = z.strictObject({
  targetId: entityIdSchema,
  revision: z.number().int().min(0),
  policy: mapConsumptionPolicySchema,
  eligibility: mapConsumptionEligibilitySchema.nullable(),
  updatedAt: utcInstantSchema,
})
export type MapConsumptionPolicyDto = z.infer<typeof mapConsumptionPolicyDtoSchema>

export const mapConsumptionPolicyUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'idempotencyKey 须为 8–128 位 [A-Za-z0-9._:-]'),
  mode: mapConsumptionModeSchema,
  allowedStepTypes: z.array(mapConsumptionAllowedStepTypeSchema).min(1).max(2).optional(),
  allowedAssetRefs: z.array(mapAssetRefSchema).max(64).optional(),
  maxCandidateCount: z.number().int().min(1).max(MAP_CONSUMPTION_MAX_CANDIDATES).optional(),
  maxResolveMs: z.number().int().min(1).max(5_000).optional(),
  reason: z.string().trim().min(1).max(512),
})
export type MapConsumptionPolicyUpdateBody = z.infer<typeof mapConsumptionPolicyUpdateBodySchema>

export const mapDecisionListQuerySchema = z.object({
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => (value === undefined ? 50 : typeof value === 'number' ? value : Number(value)))
    .pipe(z.number().int().min(1).max(100)),
  cursor: entityIdSchema.optional(),
})
export type MapDecisionListQuery = z.infer<typeof mapDecisionListQuerySchema>

export const mapDecisionListResponseSchema = z.strictObject({
  items: z.array(mapSelectionDecisionSchema),
  nextCursor: nextCursorSchema,
})
export type MapDecisionListResponse = z.infer<typeof mapDecisionListResponseSchema>

export function isMapConsumptionEnabled(
  snapshot: { mapConsumption?: { mode?: string } | FrozenMapConsumption | null },
): snapshot is { mapConsumption: EnabledMapConsumption } {
  return snapshot.mapConsumption?.mode === 'shadow' || snapshot.mapConsumption?.mode === 'read_only_fallback'
}

export function resolveMapConsumptionPolicy(
  stored: MapConsumptionPolicy | null | undefined,
): MapConsumptionPolicy {
  return mapConsumptionPolicySchema.parse(stored ?? FACTORY_MAP_CONSUMPTION_POLICY)
}
