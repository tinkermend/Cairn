import { z } from 'zod'
import { secretRefSchema } from './secret-ref.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const NOTIFICATION_PROTOCOL = 'cairn.notification@1' as const
export const NOTIFICATION_WORKER_PROTOCOL = 'notification-delivery@1' as const
export const RUN_NOTIFICATION_PROTOCOL = 'run-notification@1' as const
export const notificationStatusSchema = z.enum([
  'pending',
  'sending',
  'retry_wait',
  'accepted',
  'failed',
  'unknown',
  'suppressed',
])
export type NotificationStatus = z.infer<typeof notificationStatusSchema>
const uniqueIds = z
  .array(entityIdSchema)
  .refine((a) => new Set(a).size === a.length, '不能重复选择')
const label = z.string().trim().min(1).max(80)
const reason = z.string().trim().min(1).max(512)
export const notificationChannelSchema = z.strictObject({
  id: entityIdSchema,
  name: label,
  kind: z.enum(['webhook', 'email']),
  enabled: z.boolean(),
  allowAlerts: z.boolean(),
  targetIds: uniqueIds.max(100),
  version: z.number().int().positive(),
  secretRef: secretRefSchema,
  host: z.string().max(253),
  recipients: z.array(z.strictObject({ id: entityIdSchema, masked: z.string().max(320) })).max(20),
  format: z.enum(['legacy_alert@1', NOTIFICATION_PROTOCOL]),
  replay: z.enum(['manual_on_unknown', 'receiver_deduplicates']),
})
export type NotificationChannel = z.infer<typeof notificationChannelSchema>
export const notificationSmtpSchema = z.strictObject({
  enabled: z.boolean(),
  version: z.number().int().positive(),
  secretRef: secretRefSchema,
  host: z.string().min(1).max(253),
})
export type NotificationSmtp = z.infer<typeof notificationSmtpSchema>
export const platformNotificationsSchema = z
  .strictObject({
    enabled: z.boolean(),
    consoleBaseUrl: z.union([
      z.literal(''),
      z
        .url()
        .max(2048)
        .refine((v) => {
          const u = new URL(v)
          return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
        }, '控制台地址须为不含认证信息的 HTTPS 地址'),
    ]),
    smtp: notificationSmtpSchema.nullable(),
    channels: z.array(notificationChannelSchema).max(16),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.channels.map((c) => c.id)).size !== v.channels.length)
      ctx.addIssue({ code: 'custom', path: ['channels'], message: '渠道 ID 重复' })
  })
export type PlatformNotifications = z.infer<typeof platformNotificationsSchema>
export const FACTORY_NOTIFICATIONS: PlatformNotifications = {
  enabled: false,
  consoleBaseUrl: '',
  smtp: null,
  channels: [],
}

export const notificationPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    sourceKinds: z
      .array(z.enum(['console', 'service']))
      .min(1)
      .max(2),
    mode: z.enum(['all_finished', 'exceptions']),
    includeCancelled: z.boolean(),
    channelIds: uniqueIds.max(8),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.channelIds.length)
      ctx.addIssue({ code: 'custom', path: ['channelIds'], message: '请选择通知渠道' })
  })
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  enabled: false,
  sourceKinds: ['console'],
  mode: 'exceptions',
  includeCancelled: false,
  channelIds: [],
}
export const frozenNotificationBindingSchema = z.strictObject({
  channel: notificationChannelSchema,
  // Keep old captured metadata parseable, but new Run snapshots carry only the immutable reference.
  smtp: notificationSmtpSchema
    .omit({ host: true })
    .extend({ host: z.string().optional() })
    .nullable(),
  controls: z.record(z.string().max(180), z.number().int().nonnegative()),
})
export type FrozenNotificationBinding = z.infer<typeof frozenNotificationBindingSchema>
export const frozenNotificationPolicySchema = z.strictObject({
  protocol: z.literal(RUN_NOTIFICATION_PROTOCOL),
  enabled: z.boolean(),
  reason: z.string().max(64),
  policyRevision: z.number().int().nonnegative(),
  policy: notificationPolicySchema,
  configRevision: z.number().int().nonnegative(),
  source: z.enum(['console', 'service']),
  scenarioName: z.string().max(128),
  targetName: z.string().max(128),
  consoleBaseUrl: z.string().max(2048),
  bindings: z.array(frozenNotificationBindingSchema).max(8),
  templateVersion: z.literal(1),
})
export type FrozenNotificationPolicy = z.infer<typeof frozenNotificationPolicySchema>

