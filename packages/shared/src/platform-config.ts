import { z } from 'zod'
import {
  DEFAULT_DEBUG_TRACE_RETAIN_DAYS,
  DEFAULT_EVIDENCE_POLICY,
  DEFAULT_SCREENSHOT_RETAIN_DAYS,
  DEFAULT_TRACE_RETAIN_DAYS,
  DEFAULT_VIDEO_RETAIN_DAYS,
  evidenceCaptureModeSchema,
  resolveEvidencePolicy,
  videoCaptureModeSchema,
  type EvidencePolicy,
  type ResolvedEvidencePolicy,
} from './evidence-policy.js'
import { nextCursorSchema } from './rbac.js'
import { DEFAULT_RETRY_LIMIT, DEFAULT_STEP_TIMEOUT_MS, resolveStepPolicy } from './policy.js'
import { LOCAL_SECRET_PROVIDER, secretRefSchema } from './secret-ref.js'
import {
  DEFAULT_SESSION_AUTH_PROBE_INTERVAL_SECONDS,
  DEFAULT_SESSION_AUTH_WAIT_SECONDS,
  DEFAULT_SESSION_EVICTION_PRIORITY,
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_KEEP_ALIVE_SECONDS,
  DEFAULT_SESSION_LEASE_TTL_SECONDS,
  DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  DEFAULT_SESSION_RECLAIM_MODE,
  DEFAULT_SESSION_REUSE_POLICY,
  DEFAULT_SESSION_LOST_DISPOSITION,
  resolveSessionPolicyLayers,
  sessionPolicySchema,
  sessionReclaimModeSchema,
  sessionLostDispositionSchema,
  type SessionPolicy,
  type SessionPolicyOverride,
  type TargetSessionPolicyOverride,
} from './session.js'
import {
  FACTORY_SESSION_SCHEDULING,
  platformSessionSchedulingSchema,
} from './session-occupancy.js'
import {
  FACTORY_MAP_CAPTURE_POLICY,
  mapCapturePolicySchema,
  type MapCapturePolicy,
  type MapCapturePolicyOverride,
} from './map-capture.js'
import { FACTORY_SESSION_AUTH, platformSessionAuthSchema, targetCaptchaDefinitionSchema } from './session-auth.js'
import { FACTORY_SESSION_RETENTION, platformSessionRetentionSchema } from './session-maintenance.js'
import { FACTORY_RUN_AUTH_RECOVERY, platformRunAuthRecoverySchema } from './session-auth-recovery.js'
import { isAiStepType, type ExecutionPolicy } from './step.js'
import { AUTH_METHODS, CAPTCHA_MODES, targetLoginFieldsDtoSchema } from './target.js'
import { entityIdSchema, timeoutMsSchema, utcInstantSchema } from './wire.js'
import {
  FACTORY_RUNTIME_INVARIANT_DEFAULTS,
  platformRuntimeInvariantDefaultsSchema,
} from './runtime-invariant.js'
import { FACTORY_ALERTING, alertRuleSchema, credentialMaintenanceAlertingSchema } from './alerting.js'
import { FACTORY_NOTIFICATIONS, platformNotificationsSchema } from './notifications.js'

export const PLATFORM_CONFIG_SCHEMA_VERSION = 2 as const
/** 仍能被本版本读取的最早文档版本。低于它的存量文档必须先跑数据迁移。 */
export const PLATFORM_CONFIG_MIN_SCHEMA_VERSION = 1 as const
export const PLATFORM_CONFIG_SCHEMA_UNSUPPORTED = 'PLATFORM_CONFIG_SCHEMA_UNSUPPORTED' as const
export const PLATFORM_CONFIG_SINGLETON_ID = '00000000-0000-4000-8000-c01f16000001'
export const PLATFORM_CONFIG_SOURCES = ['bootstrap', 'update', 'restore'] as const
export type PlatformConfigSource = (typeof PLATFORM_CONFIG_SOURCES)[number]

export const PLATFORM_SESSION_REUSE_POLICIES = ['NEW_PAGE', 'REUSE_PAGE'] as const
export type PlatformSessionReusePolicy = (typeof PLATFORM_SESSION_REUSE_POLICIES)[number]

