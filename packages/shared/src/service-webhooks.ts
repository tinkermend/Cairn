import { z } from 'zod'
import { isBlockedAlertWebhookUrl } from './alerting.js'
import { externalRunBodySchema } from './service-access.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

/** Capability advertised by maintenance Workers that durably deliver service callbacks. */
export const SERVICE_WEBHOOK_DELIVERY_PROTOCOL = 'service-webhook-delivery@1' as const

export const SERVICE_WEBHOOK_EVENTS = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
] as const
export type ServiceWebhookEvent = (typeof SERVICE_WEBHOOK_EVENTS)[number]

export const SERVICE_WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'retrying',
  'success',
  'dead_letter',
] as const
export type ServiceWebhookDeliveryStatus =
  (typeof SERVICE_WEBHOOK_DELIVERY_STATUSES)[number]

export const DEFAULT_SERVICE_WEBHOOK_MAX_ATTEMPTS = 5
export const SERVICE_WEBHOOK_TIMEOUT_MS = 10_000
export const SERVICE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300
export const SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES = 2_048

/**
 * Delays following failed automatic submissions. A delivery has five total
 * automatic submissions, so failures one through four are followed by these
 * four delays. `attempts` is the number that has just completed.
 */
export function serviceWebhookRetryDelayMs(attempts: number): number {
  return [10_000, 30_000, 120_000, 600_000][Math.max(0, Math.min(3, attempts - 1))]!
}

const serviceWebhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .superRefine((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return
    }
    if (url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Webhook 地址必须使用 HTTPS' })
    }
    if (url.username || url.password || url.hash) {
      ctx.addIssue({
        code: 'custom',
        message: 'Webhook 地址不得包含认证信息或片段',
      })
    }
    if (isBlockedAlertWebhookUrl(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Webhook 地址不得指向回环、内网、链路本地或控制面',
      })
    }
  })

const webhookEventsSchema = z
  .array(z.enum(SERVICE_WEBHOOK_EVENTS))
  .min(1, '至少订阅一个事件')
  .max(SERVICE_WEBHOOK_EVENTS.length)
  .refine((items) => new Set(items).size === items.length, '事件不得重复')

/** Password-like material is write-only; every read DTO deliberately omits it. */
export const serviceWebhookWriteSchema = z.strictObject({
  url: serviceWebhookUrlSchema,
  events: webhookEventsSchema,
  enabled: z.boolean().default(true),
  secret: z.string().min(1, '请填写签名密钥').max(4096).optional(),
})
export type ServiceWebhookWrite = z.infer<typeof serviceWebhookWriteSchema>

export const serviceWebhookSchema = z.strictObject({
  id: entityIdSchema,
  callerId: entityIdSchema,
  url: serviceWebhookUrlSchema,
  host: z.string().min(1).max(253),
  events: webhookEventsSchema,
  status: z.enum(['active', 'disabled']),
  secretConfigured: z.boolean(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ServiceWebhookDto = z.infer<typeof serviceWebhookSchema>

export const serviceWebhookOutputSchema = z.strictObject({
  stepName: z.string().min(1).max(256),
  payload: jsonValueSchema,
})
export const serviceWebhookPayloadSchema = z.strictObject({
  id: entityIdSchema,
  event: z.enum(SERVICE_WEBHOOK_EVENTS),
  timestamp: utcInstantSchema,
  callerId: entityIdSchema,
  data: z.strictObject({
    runId: entityIdSchema,
    idempotencyKey: z.string().min(1).max(128).nullable(),
    status: z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
    scenarioId: entityIdSchema,
    scenarioVersionId: entityIdSchema,
    targetId: entityIdSchema,
    targetAccountId: entityIdSchema.nullable(),
    startedAt: utcInstantSchema.nullable(),
    finishedAt: utcInstantSchema.nullable(),
    durationSeconds: z.number().int().nonnegative().nullable(),
    outputs: z.array(serviceWebhookOutputSchema).max(100),
    evidenceSummary: z.strictObject({
      status: z.string().min(1).max(32),
      availableCount: z.number().int().nonnegative(),
    }),
  }),
})
export type ServiceWebhookPayload = z.infer<typeof serviceWebhookPayloadSchema>

export const serviceWebhookDeliverySchema = z.strictObject({
  id: entityIdSchema,
  webhookId: entityIdSchema,
  callerId: entityIdSchema,
  runId: entityIdSchema,
  eventType: z.enum(SERVICE_WEBHOOK_EVENTS),
  payload: serviceWebhookPayloadSchema,
  status: z.enum(SERVICE_WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  replayCount: z.number().int().nonnegative(),
  nextRetryAt: utcInstantSchema.nullable(),
  lastResponseCode: z.number().int().min(100).max(599).nullable(),
  lastResponseBody: z.string().max(SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES).nullable(),
  lastError: z.string().max(256).nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ServiceWebhookDeliveryDto = z.infer<
  typeof serviceWebhookDeliverySchema
>

export const serviceWebhookDeliveryQuerySchema = z.strictObject({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(SERVICE_WEBHOOK_DELIVERY_STATUSES).optional(),
})
export type ServiceWebhookDeliveryQuery = z.infer<
  typeof serviceWebhookDeliveryQuerySchema
>
export const serviceWebhookDeliveryListSchema = z.strictObject({
  items: z.array(serviceWebhookDeliverySchema),
  nextCursor: z.string().uuid().optional(),
})

/** A console principal chooses a credential, but the actual admission remains service-scoped. */
export const servicePlaygroundRunBodySchema = externalRunBodySchema.extend({
  credentialId: entityIdSchema,
})
export type ServicePlaygroundRunBody = z.infer<
  typeof servicePlaygroundRunBodySchema
>
