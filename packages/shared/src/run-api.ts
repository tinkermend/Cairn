import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { executionErrorSchema } from './runtime-error.js'
import { runInputSchema, runSnapshotSchema, runStatusSchema, stepRunStatusSchema, attemptStatusSchema } from './run.js'
import { executionPolicySchema } from './step.js'
import { evidenceMetadataSchema } from './evidence.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

export const RUN_ERROR_CODES = [
  'RUN_NOT_FOUND',
  'RUN_IDEMPOTENCY_CONFLICT',
  'RUN_ACCOUNT_MISMATCH',
  'RUN_ACCOUNT_DISABLED',
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
  idempotencyKey: idempotencyKeySchema.optional(),
})
export type CreateRunBody = z.infer<typeof createRunBodySchema>

const instantOrNull = utcInstantSchema.nullable()

export const runSummarySchema = z.object({
  id: entityIdSchema,
  status: runStatusSchema,
  cancelRequested: z.boolean(),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  createdAt: utcInstantSchema,
  startedAt: instantOrNull,
  finishedAt: instantOrNull,
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

export const runDetailSchema = runSummarySchema.extend({
  snapshot: runSnapshotSchema,
  context: z.record(z.string(), jsonValueSchema),
  stepRuns: z.array(stepRunDtoSchema),
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
