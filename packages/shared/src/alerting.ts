import { z } from 'zod'
import {
  MONITOR_METRIC_CATALOG,
  MONITOR_SAMPLE_SCOPES,
  monitorMetricKeySchema,
  type MonitorMetricKey,
  type MonitorSampleScope,
} from './monitoring.js'
import { nextCursorSchema } from './rbac.js'
import { LOCAL_SECRET_PROVIDER, secretRefSchema } from './secret-ref.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const ALERT_SEVERITIES = ['warning', 'critical'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const ALERT_COMPARATORS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const
export type AlertComparator = (typeof ALERT_COMPARATORS)[number]

export const ALERT_STATES = ['pending', 'firing', 'interrupted', 'resolved'] as const
export type AlertState = (typeof ALERT_STATES)[number]

export const ALERT_VISIBLE_STATES = ['firing', 'interrupted', 'resolved'] as const
export type AlertVisibleState = (typeof ALERT_VISIBLE_STATES)[number]

export const ALERT_NOTICE_KINDS = ['firing', 'resolved', 'interrupted'] as const
export type AlertNoticeKind = (typeof ALERT_NOTICE_KINDS)[number]

export const ALERT_DELIVERY_STATES = ['pending', 'sending', 'sent', 'failed', 'suppressed'] as const
export type AlertDeliveryState = (typeof ALERT_DELIVERY_STATES)[number]

export const ALERT_PUBLIC_DELIVERY_STATES = ['pending', 'sent', 'failed', 'suppressed'] as const
export type AlertPublicDeliveryState = (typeof ALERT_PUBLIC_DELIVERY_STATES)[number]

export const ALERT_RULE_KINDS = ['threshold', 'source_stale'] as const
export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number]

export const ALERT_STALE_SOURCES = ['object_store_probe', 'worker_registry', 'api_registry'] as const
export type AlertStaleSource = (typeof ALERT_STALE_SOURCES)[number]

export const ALERT_CHANNEL_KINDS = ['webhook'] as const
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number]

export const ALERT_CONSOLE_PATH = '/monitoring' as const
export const DEFAULT_ALERT_DELIVERY_MAX_ATTEMPTS = 5
export const DEFAULT_ALERT_DELIVERY_TIMEOUT_MS = 10_000
export const ALERT_DELIVERY_CLAIM_STALE_MS = 120_000
export const MONITOR_SILENCE_RATE_LIMIT_MS = 10_000
export const MIN_ALERT_SILENCE_SECONDS = 300
export const MAX_ALERT_SILENCE_SECONDS = 86_400
export const ALERT_WEBHOOK_SECRET_VERSION = 1 as const

const UrlCtor = (
  globalThis as unknown as {
    URL: new (input: string) => {
      username: string
      password: string
      protocol: string
      hostname: string
    }
  }
).URL

export const alertRuleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9._-]*$/, '规则 id 只允许小写字母、数字、点、下划线和连字符')

export const alertConfigReasonSchema = z.string().trim().min(1, '请填写变更原因').max(512)

export function isAlertableMetricKey(key: string): key is MonitorMetricKey {
  if (!(key in MONITOR_METRIC_CATALOG)) return false
  const layer = MONITOR_METRIC_CATALOG[key as MonitorMetricKey].layer
  return layer === 'L2' || layer === 'L3'
}

export const ALERTABLE_METRIC_KEYS = (Object.keys(MONITOR_METRIC_CATALOG) as MonitorMetricKey[]).filter(
  isAlertableMetricKey,
)

export function requiredAlertMetricScope(key: MonitorMetricKey): MonitorSampleScope {
  if (
    key.startsWith('api.process.') ||
    key === 'api.sse.connections' ||
    key === 'api.internalForward.inFlight'
  ) {
    return 'api'
  }
  if (
    key.startsWith('worker.process.') ||
    key === 'worker.clockSkewMs' ||
    key === 'worker.browserProcessCount' ||
    key === 'worker.profileCount' ||
    key === 'worker.profileDiskFreeBytes' ||
    key === 'worker.midsceneBytes' ||
    key === 'profile.nodeDiskUsageBytes' ||
    key === 'queue.lastClaimScanCount'
  ) {
    return 'worker'
  }
  return 'platform'
}

export function requiredStaleSourceScope(source: AlertStaleSource): readonly MonitorSampleScope[] {
  if (source === 'object_store_probe') return ['platform']
  if (source === 'worker_registry') return ['platform', 'worker']
  return ['platform', 'api']
}

export function compareAlertThreshold(
  value: number,
  comparator: AlertComparator,
  threshold: number,
): boolean {
  switch (comparator) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    case 'eq':
      return value === threshold
  }
}

