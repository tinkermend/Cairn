import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { idempotencyKeySchema } from './run-api.js'
import {
  RECORDING_NORMALIZER_VERSION,
  recordingDraftSchema,
  recordingItemSchema,
} from './recording.js'
import { scenarioNameSchema } from './scenario.js'
import { outcomeCandidateSchema } from './outcome-candidate.js'
import { stepSchema } from './step.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const RECORDING_BINDING_STATUSES = ['issued', 'claimed', 'closed'] as const
export type RecordingBindingStatus = (typeof RECORDING_BINDING_STATUSES)[number]

export const RECORDING_TICKET_TTL_SECONDS = 5 * 60
export const RECORDING_UPLOAD_TTL_SECONDS = 2 * 60 * 60
export const RECORDING_BRIDGE_VERSION = 1

export const recordingInsertAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({ kind: z.literal('after'), stepId: entityIdSchema }),
])
export type RecordingInsertAnchor = z.infer<typeof recordingInsertAnchorSchema>

export const createRecordingBindingBodySchema = z.strictObject({
  revision: z.number().int().positive(),
  insertAnchor: recordingInsertAnchorSchema,
})
export type CreateRecordingBindingBody = z.infer<typeof createRecordingBindingBodySchema>

export const claimRecordingBindingBodySchema = z
  .strictObject({
    ticket: z.string().min(32).max(128).optional(),
    bindingId: entityIdSchema.optional(),
    apiOrigin: z.string().url().max(256),
  })
  .refine((body) => Boolean(body.ticket || body.bindingId), {
    message: '领取绑定必须提供 ticket 或 bindingId',
  })
export type ClaimRecordingBindingBody = z.infer<typeof claimRecordingBindingBodySchema>

export const recordingBindingSchema = z.strictObject({
  id: entityIdSchema,
  scenarioId: entityIdSchema,
  scenarioName: scenarioNameSchema,
  targetId: entityIdSchema,
  targetName: z.string().min(1),
  entryUrl: z.string().min(1),
  loginUrl: z.string().nullable(),
  draftRevision: z.number().int().positive(),
  insertAnchor: recordingInsertAnchorSchema,
  status: z.enum(RECORDING_BINDING_STATUSES),
  apiOrigin: z.string().min(1),
  expiresAt: utcInstantSchema,
  uploadExpiresAt: utcInstantSchema,
  recordingDraftId: entityIdSchema.nullable(),
  createdAt: utcInstantSchema,
  claimedAt: utcInstantSchema.nullable(),
  closedAt: utcInstantSchema.nullable(),
})
export type RecordingBindingDto = z.infer<typeof recordingBindingSchema>

export const recordingBindingCreatedSchema = z.strictObject({
  binding: recordingBindingSchema,
  ticket: z.string().min(32).max(128),
})
export type RecordingBindingCreated = z.infer<typeof recordingBindingCreatedSchema>

export const openRecordingBindingResponseSchema = z.strictObject({
  binding: recordingBindingSchema.nullable(),
})
export type OpenRecordingBindingResponse = z.infer<typeof openRecordingBindingResponseSchema>

export const recordingDispositionSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
    disposition: z.literal('accept'),
  }),
  z.strictObject({
    sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
    disposition: z.literal('replace'),
    step: stepSchema,
  }),
  z.strictObject({
    sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
    disposition: z.literal('discard'),
    reason: z.string().trim().min(1).max(200),
  }),
])
export type RecordingDisposition = z.infer<typeof recordingDispositionSchema>

export const recordingImportPreviewItemSchema = recordingItemSchema.extend({
  ready: z.boolean(),
  candidateStep: stepSchema.optional(),
  outcomeCandidate: outcomeCandidateSchema.optional(),
})
export type RecordingImportPreviewItem = z.infer<typeof recordingImportPreviewItemSchema>