const UrlCtor = (
  globalThis as unknown as {
    URL: new (input: string) => {
      username: string
      password: string
      protocol: string
      host: string
    }
  }
).URL

export const platformModelUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: '模型地址须以 http:// 或 https:// 开头',
  })
  .refine((value) => {
    try {
      const parsed = new UrlCtor(value)
      return parsed.username === '' && parsed.password === ''
    } catch {
      return false
    }
  }, '模型地址不得内嵌凭据')

export const platformExecutionDefaultsSchema = z.strictObject({
  defaultTimeoutMs: timeoutMsSchema,
  defaultRetryLimit: z.literal(DEFAULT_RETRY_LIMIT),
})
export type PlatformExecutionDefaults = z.infer<typeof platformExecutionDefaultsSchema>

export const platformSessionDefaultsSchema = z
  .strictObject({
    reuse: z.enum(PLATFORM_SESSION_REUSE_POLICIES),
    idleTtlSeconds: z.number().int().min(60).max(604_800),
    maxLifetimeSeconds: z.number().int().min(120).max(2_592_000),
    authWaitSeconds: z.number().int().min(30).max(3_600),
    reclaim: sessionReclaimModeSchema.default(DEFAULT_SESSION_RECLAIM_MODE),
    keepAliveSeconds: z
      .number()
      .int()
      .min(60)
      .max(2_592_000)
      .default(DEFAULT_SESSION_KEEP_ALIVE_SECONDS),
    authProbeIntervalSeconds: z
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(DEFAULT_SESSION_AUTH_PROBE_INTERVAL_SECONDS),
    evictionPriority: z.number().int().min(-1000).max(1000).default(DEFAULT_SESSION_EVICTION_PRIORITY),
    lostDisposition: sessionLostDispositionSchema.default(DEFAULT_SESSION_LOST_DISPOSITION),
  })
  .superRefine((session, ctx) => {
    if (session.maxLifetimeSeconds <= session.idleTtlSeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLifetimeSeconds'],
        message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
      })
    }
    if (session.reclaim === 'AUTH_DRIVEN') {
      if (session.keepAliveSeconds >= session.maxLifetimeSeconds) {
        ctx.addIssue({
          code: 'custom',
          path: ['keepAliveSeconds'],
          message: 'AUTH_DRIVEN 时 keepAliveSeconds 必须小于 maxLifetimeSeconds',
        })
      }
      if (session.authProbeIntervalSeconds >= session.keepAliveSeconds) {
        ctx.addIssue({
          code: 'custom',
          path: ['authProbeIntervalSeconds'],
          message: 'AUTH_DRIVEN 时 authProbeIntervalSeconds 必须小于 keepAliveSeconds',
        })
      }
    }
  })
export type PlatformSessionDefaults = z.infer<typeof platformSessionDefaultsSchema>

/**
 * 新产品出厂的录像默认。存量文档缺 video 时按它补齐，与 FACTORY_PLATFORM_CONFIG 同源；
 * 注意它不同于 DEFAULT_EVIDENCE_POLICY.video（那是历史 Run Snapshot 的解释）。
 */
export const FACTORY_EVIDENCE_VIDEO = {
  mode: 'always',
  retainDays: DEFAULT_VIDEO_RETAIN_DAYS,
} as const

export const platformEvidenceDefaultsSchema = z.strictObject({
  screenshot: evidenceCaptureModeSchema,
  video: videoCaptureModeSchema.default(FACTORY_EVIDENCE_VIDEO.mode),
  trace: evidenceCaptureModeSchema,
  retainDays: z.strictObject({
    screenshot: z.number().int().positive().max(3650),
    video: z.number().int().positive().max(3650).default(FACTORY_EVIDENCE_VIDEO.retainDays),
    trace: z.number().int().positive().max(3650),
    debugTrace: z.number().int().positive().max(3650),
  }),
})
export type PlatformEvidenceDefaults = z.infer<typeof platformEvidenceDefaultsSchema>

