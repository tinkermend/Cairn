import { z } from 'zod'
import {
  DEFAULT_DEBUG_TRACE_RETAIN_DAYS,
  DEFAULT_EVIDENCE_POLICY,
  DEFAULT_SCREENSHOT_RETAIN_DAYS,
  DEFAULT_TRACE_RETAIN_DAYS,
  evidenceCaptureModeSchema,
  resolveEvidencePolicy,
  type EvidencePolicy,
  type ResolvedEvidencePolicy,
} from './evidence-policy.js'
import { nextCursorSchema } from './rbac.js'
import { DEFAULT_RETRY_LIMIT, DEFAULT_STEP_TIMEOUT_MS, resolveStepPolicy } from './policy.js'
import { LOCAL_SECRET_PROVIDER, secretRefSchema } from './secret-ref.js'
import {
  DEFAULT_SESSION_AUTH_WAIT_SECONDS,
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_LEASE_TTL_SECONDS,
  DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  DEFAULT_SESSION_POLICY,
  DEFAULT_SESSION_REUSE_POLICY,
  resolveSessionPolicy,
  sessionPolicySchema,
  type SessionPolicy,
  type SessionPolicyOverride,
} from './session.js'
import { isAiStepType, type ExecutionPolicy } from './step.js'
import { AUTH_METHODS, CAPTCHA_MODES, targetLoginFieldsDtoSchema } from './target.js'
import { entityIdSchema, timeoutMsSchema, utcInstantSchema } from './wire.js'

export const PLATFORM_CONFIG_SCHEMA_VERSION = 1 as const
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
  })
  .superRefine((session, ctx) => {
    if (session.maxLifetimeSeconds <= session.idleTtlSeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLifetimeSeconds'],
        message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
      })
    }
  })
export type PlatformSessionDefaults = z.infer<typeof platformSessionDefaultsSchema>

export const platformEvidenceDefaultsSchema = z.strictObject({
  screenshot: evidenceCaptureModeSchema,
  trace: evidenceCaptureModeSchema,
  retainDays: z.strictObject({
    screenshot: z.number().int().positive().max(3650),
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

export const platformConfigDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(PLATFORM_CONFIG_SCHEMA_VERSION),
    execution: platformExecutionDefaultsSchema,
    session: platformSessionDefaultsSchema,
    evidence: platformEvidenceDefaultsSchema,
    browserAi: platformBrowserAiConfigSchema,
  })
  .superRefine((document, ctx) => {
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
  },
  evidence: {
    screenshot: DEFAULT_EVIDENCE_POLICY.screenshot,
    trace: DEFAULT_EVIDENCE_POLICY.trace,
    retainDays: {
      screenshot: DEFAULT_SCREENSHOT_RETAIN_DAYS,
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
}

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
  document: platformConfigDocumentSchema,
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
  })
}

export function resolvePlatformSessionPolicy(
  override: SessionPolicyOverride | null | undefined,
  platform: PlatformSessionDefaults,
): SessionPolicy {
  return resolveSessionPolicy(override, sessionPolicyFromPlatform(platform))
}

export function resolvePlatformEvidencePolicy(
  override: EvidencePolicy | null | undefined,
  platform: PlatformEvidenceDefaults,
): ResolvedEvidencePolicy {
  const trace = override?.trace ?? platform.trace
  const base: ResolvedEvidencePolicy = {
    screenshot: platform.screenshot,
    trace: platform.trace,
    required: [...DEFAULT_EVIDENCE_POLICY.required],
    retainDays: {
      screenshot: platform.retainDays.screenshot,
      trace: trace === 'always' ? platform.retainDays.debugTrace : platform.retainDays.trace,
    },
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
  snapshotSession?: SessionPolicy
  snapshotEvidence?: EvidencePolicy
  snapshotPolicy?: ExecutionPolicy
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
  previous: PlatformConfigDocument | undefined,
  next: PlatformConfigDocument,
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
