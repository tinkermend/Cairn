import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { executionErrorSchema } from './runtime-error.js'
import {
  attemptStatusSchema,
  debugCheckpointSchema,
  debugModeSchema,
  debugOverlaySchema,
  isFinishedRunStatus,
  runInputSchema,
  runSnapshotSchema,
  runStatusSchema,
  stepRunStatusSchema,
  type RunStatus,
} from './run.js'
import { sessionPolicyOverrideSchema, sessionStatusSchema } from './session.js'
import { executionPolicySchema } from './step.js'
import { evidenceMetadataSchema, runEvidenceStatusSchema, type RunEvidenceStatus } from './evidence.js'
import { evidencePolicySchema } from './evidence-policy.js'
import { mapCapturePolicyOverrideSchema } from './map-capture.js'
import { mapConsumptionOverrideSchema } from './map-consumption.js'
import { authCheckpointSchema } from './session-auth-recovery.js'
import { outcomeResultDtoSchema, outcomeStatusSchema, type OutcomeResultDto, type OutcomeStatus } from './outcome.js'
import { resourceDeletedBySchema } from './resource-lifecycle.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

export const RUN_ERROR_CODES = [
  'RUN_NOT_FOUND',
  'RUN_IDEMPOTENCY_CONFLICT',
  'RUN_ACCOUNT_MISMATCH',
  'RUN_ACCOUNT_DISABLED',
  'RUN_ACCOUNT_REQUIRED',
  'RUN_NOT_REVIEWABLE',
  'RUN_NOT_TERMINAL',
  'RUN_BUSY',
  'RESOURCE_BUSY',
  'RESOURCE_DELETED',
  'DELETE_SCOPE_EXPANDED',
  'RUN_NOT_WAITING_FOR_AUTH',
  'WORKER_UNREACHABLE',
  'WORKER_RESULT_UNKNOWN',
  'WORKER_GENERATION_MISMATCH',
  'AUTH_HOLD_UNBOUND',
  'AUTH_CONTROL_HELD',
  'AUTH_CONTROL_INVALID',
  'AUTH_NOT_VERIFIED',
  'AUTH_INPUT_REJECTED',
  'PAGE_STALE',
  'EVIDENCE_NOT_FOUND',
  'EVIDENCE_NOT_AVAILABLE',
  'AI_DISABLED',
  'AI_CONFIG_INVALID',
  'AI_EXECUTE_FORBIDDEN',
  'AI_BUDGET_EXCEEDED',
  'DEBUG_MODE_NOT_ALLOWED',
  'DEBUG_NOT_ALLOWED',
  'RUN_NOT_HOLDING',
  'WAITING_FOR_STABLE_HOLD',
  'STEP_CANNOT_RETRY',
  'OBSERVE_TARGET_MISMATCH',
  'OBSERVE_TARGET_NOT_FOUND',
  'OBSERVE_GRANT_EXPIRED',
  'DEBUG_WORKER_LOST',
  'DEBUG_SESSION_EXPIRED',
  'DEBUG_SESSION_TIMEOUT',
  'SIDE_EFFECT_CONFIRM_REQUIRED',
  'PAGE_CHANGED_ACK_REQUIRED',
  'RUN_WAITING_FOR_AUTH',
  'AUTH_CONTEXT_NOT_RECOVERABLE',
  'AUTH_RECOVERY_LIMIT',
  'MAP_CONSUMER_UNAVAILABLE',
  'MAP_CONSUMPTION_NOT_ELIGIBLE',
  'MAP_RELEASE_NOT_PUBLISHED',
  'MAP_RELEASE_WITHDRAWN',
] as const
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number]

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'idempotencyKey 须为 8–128 位 [A-Za-z0-9._:-]')