const platformBrowserAiShape = {
  enabled: z.boolean(),
  baseUrl: platformModelUrlSchema.optional(),
  model: z.string().trim().min(1).max(256).optional(),
  modelFamily: z.string().trim().min(1).max(64).optional(),
  secretRef: secretRefSchema.optional(),
  requestTimeoutMs: z.number().int().positive().max(300_000),
  stepMaxCalls: z.number().int().positive().max(200),
  maxOutputTokens: z.number().int().positive().max(32_768),
}

export const platformBrowserAiConfigSchema = z.strictObject(platformBrowserAiShape)
export type PlatformBrowserAiConfig = z.infer<typeof platformBrowserAiConfigSchema>

export const PLATFORM_AI_ROUTE_ID = 'platform-default' as const

export const FACTORY_PLATFORM_AI = {
  enabled: false,
  routeId: PLATFORM_AI_ROUTE_ID,
  requestTimeoutMs: 20_000,
  turnTimeoutMs: 60_000,
  maxCallsPerTurn: 3,
  maxOutputTokens: 2048,
  userInflightLimit: 1,
  platformInflightLimit: 4,
} as const

export const platformAiConfigSchema = z
  .strictObject({
    enabled: z.boolean(),
    routeId: z.literal(PLATFORM_AI_ROUTE_ID).default(PLATFORM_AI_ROUTE_ID),
    baseUrl: platformModelUrlSchema.optional(),
    model: z.string().trim().min(1).max(256).optional(),
    secretRef: secretRefSchema.optional(),
    requestTimeoutMs: z.number().int().positive().max(120_000),
    turnTimeoutMs: z.number().int().positive().max(180_000),
    maxCallsPerTurn: z.number().int().positive().max(8),
    maxOutputTokens: z.number().int().positive().max(8192),
    userInflightLimit: z.number().int().positive().max(8),
    platformInflightLimit: z.number().int().positive().max(32),
  })
  .superRefine((ai, ctx) => {
    if (ai.requestTimeoutMs > ai.turnTimeoutMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['requestTimeoutMs'],
        message: '单请求超时不能大于整轮超时',
      })
    }
    if (ai.userInflightLimit > ai.platformInflightLimit) {
      ctx.addIssue({
        code: 'custom',
        path: ['userInflightLimit'],
        message: '用户在途上限不能大于平台在途上限',
      })
    }
    if (!ai.enabled) return
    if (!ai.baseUrl) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: '启用平台通用 AI 时必须配置服务地址' })
    }
    if (!ai.model) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: '启用平台通用 AI 时必须配置模型名' })
    }
    if (!ai.secretRef) {
      ctx.addIssue({ code: 'custom', path: ['secretRef'], message: '启用平台通用 AI 时必须配置 Secret 引用' })
    }
  })
export type PlatformAiConfig = z.infer<typeof platformAiConfigSchema>

export const FACTORY_MODULE_RESOLVER = {
  maxCandidates: 10,
  aiCandidateLimit: 5,
  logRetentionDays: 90,
} as const

export const platformModuleResolverSchema = z.strictObject({
  maxCandidates: z.number().int().min(1).max(20),
  aiCandidateLimit: z.number().int().min(1).max(10),
  logRetentionDays: z.number().int().min(1).max(365),
})
export type PlatformModuleResolver = z.infer<typeof platformModuleResolverSchema>

export const FACTORY_MODULE_QUALITY = {
  windowDays: 7,
  minSamples: 10,
  degradedVerifiedRateBelow: 0.8,
  recentFailureStreak: 3,
} as const

export const platformModuleQualitySchema = z.strictObject({
  windowDays: z.union([z.literal(7), z.literal(30)]),
  minSamples: z.number().int().min(1).max(1000),
  degradedVerifiedRateBelow: z.number().min(0).max(1),
  recentFailureStreak: z.number().int().min(1).max(20),
})
export type PlatformModuleQuality = z.infer<typeof platformModuleQualitySchema>

export const FACTORY_MODULE_FALLBACK = {
  enabled: false,
} as const

export const platformModuleFallbackSchema = z.strictObject({
  enabled: z.boolean(),
})
export type PlatformModuleFallback = z.infer<typeof platformModuleFallbackSchema>