export const notificationPayloadSchema = z.strictObject({
  title: z.string().max(256),
  summaryStage: z.enum(['settled', 'evidence_pending']).optional(),
  scenarioName: z.string().max(128).optional(),
  targetName: z.string().max(128).optional(),
  scenarioVersionId: entityIdSchema.optional(),
  source: z.enum(['console', 'service']).optional(),
  status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']).optional(),
  outcomeStatus: z.enum(['PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NOT_EVALUATED']).optional(),
  evidenceStatus: z.enum(['PENDING', 'COMPLETE', 'INCOMPLETE']).optional(),
  startedAt: utcInstantSchema.nullable().optional(),
  finishedAt: utcInstantSchema.optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
  reasons: z.array(z.string().max(64)).max(8).optional(),
  // Exact whitelist of the previous alert webhook payload, never raw exceptions.
  alert: z
    .strictObject({
      kind: z.enum(['firing', 'resolved', 'interrupted']),
      alertId: entityIdSchema,
      ruleId: z.string().max(64),
      ruleName: z.string().max(128),
      scope: z.enum(['platform', 'worker', 'api']),
      scopeId: z.string().max(256),
      severity: z.enum(['warning', 'critical']),
      metricKey: z.string().max(128).nullable(),
      source: z.string().max(64).nullable(),
      value: z.number().nullable(),
      threshold: z.number().nullable(),
      comparator: z.string().max(16).nullable(),
      occurredAt: utcInstantSchema,
      consolePath: z.literal('/monitoring'),
    })
    .optional(),
})
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>
export function notificationReasons(
  policy: NotificationPolicy,
  value: {
    status: string
    outcomeStatus: string
    evidenceStatus: string
  },
): string[] {
  if (policy.mode === 'all_finished') return ['all_finished']
  if (value.status === 'CANCELLED') return policy.includeCancelled ? ['cancelled'] : []
  return [
    ...(value.status === 'FAILED' ? ['execution_failed'] : []),
    ...(['WARN', 'FAIL', 'UNKNOWN'].includes(value.outcomeStatus)
      ? [`outcome_${value.outcomeStatus.toLowerCase()}`]
      : []),
    ...(value.evidenceStatus !== 'COMPLETE'
      ? [`evidence_${value.evidenceStatus.toLowerCase()}`]
      : []),
  ]
}

const writeBase = { expectedRevision: z.number().int().positive(), reason }
export const notificationChannelWriteSchema = z.strictObject({
  ...writeBase,
  id: entityIdSchema.optional(),
  name: label,
  kind: z.enum(['webhook', 'email']),
  enabled: z.boolean(),
  allowAlerts: z.boolean(),
  targetIds: uniqueIds.max(100),
  format: z.enum(['legacy_alert@1', NOTIFICATION_PROTOCOL]),
  replay: z.enum(['manual_on_unknown', 'receiver_deduplicates']),
  url: z.url().max(2048).optional(),
  token: z
    .string()
    .max(4096)
    .regex(/^[^\r\n]*$/)
    .optional(),
  signingKey: z.string().max(4096).optional(),
  emails: z.array(z.email().max(320)).min(1).max(20).optional(),
})
export type NotificationChannelWrite = z.infer<typeof notificationChannelWriteSchema>
export const notificationSmtpWriteSchema = z.strictObject({
  ...writeBase,
  enabled: z.boolean(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['tls', 'starttls']),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4096).optional(),
  from: z.email().max(320),
})
export type NotificationSmtpWrite = z.infer<typeof notificationSmtpWriteSchema>
export const notificationSmtpSecretSchema = notificationSmtpWriteSchema
  .omit({ expectedRevision: true, reason: true, enabled: true })
  .extend({ password: z.string().min(1).max(4096) })