export const createRunBodySchema = z.strictObject({
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema.optional(),
  targetAccountId: entityIdSchema.optional(),
  input: runInputSchema.optional(),
  policy: executionPolicySchema.optional(),
  /** 会话策略覆盖；与 policy 并列，不进 Step 级 executionPolicy。 */
  sessionPolicy: sessionPolicyOverrideSchema.optional(),
  evidencePolicy: evidencePolicySchema.optional(),
  mapCapturePolicy: mapCapturePolicyOverrideSchema.optional(),
  mapConsumption: mapConsumptionOverrideSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
  debugMode: debugModeSchema.optional(),
})
export type CreateRunBody = z.infer<typeof createRunBodySchema>

export const trialRunBodySchema = z.strictObject({
  revision: z.number().int().min(1),
  targetAccountId: entityIdSchema.optional(),
  input: runInputSchema.optional(),
  policy: executionPolicySchema.optional(),
  sessionPolicy: sessionPolicyOverrideSchema.optional(),
  evidencePolicy: evidencePolicySchema.optional(),
  mapCapturePolicy: mapCapturePolicyOverrideSchema.optional(),
  mapConsumption: mapConsumptionOverrideSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
  debugMode: debugModeSchema.optional(),
})
export type TrialRunBody = z.infer<typeof trialRunBodySchema>

const instantOrNull = utcInstantSchema.nullable()

export const runListLeaseSchema = z
  .object({
    holderWorkerId: z.string().min(1).max(128),
  })
  .nullable()

export const runDetailLeaseSchema = z
  .object({
    holderWorkerId: z.string().min(1).max(128),
    fencingToken: z.number().int().min(1),
    expiresAt: utcInstantSchema,
  })
  .nullable()

export const RUN_PLACEMENT_STATES = [
  'not_applicable',
  'claimed',
  'claimable',
  'owner_required',
  'owner_at_capacity',
  'session_not_ready',
  'session_lost',
] as const
export type RunPlacementState = (typeof RUN_PLACEMENT_STATES)[number]
export const runPlacementStateSchema = z.enum(RUN_PLACEMENT_STATES)

/** GET 派生，不落库。列表不带，详情必带。等待原因与占用主体只在读时计算。 */
export const runPlacementSchema = z.strictObject({
  state: runPlacementStateSchema,
  sessionId: entityIdSchema.nullable(),
  ownerWorkerId: z.string().min(1).max(128).nullable(),
  sessionStatus: sessionStatusSchema.nullable(),
  waitReason: z
    .enum([
      'SESSION_IN_USE_BY_RUN',
      'SESSION_IN_MAINTENANCE',
      'SESSION_WAITING_FOR_AUTH',
      'SESSION_LOST',
      'WORKER_SESSION_CAPACITY',
      'PROFILE_AFFINITY_WAIT',
      'NO_ELIGIBLE_WORKER',
    ])
    .nullable()
    .default(null),
  occupyingRunId: entityIdSchema.nullable().default(null),
  occupyingOperationId: entityIdSchema.nullable().default(null),
  targetWorkerId: z.string().min(1).max(128).nullable().default(null),
  profileAffinityUntil: utcInstantSchema.nullable().default(null),
  generation: z.number().int().positive().nullable().default(null),
  acquireReason: z.enum(['reused', 'created']).nullable().default(null),
  profileFallback: z.boolean().nullable().default(null),
})
export type RunPlacement = z.infer<typeof runPlacementSchema>

export function runPlacement(input: z.input<typeof runPlacementSchema>): RunPlacement {
  return runPlacementSchema.parse(input)
}