export const platformConfigDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(PLATFORM_CONFIG_SCHEMA_VERSION),
    execution: platformExecutionDefaultsSchema,
    session: platformSessionDefaultsSchema,
    evidence: platformEvidenceDefaultsSchema,
    browserAi: platformBrowserAiConfigSchema,
    platformAi: platformAiConfigSchema.default(FACTORY_PLATFORM_AI),
    sessionScheduling: platformSessionSchedulingSchema.default(FACTORY_SESSION_SCHEDULING),
    sessionAuth: platformSessionAuthSchema.default(FACTORY_SESSION_AUTH),
    sessionRetention: platformSessionRetentionSchema.default(FACTORY_SESSION_RETENTION),
    runAuthRecovery: platformRunAuthRecoverySchema.default(FACTORY_RUN_AUTH_RECOVERY),
    mapCapture: mapCapturePolicySchema.default(FACTORY_MAP_CAPTURE_POLICY),
    mapScheduledRefreshEnabled: z.boolean().default(false),
    mapExplorationEnabled: z.boolean().default(false),
    moduleResolver: platformModuleResolverSchema.default(FACTORY_MODULE_RESOLVER),
    moduleQuality: platformModuleQualitySchema.default(FACTORY_MODULE_QUALITY),
    moduleFallback: platformModuleFallbackSchema.default(FACTORY_MODULE_FALLBACK),
    runtimeInvariants: platformRuntimeInvariantDefaultsSchema.default(FACTORY_RUNTIME_INVARIANT_DEFAULTS),
    alerting: z.strictObject({
      rules: z.array(alertRuleSchema).max(64),
      credentialMaintenance: credentialMaintenanceAlertingSchema.default({ enabled: false, channelIds: [] }),
    }).default({ rules: FACTORY_ALERTING.rules, credentialMaintenance: FACTORY_ALERTING.credentialMaintenance }),
    notifications: platformNotificationsSchema.default(FACTORY_NOTIFICATIONS),
  })
  .superRefine((document, ctx) => {
    const ids = new Set(document.notifications.channels.map(c => c.id))
    for (const rule of document.alerting.rules) {
      if (rule.channelIds.some(id => !ids.has(id))) ctx.addIssue({ code: 'custom', path: ['alerting', 'rules'], message: '告警引用的通知渠道不存在' })
    }
    if (document.sessionAuth.verifyTimeoutMs >= document.execution.defaultTimeoutMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessionAuth', 'verifyTimeoutMs'],
        message: `须小于默认步骤超时 ${document.execution.defaultTimeoutMs}ms`,
      })
    }
    const ai = document.browserAi
    if (ai.requestTimeoutMs >= document.execution.defaultTimeoutMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserAi', 'requestTimeoutMs'],
        message: `须小于默认步骤超时 ${document.execution.defaultTimeoutMs}ms`,
      })
    }
    if (!ai.enabled) return
    if (!ai.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserAi', 'baseUrl'],
        message: '启用浏览器仿真 AI 时必须配置服务地址',
      })
    }
    if (!ai.model) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserAi', 'model'],
        message: '启用浏览器仿真 AI 时必须配置模型名',
      })
    }
    if (!ai.modelFamily) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserAi', 'modelFamily'],
        message: '启用浏览器仿真 AI 时必须配置模型族',
      })
    }
    if (!ai.secretRef) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserAi', 'secretRef'],
        message: '启用浏览器仿真 AI 时必须配置 Secret 引用',
      })
    }
  })
export type PlatformConfigDocument = z.infer<typeof platformConfigDocumentSchema>