export const notificationChannelSecretSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('webhook'),
    url: z.url(),
    token: z.string().optional(),
    signingKey: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('email'),
    recipients: z
      .array(z.strictObject({ id: entityIdSchema, email: z.email() }))
      .min(1)
      .max(20),
  }),
])
export const notificationSettingsWriteSchema = z.strictObject({
  ...writeBase,
  enabled: z.boolean(),
  consoleBaseUrl: platformNotificationsSchema.shape.consoleBaseUrl,
})
export const notificationPolicyWriteSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  policy: notificationPolicySchema,
  cancelPrevious: z.boolean().default(false),
  reason,
})
export const notificationActionSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9._:-]{8,128}$/),
  reason,
  confirmUnknown: z.boolean().default(false),
})
export const notificationChannelStateSchema = z
  .strictObject({
    ...writeBase,
    enabled: z.boolean().optional(),
    revokeVersion: z.number().int().positive().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.revokeVersion !== undefined, '请选择操作')
export const notificationListQuerySchema = z.object({
  type: z.enum(['run', 'alert', 'test']).optional(),
  status: notificationStatusSchema.optional(),
  targetId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  runId: entityIdSchema.optional(),
  alertId: entityIdSchema.optional(),
  from: utcInstantSchema.optional(),
  to: utcInstantSchema.optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export const notificationAttemptSchema = z.object({
  id: entityIdSchema,
  attemptNo: z.number(),
  origin: z.enum(['auto', 'manual']),
  startedAt: utcInstantSchema,
  submittedAt: utcInstantSchema.nullable(),
  finishedAt: utcInstantSchema.nullable(),
  result: notificationStatusSchema.nullable(),
  errorCode: z.string().nullable(),
  responseCode: z.number().nullable(),
})
export const notificationDeliverySchema = z.object({
  id: entityIdSchema,
  channelId: entityIdSchema,
  channelName: z.string(),
  kind: z.enum(['email', 'webhook']),
  recipientLabel: z.string(),
  status: notificationStatusSchema,
  reason: z.string().nullable(),
  automaticAttemptCount: z.number(),
  nextAttemptAt: utcInstantSchema.nullable(),
  closedAt: utcInstantSchema.nullable(),
  attempts: z.array(notificationAttemptSchema).optional(),
})
export const notificationEventSchema = z.object({
  id: entityIdSchema,
  type: z.string(),
  runId: entityIdSchema.nullable(),
  targetId: entityIdSchema.nullable(),
  scenarioId: entityIdSchema.nullable(),
  alertId: entityIdSchema.nullable(),
  state: z.enum(['waiting_result', 'ready', 'filtered', 'suppressed']),
  reason: z.string().nullable(),
  occurredAt: utcInstantSchema,
  observedAt: utcInstantSchema.nullable(),
  payload: notificationPayloadSchema.nullable(),
  consoleUrl: z.string().nullable(),
  deliveries: z.array(notificationDeliverySchema),
})
export const notificationEventListSchema = z.object({
  items: z.array(notificationEventSchema),
  nextCursor: z.string().nullable(),
})
export type NotificationEventDto = z.infer<typeof notificationEventSchema>
export const notificationPolicyResponseSchema = z.object({
  revision: z.number(),
  policy: notificationPolicySchema,
})
export const notificationChannelSummarySchema = notificationChannelSchema
  .omit({ secretRef: true, recipients: true })
  .extend({ recipientCount: z.number(), revoked: z.boolean() })
export const notificationChannelsResponseSchema = z.object({
  revision: z.number(),
  enabled: z.boolean(),
  consoleBaseUrl: z.string(),
  smtp: notificationSmtpSchema
    .omit({ secretRef: true })
    .extend({ revoked: z.boolean() })
    .nullable(),
  channels: z.array(notificationChannelSummarySchema),
})