export const runSummarySchema = z.object({
  source: z.object({ kind: z.enum(['console', 'service']), callerId: entityIdSchema.optional(), credentialId: entityIdSchema.optional() }).optional(),
  id: entityIdSchema,
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  targetId: entityIdSchema,
  /**
   * 场景名与目标系统名取当前值，只用于人认得出这是哪一条，不参与执行解释——
   * 步骤定义一律来自 Run 自己的 Snapshot。控制台上列一串 UUID 等于没有信息。
   */
  targetName: z.string().min(1).max(128),
  targetAccountId: entityIdSchema.nullable(),
  targetAccountName: z.string().min(1).max(128).nullable(),
  scenarioId: entityIdSchema,
  scenarioName: z.string().min(1).max(128),
  targetDeleted: z.boolean().optional(),
  scenarioDeleted: z.boolean().optional(),
  targetAccountDeleted: z.boolean().optional(),
  scenarioVersionId: entityIdSchema,
  scenarioVersionKind: z.enum(['published', 'trial']).optional(),
  createdAt: utcInstantSchema,
  startedAt: instantOrNull,
  finishedAt: instantOrNull,
  evidenceStatus: runEvidenceStatusSchema,
  outcomeStatus: outcomeStatusSchema.default('NOT_EVALUATED'),
  lease: runListLeaseSchema,
  debugMode: debugModeSchema.default('runThrough'),
  deletedAt: instantOrNull.optional(),
  deletedBy: resourceDeletedBySchema.nullable().optional(),
})
export type RunSummaryDto = z.infer<typeof runSummarySchema>

export const attemptDtoSchema = z.object({
  id: entityIdSchema,
  attemptNo: z.number().int().min(1),
  status: attemptStatusSchema,
  startedAt: utcInstantSchema,
  finishedAt: instantOrNull,
  output: jsonValueSchema.nullable(),
  error: executionErrorSchema.nullable(),
})
export type AttemptDto = z.infer<typeof attemptDtoSchema>

export const stepRunDtoSchema = z.object({
  id: entityIdSchema,
  stepId: entityIdSchema,
  name: z.string().min(1),
  type: z.string().min(1),
  ordinal: z.number().int().min(0),
  status: stepRunStatusSchema,
  outcomeStatus: outcomeStatusSchema.default('NOT_EVALUATED'),
  startedAt: instantOrNull,
  finishedAt: instantOrNull,
  attempts: z.array(attemptDtoSchema),
})
export type StepRunDto = z.infer<typeof stepRunDtoSchema>

export const runDetailSchema = runSummarySchema
  .omit({ lease: true })
  .extend({
    snapshot: runSnapshotSchema,
    context: z.record(z.string(), jsonValueSchema),
    stepRuns: z.array(stepRunDtoSchema),
    lease: runDetailLeaseSchema,
    placement: runPlacementSchema,
    outcomeResults: z.array(outcomeResultDtoSchema).default([]),
    checkpoint: debugCheckpointSchema.nullable().optional(),
    debugOverlay: debugOverlaySchema.nullable().optional(),
    authCheckpoint: authCheckpointSchema.nullable().optional(),
  })
export type RunDetailDto = z.infer<typeof runDetailSchema>

export const runListQuerySchema = z.object({
  search: z.string().trim().optional(),
  targetId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  status: runStatusSchema.optional(),
  evidenceStatus: runEvidenceStatusSchema.optional(),
  outcomeStatus: outcomeStatusSchema.optional(),
  isTrial: z.coerce.boolean().optional(),
  sourceKind: z.enum(['console', 'service']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type RunListQuery = z.input<typeof runListQuerySchema>

export const runListResponseSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: nextCursorSchema,
})
export type RunListResponse = z.infer<typeof runListResponseSchema>

export const runEvidenceListResponseSchema = z.object({
  items: z.array(evidenceMetadataSchema),
  nextCursor: nextCursorSchema,
})
export type RunEvidenceListResponse = z.infer<typeof runEvidenceListResponseSchema>

export const runObservationSchema = z.strictObject({
  run: runDetailSchema,
  evidence: runEvidenceListResponseSchema,
  eventSeq: z.number().int().nonnegative(),
  earliestEventSeq: z.number().int().nonnegative(),
})
export type RunObservation = z.infer<typeof runObservationSchema>

/** SSE 可以 complete 并停止自动重连。 */
export function isRunObservationComplete(input: {
  status: RunStatus
  evidenceStatus: RunEvidenceStatus
}): boolean {
  return isFinishedRunStatus(input.status) && input.evidenceStatus !== 'PENDING'
}