export const FACTORY_PLATFORM_CONFIG: PlatformConfigDocument = {
  schemaVersion: PLATFORM_CONFIG_SCHEMA_VERSION,
  execution: {
    defaultTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    defaultRetryLimit: DEFAULT_RETRY_LIMIT,
  },
  session: {
    reuse:
      DEFAULT_SESSION_REUSE_POLICY === 'RECREATE_SESSION'
        ? 'NEW_PAGE'
        : DEFAULT_SESSION_REUSE_POLICY,
    idleTtlSeconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
    maxLifetimeSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
    authWaitSeconds: DEFAULT_SESSION_AUTH_WAIT_SECONDS,
    reclaim: DEFAULT_SESSION_RECLAIM_MODE,
    keepAliveSeconds: DEFAULT_SESSION_KEEP_ALIVE_SECONDS,
    authProbeIntervalSeconds: DEFAULT_SESSION_AUTH_PROBE_INTERVAL_SECONDS,
    evictionPriority: DEFAULT_SESSION_EVICTION_PRIORITY,
    lostDisposition: DEFAULT_SESSION_LOST_DISPOSITION,
  },
  evidence: {
    screenshot: 'always',
    video: FACTORY_EVIDENCE_VIDEO.mode,
    trace: DEFAULT_EVIDENCE_POLICY.trace,
    retainDays: {
      screenshot: DEFAULT_SCREENSHOT_RETAIN_DAYS,
      video: FACTORY_EVIDENCE_VIDEO.retainDays,
      trace: DEFAULT_TRACE_RETAIN_DAYS,
      debugTrace: DEFAULT_DEBUG_TRACE_RETAIN_DAYS,
    },
  },
  browserAi: {
    enabled: false,
    requestTimeoutMs: 15_000,
    stepMaxCalls: 20,
    maxOutputTokens: 2048,
  },
  platformAi: FACTORY_PLATFORM_AI,
  sessionScheduling: FACTORY_SESSION_SCHEDULING,
  sessionAuth: FACTORY_SESSION_AUTH,
  sessionRetention: FACTORY_SESSION_RETENTION,
  runAuthRecovery: FACTORY_RUN_AUTH_RECOVERY,
  mapCapture: FACTORY_MAP_CAPTURE_POLICY,
  mapScheduledRefreshEnabled: false,
  mapExplorationEnabled: false,
  moduleResolver: FACTORY_MODULE_RESOLVER,
  moduleQuality: FACTORY_MODULE_QUALITY,
  moduleFallback: FACTORY_MODULE_FALLBACK,
  runtimeInvariants: FACTORY_RUNTIME_INVARIANT_DEFAULTS,
  alerting: { rules: FACTORY_ALERTING.rules, credentialMaintenance: FACTORY_ALERTING.credentialMaintenance },
  notifications: FACTORY_NOTIFICATIONS,
}

/**
 * 文档按写入当时的 schemaVersion 保存，读取时先逐级升级再按当前 schema 校验。
 *
 * 加新版本时只做两件事：把 PLATFORM_CONFIG_SCHEMA_VERSION 加一，并在此登记 n -> n+1
 * 的升级函数。读取处不需要改，也不允许在别处按版本号分支。
 */
export type PlatformConfigUpgrade = (raw: Record<string, unknown>) => Record<string, unknown>

const PLATFORM_CONFIG_UPGRADES = new Map<number, PlatformConfigUpgrade>([[1, raw => {
  const alerting = (raw.alerting ?? FACTORY_ALERTING) as typeof FACTORY_ALERTING
  const channels = (alerting.channels ?? []).map(c => ({
    id: c.id, name: c.name, kind: 'webhook', enabled: c.enabled, allowAlerts: true, targetIds: [],
    version: 1, secretRef: c.secretRef, host: c.urlHost, recipients: [],
    format: 'legacy_alert@1', replay: 'manual_on_unknown',
  }))
  return {
    ...raw, schemaVersion: 2,
    alerting: { rules: alerting.rules, credentialMaintenance: alerting.credentialMaintenance ?? { enabled: false, channelIds: [] } },
    notifications: { enabled: channels.some(c => c.enabled), consoleBaseUrl: '', smtp: null, channels },
  }
}]])

function schemaUnsupported(message: string): Error {
  return Object.assign(new Error(message), { code: PLATFORM_CONFIG_SCHEMA_UNSUPPORTED })
}

