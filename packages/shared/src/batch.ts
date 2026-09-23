import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { dataBindingSchema } from './dataset.js'

export const BATCH_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]
export const batchStatusSchema = z.enum(BATCH_STATUSES)

export const BATCH_FAILURE_POLICIES = ['continue', 'stop_on_first', 'stop_on_threshold'] as const
export type BatchFailurePolicy = (typeof BATCH_FAILURE_POLICIES)[number]
export const batchFailurePolicySchema = z.enum(BATCH_FAILURE_POLICIES)

export const BATCH_ITEM_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NEEDS_REVIEW',
] as const
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number]
export const batchItemStatusSchema = z.enum(BATCH_ITEM_STATUSES)

export const BATCH_FAILURE_DOMAINS = ['ITEM', 'TARGET', 'SESSION'] as const
export type BatchFailureDomain = (typeof BATCH_FAILURE_DOMAINS)[number]
export const batchFailureDomainSchema = z.enum(BATCH_FAILURE_DOMAINS)

export const batchPacingSchema = z.strictObject({
  minDelayMs: z.number().int().min(0).max(60000).default(1000),
  maxDelayMs: z.number().int().min(0).max(60000).default(3000),
})
export type BatchPacing = z.infer<typeof batchPacingSchema>

export function computePacingJitter(minMs: number, maxMs: number): number {
  if (minMs <= 0 && maxMs <= 0) return 0
  const min = Math.max(0, Math.min(minMs, maxMs))
  const max = Math.max(0, Math.max(minMs, maxMs))
  if (min === max) return min
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function calculatePacingDelayMs(delaySec: number, jitterPercent: number = 20): number {
  const baseMs = Math.max(0, delaySec * 1000)
  if (baseMs === 0) return 0
  const jitterRange = (baseMs * Math.max(0, Math.min(jitterPercent, 100))) / 100
  const minMs = Math.round(baseMs - jitterRange)
  const maxMs = Math.round(baseMs + jitterRange)
  return computePacingJitter(minMs, maxMs)
}

export const createBatchBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  datasetId: entityIdSchema,
  selectedRowIndices: z.array(z.number().int().nonnegative()).optional(),
  binding: dataBindingSchema,
  targetAccountId: entityIdSchema.optional(),
  failurePolicy: batchFailurePolicySchema.default('stop_on_threshold'),
  failureThreshold: z.number().int().min(1).max(50).default(5),
  maxConcurrentSessions: z.number().int().min(1).max(10).default(1),
  pacing: batchPacingSchema.default({ minDelayMs: 1500, maxDelayMs: 3500 }),
  resetPageBetweenItems: z.boolean().default(true),
})
export type CreateBatchBody = z.infer<typeof createBatchBodySchema>

export const batchDetailSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string(),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  datasetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable().optional(),
  status: batchStatusSchema,
  failurePolicy: batchFailurePolicySchema,
  failureThreshold: z.number().int(),
  pacingConfig: batchPacingSchema,
  totalItems: z.number().int().nonnegative(),
  successItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  reviewItems: z.number().int().nonnegative(),
  pausedReason: z.string().nullable().optional(),
  createdByAccountId: entityIdSchema.nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type BatchDetail = z.infer<typeof batchDetailSchema>

export const batchItemDtoSchema = z.strictObject({
  id: entityIdSchema,
  batchId: entityIdSchema,
  datasetRowIndex: z.number().int().nonnegative(),
  runId: entityIdSchema.nullable().optional(),
  itemStatus: batchItemStatusSchema,
  outcomeVerdict: z.string().nullable().optional(),
  failureDomain: batchFailureDomainSchema.nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  startedAt: utcInstantSchema.nullable().optional(),
  finishedAt: utcInstantSchema.nullable().optional(),
})
export type BatchItemDto = z.infer<typeof batchItemDtoSchema>

export const batchItemListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  status: batchItemStatusSchema.optional(),
})
export type BatchItemListQuery = z.infer<typeof batchItemListQuerySchema>

export const batchItemListResponseSchema = z.strictObject({
  items: z.array(batchItemDtoSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
})
export type BatchItemListResponse = z.infer<typeof batchItemListResponseSchema>

export const batchListQuerySchema = z.strictObject({
  scenarioId: entityIdSchema.optional(),
  datasetId: entityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})
export type BatchListQuery = z.infer<typeof batchListQuerySchema>

export const batchListResponseSchema = z.strictObject({
  items: z.array(batchDetailSchema),
  nextCursor: z.string().optional(),
})
export type BatchListResponse = z.infer<typeof batchListResponseSchema>

export const batchExportResponseSchema = z.strictObject({
  filename: z.string(),
  base64: z.string(),
  rowCount: z.number().int().nonnegative(),
})
export type BatchExportResponse = z.infer<typeof batchExportResponseSchema>

export const pauseBatchBodySchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
})
export type PauseBatchBody = z.infer<typeof pauseBatchBodySchema>

export const cancelBatchBodySchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
})
export type CancelBatchBody = z.infer<typeof cancelBatchBodySchema>