export function alertOpenKey(ruleId: string, scope: MonitorSampleScope, scopeId: string): string {
  return `${ruleId}/${scope}/${scopeId}`
}

export function alertRetryDelayMs(attempts: number): number {
  return Math.min(600_000, 30_000 * 2 ** Math.max(0, attempts - 1))
}

export function publicAlertDeliveryStatus(
  status: AlertDeliveryState | null | undefined,
): AlertPublicDeliveryState | null {
  if (!status) return null
  return status === 'sending' ? 'pending' : status
}

export const alertWebhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Webhook 地址须以 http:// 或 https:// 开头',
  })
  .refine((value) => {
    try {
      const parsed = new UrlCtor(value)
      return parsed.username === '' && parsed.password === ''
    } catch {
      return false
    }
  }, 'Webhook 地址不得内嵌凭据')

export const alertWebhookPublicUrlSchema = alertWebhookUrlSchema.refine(
  (value) => !isBlockedAlertWebhookUrl(value),
  { message: 'Webhook 地址不得指向回环、内网、链路本地或控制面' },
)

export function alertWebhookHost(url: string): string {
  return new UrlCtor(url).hostname
}

const BLOCKED_WEBHOOK_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'host.docker.internal',
  'host.containers.internal',
])

const BLOCKED_WEBHOOK_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.invalid']

function normalizeWebhookHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN
    return Number(part)
  })
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets as [number, number, number, number]
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a >= 224
}

function isBlockedIpv6(host: string): boolean {
  const value = host.toLowerCase()
  if (value === '::' || value === '::1' || value === '0:0:0:0:0:0:0:0' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('fe80:') || value.startsWith('fec0:') || value.startsWith('fc') || value.startsWith('fd')) {
    return true
  }
  if (value.startsWith('ff')) return true
  const mapped = value.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) {
    const octets = parseIpv4(mapped[1]!)
    return octets ? isBlockedIpv4(octets) : true
  }
  return false
}

export function isBlockedAlertWebhookHost(hostname: string, extras: readonly string[] = []): boolean {
  const host = normalizeWebhookHost(hostname)
  if (!host) return true
  if (BLOCKED_WEBHOOK_HOSTS.has(host)) return true
  if (extras.some((extra) => normalizeWebhookHost(extra) === host)) return true
  if (BLOCKED_WEBHOOK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  const ipv4 = parseIpv4(host)
  if (ipv4) return isBlockedIpv4(ipv4)
  if (host.includes(':')) return isBlockedIpv6(host)
  return false
}

export function isBlockedAlertWebhookUrl(url: string, extras: readonly string[] = []): boolean {
  try {
    return isBlockedAlertWebhookHost(new UrlCtor(url).hostname, extras)
  } catch {
    return true
  }
}

export const alertWebhookSecretPayloadSchema = z.strictObject({
  v: z.literal(ALERT_WEBHOOK_SECRET_VERSION),
  url: alertWebhookUrlSchema,
  token: z.string().min(1).max(1024).optional(),
})
export type AlertWebhookSecretPayload = z.infer<typeof alertWebhookSecretPayloadSchema>

const alertRuleBase = {
  id: alertRuleIdSchema,
  name: z.string().trim().min(1).max(80),
  forSeconds: z.number().int().min(0).max(86_400),
  severity: z.enum(ALERT_SEVERITIES),
  channelIds: z.array(entityIdSchema).max(8),
  enabled: z.boolean(),
}

export const alertThresholdRuleSchema = z
  .strictObject({
    kind: z.literal('threshold'),
    ...alertRuleBase,
    metricKey: monitorMetricKeySchema,
    scope: z.enum(MONITOR_SAMPLE_SCOPES),
    comparator: z.enum(ALERT_COMPARATORS),
    threshold: z.number().finite(),
  })
  .superRefine((rule, ctx) => {
    if (!isAlertableMetricKey(rule.metricKey)) {
      ctx.addIssue({
        code: 'custom',
        path: ['metricKey'],
        message: '只能对 L2/L3 指标配阈值告警',
      })
      return
    }
    if (requiredAlertMetricScope(rule.metricKey) !== rule.scope) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: `指标 ${rule.metricKey} 只能按 ${requiredAlertMetricScope(rule.metricKey)} 评估`,
      })
    }
  })
export type AlertThresholdRule = z.infer<typeof alertThresholdRuleSchema>

export const alertSourceStaleRuleSchema = z
  .strictObject({
    kind: z.literal('source_stale'),
    ...alertRuleBase,
    source: z.enum(ALERT_STALE_SOURCES),
    scope: z.enum(MONITOR_SAMPLE_SCOPES),
  })
  .superRefine((rule, ctx) => {
    if (!requiredStaleSourceScope(rule.source).includes(rule.scope)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: `来源 ${rule.source} 不能按 ${rule.scope} 评估`,
      })
    }
  })