/** 把任意存量平台配置文档升级到当前版本并严格校验。读取持久化文档一律走这里。 */
export function upgradePlatformConfigDocument(raw: unknown): PlatformConfigDocument {
  if (!isPlainObject(raw)) throw schemaUnsupported('平台配置文档不是对象')
  const declared = raw.schemaVersion
  if (
    typeof declared !== 'number' ||
    !Number.isInteger(declared) ||
    declared < PLATFORM_CONFIG_MIN_SCHEMA_VERSION
  ) {
    throw schemaUnsupported(`平台配置 schemaVersion 非法：${JSON.stringify(declared)}`)
  }
  if (declared > PLATFORM_CONFIG_SCHEMA_VERSION) {
    throw schemaUnsupported(
      `平台配置 schemaVersion ${declared} 高于本版本支持的 ${PLATFORM_CONFIG_SCHEMA_VERSION}，请先升级服务`,
    )
  }
  let document: Record<string, unknown> = raw
  for (let version = declared; version < PLATFORM_CONFIG_SCHEMA_VERSION; version += 1) {
    const upgrade = PLATFORM_CONFIG_UPGRADES.get(version)
    if (!upgrade) {
      throw schemaUnsupported(`缺少平台配置 schemaVersion ${version} -> ${version + 1} 的升级函数`)
    }
    document = upgrade(document)
    if (document.schemaVersion !== version + 1) {
      throw schemaUnsupported(
        `平台配置 schemaVersion ${version} 的升级函数未把版本推进到 ${version + 1}`,
      )
    }
  }
  return platformConfigDocumentSchema.parse(document)
}

/**
 * 历史修订原样返回：变更记录只用于展示与差异，不能因为当前 schema 删改了某一节
 * 就让整页打不开。严格校验只发生在恢复写回时。
 */
export const storedPlatformConfigDocumentSchema = z.record(z.string(), z.unknown())
export type StoredPlatformConfigDocument = z.infer<typeof storedPlatformConfigDocumentSchema>

export const platformRuntimeDefaultsSchema = z.strictObject({
  revision: z.number().int().positive(),
  execution: platformExecutionDefaultsSchema,
  session: platformSessionDefaultsSchema,
  evidence: platformEvidenceDefaultsSchema,
  browserAiEnabled: z.boolean(),
})
export type PlatformRuntimeDefaults = z.infer<typeof platformRuntimeDefaultsSchema>

export const platformConfigCurrentSchema = z.strictObject({
  revision: z.number().int().positive(),
  document: platformConfigDocumentSchema,
  updatedAt: utcInstantSchema,
  updatedByAccountId: entityIdSchema.nullable(),
  reason: z.string().min(1).max(512),
  source: z.enum(PLATFORM_CONFIG_SOURCES),
})
export type PlatformConfigCurrent = z.infer<typeof platformConfigCurrentSchema>

export const platformConfigReasonSchema = z.string().trim().min(1, '请填写变更原因').max(512)

export const platformConfigUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  reason: platformConfigReasonSchema,
  document: platformConfigDocumentSchema,
})
export type PlatformConfigUpdateBody = z.infer<typeof platformConfigUpdateBodySchema>

export const platformConfigValidateBodySchema = z.strictObject({
  document: platformConfigDocumentSchema,
})
export type PlatformConfigValidateBody = z.infer<typeof platformConfigValidateBodySchema>

export const platformConfigRestoreBodySchema = z.strictObject({
  revision: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
  reason: platformConfigReasonSchema,
})
export type PlatformConfigRestoreBody = z.infer<typeof platformConfigRestoreBodySchema>

export const platformConfigSecretBodySchema = z.strictObject({
  baseUrl: platformModelUrlSchema,
  apiKey: z.string().min(1).max(4096),
})
export type PlatformConfigSecretBody = z.infer<typeof platformConfigSecretBodySchema>

export const platformConfigSecretResponseSchema = z.strictObject({
  secretRef: secretRefSchema,
})
export type PlatformConfigSecretResponse = z.infer<typeof platformConfigSecretResponseSchema>

export const platformConfigTestConnectionBodySchema = z.strictObject({
  baseUrl: platformModelUrlSchema,
  model: z.string().trim().min(1).max(256),
  modelFamily: z.string().trim().min(1).max(64),
  secretRef: secretRefSchema.optional(),
})
export type PlatformConfigTestConnectionBody = z.infer<
  typeof platformConfigTestConnectionBodySchema
>

export const platformConfigTestConnectionResponseSchema = z.strictObject({
  ok: z.boolean(),
  message: z.string().min(1).max(512),
})
export type PlatformConfigTestConnectionResponse = z.infer<
  typeof platformConfigTestConnectionResponseSchema
