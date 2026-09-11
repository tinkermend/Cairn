import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { executionErrorSchema } from './runtime-error.js'
import { runInputSchema, runSnapshotSchema, runStatusSchema, stepRunStatusSchema, attemptStatusSchema } from './run.js'
import { sessionPolicyOverrideSchema } from './session.js'
import { executionPolicySchema } from './step.js'
import { evidenceMetadataSchema } from './evidence.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

export const RUN_ERROR_CODES = [
  'RUN_NOT_FOUND',
  'RUN_IDEMPOTENCY_CONFLICT',
  'RUN_ACCOUNT_MISMATCH',
  'RUN_ACCOUNT_DISABLED',
  'RUN_NOT_REVIEWABLE',
  'RUN_NOT_WAITING_FOR_AUTH',
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
  idempotencyKey: idempotencyKeySchema.optional(),
})
export type CreateRunBody = z.infer<typeof createRunBodySchema>

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

export const runSummarySchema = z.object({
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
  createdAt: utcInstantSchema,
  startedAt: instantOrNull,
  finishedAt: instantOrNull,
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