export const previewRecordingImportBodySchema = z.strictObject({
  recordingDraftId: entityIdSchema,
  baseRevision: z.number().int().positive(),
  insertAnchor: recordingInsertAnchorSchema,
})
export type PreviewRecordingImportBody = z.infer<typeof previewRecordingImportBodySchema>

export const recordingImportPreviewSchema = z.strictObject({
  recordingDraftId: entityIdSchema,
  recordingName: scenarioNameSchema,
  normalizerVersion: z.literal(RECORDING_NORMALIZER_VERSION),
  sourceVersion: z.string().min(1),
  sourceDigest: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  remainingStepCapacity: z.number().int().nonnegative(),
  currentRevision: z.number().int().positive(),
  insertAnchor: recordingInsertAnchorSchema,
  items: z.array(recordingImportPreviewItemSchema),
  diagnostics: z.array(z.string()),
})
export type RecordingImportPreview = z.infer<typeof recordingImportPreviewSchema>

export const applyRecordingImportBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  baseRevision: z.number().int().positive(),
  recordingDraftId: entityIdSchema,
  normalizerVersion: z.literal(RECORDING_NORMALIZER_VERSION),
  sourceDigest: z.string().min(1).max(64),
  insertAnchor: recordingInsertAnchorSchema,
  dispositions: z.array(recordingDispositionSchema).min(1),
})
export type ApplyRecordingImportBody = z.infer<typeof applyRecordingImportBodySchema>

export const recordingImportReceiptSchema = z.strictObject({
  id: entityIdSchema,
  scenarioId: entityIdSchema,
  recordingDraftId: entityIdSchema,
  sourceDigest: z.string().min(1),
  normalizerVersion: z.string().min(1),
  baseRevision: z.number().int().positive(),
  newRevision: z.number().int().positive(),
  insertedStepIds: z.array(entityIdSchema),
  sourceMap: z.array(
    z.strictObject({
      sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
      stepId: entityIdSchema.optional(),
      disposition: z.enum(['accept', 'replace', 'discard']),
      reason: z.string().max(200).optional(),
    }),
  ),
  createdAt: utcInstantSchema,
})
export type RecordingImportReceipt = z.infer<typeof recordingImportReceiptSchema>

export const recordingImportListResponseSchema = z.object({
  bindings: z.array(recordingBindingSchema),
  drafts: z.array(recordingDraftSchema),
  receipts: z.array(recordingImportReceiptSchema),
  nextCursor: nextCursorSchema,
})
export type RecordingImportListResponse = z.infer<typeof recordingImportListResponseSchema>

export const recordingBridgeStartSchema = z.strictObject({
  version: z.literal(RECORDING_BRIDGE_VERSION),
  type: z.literal('cairn.recording.start'),
  bindingId: entityIdSchema,
  ticket: z.string().min(32).max(128),
})
export type RecordingBridgeStart = z.infer<typeof recordingBridgeStartSchema>

export const recordingBridgeAckSchema = z.strictObject({
  version: z.literal(RECORDING_BRIDGE_VERSION),
  type: z.literal('cairn.recording.ack'),
  bindingId: entityIdSchema,
  opened: z.boolean(),
  attached: z.boolean(),
  reason: z.string().max(256).optional(),
})
export type RecordingBridgeAck = z.infer<typeof recordingBridgeAckSchema>

export function sameSourceIndexes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function recordingStudioPath(scenarioId: string, recordingDraftId?: string): string {
  const base = `/scenarios/${scenarioId}`
  return recordingDraftId ? `${base}?import=${recordingDraftId}` : base
}

export function normalizeApiOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '')
}

export function originOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

export function recordingAllowedOrigins(entryUrl: string, loginUrl?: string | null): string[] {
  const origins = [originOfUrl(entryUrl), loginUrl ? originOfUrl(loginUrl) : undefined].filter(
    (item): item is string => Boolean(item),
  )
  return [...new Set(origins)]
}

export function urlAllowedForRecording(url: string, allowed: readonly string[]): boolean {
  const origin = originOfUrl(url)
  return Boolean(origin && allowed.includes(origin))
}