>

export const platformConfigRevisionSchema = z.strictObject({
  id: entityIdSchema,
  revision: z.number().int().positive(),
  document: storedPlatformConfigDocumentSchema,
  actorAccountId: entityIdSchema.nullable(),
  reason: z.string().min(1).max(512),
  source: z.enum(PLATFORM_CONFIG_SOURCES),
  createdAt: utcInstantSchema,
  diff: z.array(
    z.strictObject({
      path: z.string().min(1),
      from: z.unknown().optional(),
      to: z.unknown().optional(),
    }),
  ),
})
export type PlatformConfigRevision = z.infer<typeof platformConfigRevisionSchema>

export const platformConfigRevisionListSchema = z.strictObject({
  items: z.array(platformConfigRevisionSchema),
  nextCursor: nextCursorSchema,
})
export type PlatformConfigRevisionList = z.infer<typeof platformConfigRevisionListSchema>

export const frozenTargetAuthSchema = z.strictObject({
  entryUrl: z.string().min(1).max(2048),
  loginUrl: z.string().max(2048).nullable(),
  authMethod: z.enum(AUTH_METHODS),
  captchaMode: z.enum(CAPTCHA_MODES),
  loginFields: targetLoginFieldsDtoSchema,
  captcha: targetCaptchaDefinitionSchema.optional(),
  sensitiveSelectors: z.array(z.string().trim().min(1).max(256)).max(32).optional(),
})
export type FrozenTargetAuth = z.infer<typeof frozenTargetAuthSchema>

export function platformRuntimeDefaultsFrom(
  document: PlatformConfigDocument,
  revision: number,
): PlatformRuntimeDefaults {
  return platformRuntimeDefaultsSchema.parse({
    revision,
    execution: document.execution,
    session: document.session,
    evidence: document.evidence,
    browserAiEnabled: document.browserAi.enabled,
  })
}

export function sessionPolicyFromPlatform(session: PlatformSessionDefaults): SessionPolicy {
  return sessionPolicySchema.parse({
    reuse: session.reuse,
    idleTtlSeconds: session.idleTtlSeconds,
    maxLifetimeSeconds: session.maxLifetimeSeconds,
    leaseTtlSeconds: DEFAULT_SESSION_LEASE_TTL_SECONDS,
    authWaitSeconds: session.authWaitSeconds,
    reclaim: session.reclaim,
    keepAliveSeconds: session.keepAliveSeconds,
    authProbeIntervalSeconds: session.authProbeIntervalSeconds,
    evictionPriority: session.evictionPriority,
    lostDisposition: session.lostDisposition,
  })
}

export function resolvePlatformSessionPolicy(
  override: SessionPolicyOverride | null | undefined,
  platform: PlatformSessionDefaults,
  targetOverride?: SessionPolicyOverride | TargetSessionPolicyOverride | null,
): SessionPolicy {
  return resolveSessionPolicyLayers({
    platformDefault: sessionPolicyFromPlatform(platform),
    targetOverride,
    runOverride: override,
  })
}

export function resolvePlatformEvidencePolicy(
  override: EvidencePolicy | null | undefined,
  platform: PlatformEvidenceDefaults,
): ResolvedEvidencePolicy {
  const trace = override?.trace ?? platform.trace
  const base: ResolvedEvidencePolicy = {
    screenshot: platform.screenshot,
    video: platform.video,
    trace: platform.trace,
    required: [...DEFAULT_EVIDENCE_POLICY.required],
    retainDays: {
      screenshot: platform.retainDays.screenshot,
      video: platform.retainDays.video,
      trace: trace === 'always' ? platform.retainDays.debugTrace : platform.retainDays.trace,
    },
    screenshotViewport: override?.screenshotViewport ?? 'viewport',
  }
  const resolved = resolveEvidencePolicy(override, base)
  if (override?.retainDays?.trace === undefined) {
    return {
      ...resolved,
      retainDays: {
        ...resolved.retainDays,
        trace: base.retainDays.trace,
      },
    }
  }
  return resolved
}

