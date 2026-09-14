import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { executionErrorSchema } from './runtime-error.js'
import {
  isFinishedRunStatus,
  runInputSchema,
  runSnapshotSchema,
  runStatusSchema,
  stepRunStatusSchema,
  attemptStatusSchema,
  type RunStatus,
} from './run.js'
import { sessionPolicyOverrideSchema, sessionStatusSchema } from './session.js'
import { executionPolicySchema } from './step.js'
import { evidenceMetadataSchema, runEvidenceStatusSchema, type RunEvidenceStatus } from './evidence.js'
import { evidencePolicySchema } from './evidence-policy.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

export const RUN_ERROR_CODES = [
  'RUN_NOT_FOUND',
  'RUN_IDEMPOTENCY_CONFLICT',
  'RUN_ACCOUNT_MISMATCH',
  'RUN_ACCOUNT_DISABLED',
  'RUN_ACCOUNT_REQUIRED',
  'RUN_NOT_REVIEWABLE',
  'RUN_NOT_WAITING_FOR_AUTH',
  'WORKER_UNREACHABLE',
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
  idempotencyKey: idempotencyKeySchema.optional(),
})
export type CreateRunBody = z.infer<typeof createRunBodySchema>

export const trialRunBodySchema = z.strictObject({
  revision: z.number().int().min(1),
  targetAccountId: entityIdSchema.optional(),
  input: runInputSchema.optional(),
  policy: executionPolicySchema.optional(),
  sessionPolicy: sessionPolicyOverrideSchema.optional(),
  evidencePolicy: evidencePolicySchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
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

/** GET 派生，不落库。列表不带，详情必带。 */
export const runPlacementSchema = z.strictObject({
  state: runPlacementStateSchema,
  sessionId: entityIdSchema.nullable(),
  ownerWorkerId: z.string().min(1).max(128).nullable(),
  sessionStatus: sessionStatusSchema.nullable(),
})
export type RunPlacement = z.infer<typeof runPlacementSchema>

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
  scenarioVersionId: entityIdSchema,
  scenarioVersionKind: z.enum(['published', 'trial']).optional(),
  createdAt: utcInstantSchema,
  startedAt: instantOrNull,
  finishedAt: instantOrNull,
  evidenceStatus: runEvidenceStatusSchema,
  lease: runListLeaseSchema,
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
  })
export type RunDetailDto = z.infer<typeof runDetailSchema>

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
