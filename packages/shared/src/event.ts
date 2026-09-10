import { z } from 'zod'
import { requestIdValueSchema } from './error.js'
import { entityIdSchema, jsonValueSchema, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

/**
 * 运行事件信封。SSE / NOTIFY 只传这个，PostgreSQL 仍是事实源。
 *
 * `type` 本轮闭合。乱写 `run.updated` 会失败，避免每个模块自己发明一套动词。
 * 需要新事件时改枚举并补测试，等于留下一次显式决定。
 */

export const RUN_EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'step_run.started',
  'step_run.finished',
  'attempt.started',
  'attempt.finished',
  'evidence.recorded',
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