export function resolvePlatformExecutionPolicy(
  override: ExecutionPolicy | undefined,
  platform: PlatformExecutionDefaults,
): ExecutionPolicy {
  return {
    timeoutMs: override?.timeoutMs ?? platform.defaultTimeoutMs,
    retryLimit: override?.retryLimit ?? platform.defaultRetryLimit,
  }
}

export function assertAiRequestTimeoutFitsSteps(
  steps: readonly { type: string; id?: string; policy?: ExecutionPolicy }[],
  snapshotPolicy: ExecutionPolicy | undefined,
  requestTimeoutMs: number,
): void {
  for (const step of steps) {
    if (!isAiStepType(step.type)) continue
    const resolved = resolveStepPolicy(snapshotPolicy, step.policy, step.type)
    if (requestTimeoutMs >= resolved.timeoutMs) {
      throw Object.assign(
        new Error(
          `AI 请求超时须小于步骤${step.id ? ` ${step.id}` : ''}的解析超时 ${resolved.timeoutMs}ms`,
        ),
        { code: 'AI_CONFIG_INVALID' },
      )
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function overridesCompatible(
  override: Record<string, unknown> | null | undefined,
  resolved: Record<string, unknown> | null | undefined,
): boolean {
  if (override == null) return true
  if (!resolved) return false
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    if (isPlainObject(value)) {
      if (!isPlainObject(resolved[key]) || !overridesCompatible(value, resolved[key])) return false
    } else if (JSON.stringify(value) !== JSON.stringify(resolved[key])) return false
  }
  return true
}

export function idempotentRequestMatches(input: {
  existingDigest: string
  rawDigest: string
  legacyDigest: string
  sessionOverride?: SessionPolicyOverride | null
  evidenceOverride?: EvidencePolicy | null
  policyOverride?: ExecutionPolicy
  mapCaptureOverride?: MapCapturePolicyOverride | null
  snapshotSession?: SessionPolicy
  snapshotEvidence?: EvidencePolicy
  snapshotPolicy?: ExecutionPolicy
  snapshotMapCapture?: MapCapturePolicy
}): boolean {
  if (input.existingDigest === input.rawDigest) return true
  if (input.existingDigest !== input.legacyDigest) return false
  return (
    overridesCompatible(
      input.sessionOverride as Record<string, unknown> | null | undefined,
      input.snapshotSession as unknown as Record<string, unknown> | undefined,
    ) &&
    overridesCompatible(
      input.evidenceOverride as Record<string, unknown> | null | undefined,
      input.snapshotEvidence as unknown as Record<string, unknown> | undefined,
    ) &&
    overridesCompatible(
      input.policyOverride as Record<string, unknown> | undefined,
      input.snapshotPolicy as Record<string, unknown> | undefined,
    ) &&
    overridesCompatible(
      input.mapCaptureOverride as Record<string, unknown> | null | undefined,
      input.snapshotMapCapture as unknown as Record<string, unknown> | undefined,
    )
  )
}

function redactConfigValue(path: string, value: unknown): unknown {
  if (path.endsWith('secretRef') && isPlainObject(value)) {
    return { provider: value.provider, secretId: value.secretId }
  }
  return value
}

export function platformConfigDiff(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): { path: string; from?: unknown; to?: unknown }[] {
  if (!previous) return []
  const diffs: { path: string; from?: unknown; to?: unknown }[] = []
  const walk = (prefix: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) === JSON.stringify(to)) return
    if (isPlainObject(from) && isPlainObject(to)) {
      const keys = new Set([...Object.keys(from), ...Object.keys(to)])
      for (const key of keys) {
        walk(prefix ? `${prefix}.${key}` : key, from[key], to[key])
      }
      return
    }
    if (!prefix) return
    diffs.push({
      path: prefix,
      from: from === undefined ? undefined : redactConfigValue(prefix, from),
      to: to === undefined ? undefined : redactConfigValue(prefix, to),
    })
  }
  walk('', previous, next)
  return diffs
}

export function localSecretRef(secretId: string) {
  return { provider: LOCAL_SECRET_PROVIDER, secretId }
}

export function modelServiceOrigin(url: string): string {
  const parsed = new UrlCtor(url)
  return `${parsed.protocol}//${parsed.host}`
}