export type AlertSourceStaleRule = z.infer<typeof alertSourceStaleRuleSchema>

export const alertRuleSchema = z.discriminatedUnion('kind', [
  alertThresholdRuleSchema,
  alertSourceStaleRuleSchema,
])
export type AlertRule = z.infer<typeof alertRuleSchema>

export const alertChannelSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string().trim().min(1).max(80),
  kind: z.literal('webhook'),
  enabled: z.boolean(),
  secretRef: secretRefSchema,
  urlHost: z.string().trim().min(1).max(253),
})
export type AlertChannel = z.infer<typeof alertChannelSchema>

export const credentialMaintenanceAlertingSchema = z.strictObject({
  enabled: z.boolean(),
  channelIds: z.array(entityIdSchema).max(8),
})
export type CredentialMaintenanceAlerting = z.infer<typeof credentialMaintenanceAlertingSchema>

export const platformAlertingSchema = z
  .strictObject({
    rules: z.array(alertRuleSchema).max(64),
    channels: z.array(alertChannelSchema).max(16),
    credentialMaintenance: credentialMaintenanceAlertingSchema.default({
      enabled: false,
      channelIds: [],
    }),
  })
  .superRefine((alerting, ctx) => {
    const ruleIds = new Set<string>()
    for (const [index, rule] of alerting.rules.entries()) {
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: '规则 id 不能重复' })
      }
      ruleIds.add(rule.id)
      const unknown = rule.channelIds.filter((id) => !alerting.channels.some((channel) => channel.id === id))
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'channelIds'],
          message: '渠道不存在',
        })
      }
    }
    const channelIds = new Set<string>()
    for (const [index, channel] of alerting.channels.entries()) {
      if (channelIds.has(channel.id)) {
        ctx.addIssue({ code: 'custom', path: ['channels', index, 'id'], message: '渠道 id 不能重复' })
      }
      channelIds.add(channel.id)
    }
    const unknownMaintenance = alerting.credentialMaintenance.channelIds.filter(
      (id) => !alerting.channels.some((channel) => channel.id === id),
    )
    if (unknownMaintenance.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialMaintenance', 'channelIds'],
        message: '渠道不存在',
      })
    }
  })
export type PlatformAlerting = z.infer<typeof platformAlertingSchema>

export const FACTORY_ALERT_RULES: AlertRule[] = alertRuleSchema.array().parse([
  {
    kind: 'threshold',
    id: 'factory.worker.lost',
    name: '执行节点失联',
    metricKey: 'worker.status.lost',
    scope: 'platform',
    comparator: 'gte',
    threshold: 1,
    forSeconds: 60,
    severity: 'critical',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.worker.ready_zero',
    name: '没有就绪执行节点',
    metricKey: 'worker.status.ready',
    scope: 'platform',
    comparator: 'lte',
    threshold: 0,
    forSeconds: 60,
    severity: 'critical',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.worker.heartbeat_stale',
    name: '执行节点心跳过期',
    metricKey: 'worker.heartbeat.stale',
    scope: 'platform',
    comparator: 'gte',
    threshold: 1,
    forSeconds: 60,
    severity: 'warning',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.queue.oldest_wait',
    name: '待领取运行等待过久',
    metricKey: 'queue.oldestWaitMs',
    scope: 'platform',
    comparator: 'gte',
    threshold: 300_000,
    forSeconds: 120,
    severity: 'warning',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.evidence.pending_upload',
    name: '证据上传债务偏高',
    metricKey: 'evidence.pendingUpload',
    scope: 'platform',
    comparator: 'gte',
    threshold: 10,
    forSeconds: 180,
    severity: 'warning',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.object_store.down',
    name: '对象存储探测失败',
    metricKey: 'objectStore.up',
    scope: 'platform',
    comparator: 'lte',
    threshold: 0,
    forSeconds: 60,
    severity: 'critical',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'source_stale',
    id: 'factory.object_store.probe_stale',
    name: '对象存储探测中断',
    source: 'object_store_probe',
    scope: 'platform',
    forSeconds: 120,
    severity: 'warning',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.worker.clock_skew',
    name: '执行节点时钟偏移过大',
    metricKey: 'worker.clockSkewMs',
    scope: 'worker',
    comparator: 'gte',
    threshold: 5_000,
    forSeconds: 120,
    severity: 'warning',
    channelIds: [],
    enabled: false,
  },
  {
    kind: 'threshold',
    id: 'factory.worker.profile_disk',
    name: 'Profile 磁盘可用空间不足',
    metricKey: 'worker.profileDiskFreeBytes',
    scope: 'worker',
    comparator: 'lte',
    threshold: 5 * 1024 * 1024 * 1024,
    forSeconds: 180,
    severity: 'warning',
    channelIds: [],
    enabled: false,
  },
])

