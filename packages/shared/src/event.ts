import { z } from 'zod'
import { requestIdValueSchema } from './error.js'
import { entityIdSchema, jsonValueSchema, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

/**
 * 运行事件信封。
 *
 * 持久账本和 SSE 补读使用 `persistedRunEventSchema`（必填 runId / sequence）。
 * 跨进程变化提示只传 `{ namespace, runId, eventSeq }`，不传本信封。
 *
 * `type` 本轮闭合。乱写 `run.updated` 会失败。需要新事件时改枚举并补测试。
 */

export const RUN_EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'run.cancel_requested',
  'run.auth_wait',
  'run.auth_resumed',
  'run.auth_control_changed',
  'run.page_handoff',
  'run.holding',
  'run.debug_resumed',
  'run.debug_stopped',
  'observation.highlighted',
  'observation.picked',
  'step_run.started',
  'step_run.finished',
  'attempt.started',
  'attempt.finished',
  'evidence.recorded',
  'evidence.missing',
] as const
export type RunEventType = (typeof RUN_EVENT_TYPES)[number]
export const runEventTypeSchema = z.enum(RUN_EVENT_TYPES)

export const eventEnvelopeSchema = z.strictObject({
  schemaVersion: runtimeSchemaVersionSchema,
  eventId: entityIdSchema,
  type: runEventTypeSchema,
  occurredAt: utcInstantSchema,
  runId: entityIdSchema.optional(),
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  /** Worker 标识，与 CAIRN_WORKER_ID 同形，不是 UUID。 */
  workerId: z.string().min(1).max(128).optional(),
  requestId: requestIdValueSchema.optional(),
  sequence: z.number().int().nonnegative().optional(),
  payload: jsonValueSchema,
})
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>

export const persistedRunEventSchema = eventEnvelopeSchema.extend({
  runId: entityIdSchema,
  sequence: z.number().int().positive(),
})
export type PersistedRunEvent = z.infer<typeof persistedRunEventSchema>

export const changeHintSchema = z.strictObject({
  namespace: z.string().min(1).max(64),
  runId: entityIdSchema,
  eventSeq: z.number().int().nonnegative(),
})
export type ChangeHint = z.infer<typeof changeHintSchema>

const RUN_EVENT_CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/i

export function encodeRunEventCursor(runId: string, sequence: number): string {
  return `${runId}:${sequence}`
}

export function parseRunEventCursor(raw: string): { runId: string; sequence: number } | null {
  const match = RUN_EVENT_CURSOR.exec(raw.trim())
  if (!match) return null
  const sequence = Number(match[2])
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null
  return { runId: match[1]!.toLowerCase(), sequence }
}

export const RUN_STREAM_RESET_REASONS = [
  'cursor_invalid',
  'cursor_run_mismatch',
  'cursor_expired',
  'cursor_ahead',
  'backlog',
] as const
export type RunStreamResetReason = (typeof RUN_STREAM_RESET_REASONS)[number]

export const RUN_STREAM_ERROR_CODES = ['UNAUTHORIZED', 'FORBIDDEN', 'INTERNAL'] as const
export type RunStreamErrorCode = (typeof RUN_STREAM_ERROR_CODES)[number]

export const runStreamReadySchema = z.strictObject({
  kind: z.literal('ready'),
  runId: entityIdSchema,
  eventSeq: z.number().int().nonnegative(),
  earliestEventSeq: z.number().int().nonnegative(),
  realtime: z.boolean(),
})
export const runStreamResetSchema = z.strictObject({
  kind: z.literal('reset'),
  runId: entityIdSchema,
  reason: z.enum(RUN_STREAM_RESET_REASONS),
})
export const runStreamCompleteSchema = z.strictObject({
  kind: z.literal('complete'),
  runId: entityIdSchema,
  eventSeq: z.number().int().nonnegative(),
})
export const runStreamErrorSchema = z.strictObject({
  kind: z.literal('error'),
  runId: entityIdSchema,
  code: z.enum(RUN_STREAM_ERROR_CODES),
  message: z.string().min(1),
})
export const runStreamControlSchema = z.discriminatedUnion('kind', [
  runStreamReadySchema,
  runStreamResetSchema,
  runStreamCompleteSchema,
  runStreamErrorSchema,
])
export type RunStreamControl = z.infer<typeof runStreamControlSchema>