export const FACTORY_ALERTING: PlatformAlerting = platformAlertingSchema.parse({
  rules: FACTORY_ALERT_RULES,
  channels: [],
})

export const alertNoticeSchema = z.strictObject({
  kind: z.enum(ALERT_NOTICE_KINDS),
  alertId: entityIdSchema,
  ruleId: alertRuleIdSchema,
  ruleName: z.string().min(1).max(80),
  metricKey: z.string().min(1).nullable(),
  source: z.enum(ALERT_STALE_SOURCES).nullable(),
  scope: z.enum(MONITOR_SAMPLE_SCOPES),
  scopeId: z.string().min(1).max(256),
  value: z.number().finite().nullable(),
  threshold: z.number().finite().nullable(),
  comparator: z.enum(ALERT_COMPARATORS).nullable(),
  severity: z.enum(ALERT_SEVERITIES),
  at: utcInstantSchema,
  consolePath: z.literal(ALERT_CONSOLE_PATH),
})
export type AlertNotice = z.infer<typeof alertNoticeSchema>

export const monitorAlertItemSchema = z.object({
  id: entityIdSchema,
  ruleId: alertRuleIdSchema,
  ruleName: z.string().min(1).max(80),
  kind: z.enum(ALERT_RULE_KINDS),
  metricKey: monitorMetricKeySchema.nullable(),
  staleSource: z.enum(ALERT_STALE_SOURCES).nullable(),
  scope: z.enum(MONITOR_SAMPLE_SCOPES),
  scopeId: z.string().min(1).max(256),
  state: z.enum(ALERT_VISIBLE_STATES),
  severity: z.enum(ALERT_SEVERITIES),
  comparator: z.enum(ALERT_COMPARATORS).nullable(),
  threshold: z.number().finite().nullable(),
  triggerValue: z.number().finite().nullable(),
  conditionOpenedAt: utcInstantSchema,
  firedAt: utcInstantSchema.nullable(),
  interruptedAt: utcInstantSchema.nullable(),
  resolvedAt: utcInstantSchema.nullable(),
  silencedUntil: utcInstantSchema.nullable(),
  silenceRemainingSeconds: z.number().int().nonnegative().nullable(),
  noticeKind: z.enum(ALERT_NOTICE_KINDS).nullable(),
  deliveryStatus: z.enum(ALERT_PUBLIC_DELIVERY_STATES).nullable(),
  lastDeliveryError: z.string().max(64).nullable(),
})
export type MonitorAlertItem = z.infer<typeof monitorAlertItemSchema>

export const monitorAlertListQuerySchema = z.object({
  view: z.enum(['active', 'history']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: nextCursorSchema,
})
export type MonitorAlertListQuery = z.infer<typeof monitorAlertListQuerySchema>
export type MonitorAlertListQueryInput = z.input<typeof monitorAlertListQuerySchema>

export const monitorAlertListResponseSchema = z.object({
  asOf: utcInstantSchema,
  items: z.array(monitorAlertItemSchema),
  nextCursor: nextCursorSchema,
})
export type MonitorAlertListResponse = z.infer<typeof monitorAlertListResponseSchema>

export const monitorAlertRulesResponseSchema = z.object({
  revision: z.number().int().positive(),
  rules: z.array(alertRuleSchema),
  channels: z.array(alertChannelSchema),
})
export type MonitorAlertRulesResponse = z.infer<typeof monitorAlertRulesResponseSchema>

export const monitorAlertRulesUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  reason: alertConfigReasonSchema,
  rules: z.array(alertRuleSchema).max(64),
})
export type MonitorAlertRulesUpdateBody = z.infer<typeof monitorAlertRulesUpdateBodySchema>

export const monitorAlertChannelBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  reason: alertConfigReasonSchema,
  name: z.string().trim().min(1).max(80),
  url: alertWebhookPublicUrlSchema,
  token: z.string().min(1).max(1024).optional(),
  enabled: z.boolean().default(true),
  id: entityIdSchema.optional(),
})
export type MonitorAlertChannelBody = z.infer<typeof monitorAlertChannelBodySchema>

export const monitorAlertSilenceBodySchema = z.strictObject({
  durationSeconds: z.number().int().min(MIN_ALERT_SILENCE_SECONDS).max(MAX_ALERT_SILENCE_SECONDS),
})
export type MonitorAlertSilenceBody = z.infer<typeof monitorAlertSilenceBodySchema>

export function localAlertSecretRef(secretId: string) {
  return { provider: LOCAL_SECRET_PROVIDER, secretId }
}
