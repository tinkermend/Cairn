import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { sha256Hex } from './internal-auth.js'
import { loginLocatorSchema } from './login-fields.js'
import { entityIdSchema, timeoutMsSchema, utcInstantSchema } from './wire.js'

export const AUTH_CAPABILITY_TIERS = ['IDENTITY_VERIFIED', 'LOGIN_VERIFIED', 'LEGACY'] as const
export type AuthCapabilityTier = (typeof AUTH_CAPABILITY_TIERS)[number]
export const authCapabilityTierSchema = z.enum(AUTH_CAPABILITY_TIERS)

export const IDENTITY_STATES = ['UNVERIFIED', 'MATCH', 'MISMATCH'] as const
export type IdentityState = (typeof IDENTITY_STATES)[number]
export const identityStateSchema = z.enum(IDENTITY_STATES)

export const AUTH_UNKNOWN_CLASSES = ['infra', 'unmatched'] as const
export type AuthUnknownClass = (typeof AUTH_UNKNOWN_CLASSES)[number]
export const authUnknownClassSchema = z.enum(AUTH_UNKNOWN_CLASSES)

export const AUTH_SIGNAL_KINDS = ['auth_endpoint_expired', 'navigated_to_login', 'login_form_visible'] as const
export type AuthSignalKind = (typeof AUTH_SIGNAL_KINDS)[number]
export const authSignalKindSchema = z.enum(AUTH_SIGNAL_KINDS)

export const AUTH_DECISION_KINDS = ['reused', 'verified', 'auto_login', 'manual_auth'] as const
export type AuthDecisionKind = (typeof AUTH_DECISION_KINDS)[number]
export const authDecisionKindSchema = z.enum(AUTH_DECISION_KINDS)

export const AUTH_VALIDATION_STEPS = ['valid_pass', 'server_revoked', 'other_account'] as const
export type AuthValidationStep = (typeof AUTH_VALIDATION_STEPS)[number]
export const authValidationStepSchema = z.enum(AUTH_VALIDATION_STEPS)

export const AUTH_IDENTITY_NORMALIZERS = ['exact', 'trim', 'lowercase'] as const
export type AuthIdentityNormalizer = (typeof AUTH_IDENTITY_NORMALIZERS)[number]
export const authIdentityNormalizerSchema = z.enum(AUTH_IDENTITY_NORMALIZERS)

export const AUTH_RENEW_MODES = ['none', 'verify_slides', 'relogin'] as const
export type AuthRenewMode = (typeof AUTH_RENEW_MODES)[number]
export const authRenewModeSchema = z.enum(AUTH_RENEW_MODES)

export const AUTH_VERIFY_MODES = ['http', 'page'] as const
export type AuthVerifyMode = (typeof AUTH_VERIFY_MODES)[number]
export const authVerifyModeSchema = z.enum(AUTH_VERIFY_MODES)

export const AUTH_ERROR_CODES = [
  'AUTH_PROBE_UNKNOWN',
  'AUTH_IDENTITY_MISMATCH',
  'AUTH_PROFILE_REQUIRED',
  'AUTH_AUTO_LOGIN_PAUSED',
  'AUTH_CONFIGURATION_REVOKED',
  'AUTH_FRESHNESS_OUT_OF_RANGE',
  'AUTH_VALIDATION_INCOMPLETE',
] as const
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]
export const authErrorCodeSchema = z.enum(AUTH_ERROR_CODES)

export const DEFAULT_FRESHNESS_SECONDS = 300
export const DEFAULT_FRESHNESS_SECONDS_MIN = 60
export const DEFAULT_FRESHNESS_SECONDS_MAX = 1_800
export const DEFAULT_VERIFY_TIMEOUT_MS = 15_000
export const DEFAULT_LOGIN_TIMEOUT_MS = 60_000
export const DEFAULT_VERIFY_RETRY_BACKOFF_SECONDS = [30, 120] as const
export const DEFAULT_AUTO_LOGIN_WINDOW_SECONDS = 600
export const DEFAULT_AUTO_LOGIN_MAX_PER_WINDOW = 1
export const DEFAULT_AUTO_LOGIN_PAUSE_AFTER_FAILURES = 2

export const platformSessionAuthSchema = z
  .strictObject({
    freshnessSecondsDefault: z.number().int().min(DEFAULT_FRESHNESS_SECONDS_MIN).max(DEFAULT_FRESHNESS_SECONDS_MAX),
    freshnessSecondsMin: z.number().int().min(1).max(DEFAULT_FRESHNESS_SECONDS_MAX),
    freshnessSecondsMax: z.number().int().min(DEFAULT_FRESHNESS_SECONDS_MIN).max(7_200),
    verifyTimeoutMs: timeoutMsSchema,
    loginTimeoutMs: timeoutMsSchema,
    verifyRetryBackoffSeconds: z.array(z.number().int().min(1).max(3_600)).min(1).max(8),
    autoLoginWindowSeconds: z.number().int().min(60).max(86_400),
    autoLoginMaxPerWindow: z.number().int().min(1).max(20),
    autoLoginPauseAfterFailures: z.number().int().min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (value.freshnessSecondsMin > value.freshnessSecondsDefault) {
      ctx.addIssue({
        code: 'custom',
        path: ['freshnessSecondsMin'],
        message: '不得大于默认新鲜度',
      })
    }
    if (value.freshnessSecondsDefault > value.freshnessSecondsMax) {
      ctx.addIssue({
        code: 'custom',
        path: ['freshnessSecondsMax'],
        message: '不得小于默认新鲜度',
      })
    }
    for (let i = 1; i < value.verifyRetryBackoffSeconds.length; i += 1) {
      if (value.verifyRetryBackoffSeconds[i]! < value.verifyRetryBackoffSeconds[i - 1]!) {
        ctx.addIssue({
          code: 'custom',
          path: ['verifyRetryBackoffSeconds', i],
          message: '退避秒数必须非递减',
        })
      }
    }
  })
export type PlatformSessionAuth = z.infer<typeof platformSessionAuthSchema>

export const FACTORY_SESSION_AUTH: PlatformSessionAuth = {
  freshnessSecondsDefault: DEFAULT_FRESHNESS_SECONDS,
  freshnessSecondsMin: DEFAULT_FRESHNESS_SECONDS_MIN,
  freshnessSecondsMax: DEFAULT_FRESHNESS_SECONDS_MAX,
  verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
  verifyRetryBackoffSeconds: [...DEFAULT_VERIFY_RETRY_BACKOFF_SECONDS],
  autoLoginWindowSeconds: DEFAULT_AUTO_LOGIN_WINDOW_SECONDS,
  autoLoginMaxPerWindow: DEFAULT_AUTO_LOGIN_MAX_PER_WINDOW,
  autoLoginPauseAfterFailures: DEFAULT_AUTO_LOGIN_PAUSE_AFTER_FAILURES,
}

const httpConditionSchema = z.strictObject({
  status: z.number().int().min(100).max(599).optional(),
  jsonPath: z.string().trim().min(1).max(256).optional(),
  equals: z.unknown().optional(),
  exists: z.boolean().optional(),
})

const pageConditionSchema = z.strictObject({
  locator: loginLocatorSchema,
})

export const targetAuthProfileDefinitionSchema = z
  .strictObject({
    verify: z.strictObject({
      mode: authVerifyModeSchema,
      /** 相对 scope.origin 的核验路径；缺省取第一个 pathPrefix。 */
      path: z.string().trim().min(1).max(512).optional(),
      success: z.union([httpConditionSchema, pageConditionSchema]),
      failure: z.union([httpConditionSchema, pageConditionSchema]),
    }),
    identity: z
      .strictObject({
        source: z.enum(['json', 'page']),
        jsonPath: z.string().trim().min(1).max(256).optional(),
        locator: loginLocatorSchema.optional(),
        normalize: authIdentityNormalizerSchema,
      })
      .optional(),
    renew: authRenewModeSchema.default('none'),
    expiry: z.strictObject({ jsonPath: z.string().trim().min(1).max(256) }).optional(),
    freshnessSeconds: z.number().int().positive().max(7_200).optional(),
    scope: z.strictObject({
      origins: z.array(z.string().trim().min(1).max(256)).min(1).max(16),
      pathPrefixes: z.array(z.string().trim().min(1).max(256)).min(1).max(16),
    }),
  })
  .superRefine((definition, ctx) => {
    if (definition.verify.mode === 'http') {
      if (!('status' in definition.verify.success || 'jsonPath' in definition.verify.success)) {
        ctx.addIssue({ code: 'custom', path: ['verify', 'success'], message: 'http 成功条件须含 status 或 jsonPath' })
      }
    } else if (!('locator' in definition.verify.success)) {
      ctx.addIssue({ code: 'custom', path: ['verify', 'success'], message: 'page 成功条件须含 locator' })
    }
    if (definition.identity?.source === 'json' && !definition.identity.jsonPath) {
      ctx.addIssue({ code: 'custom', path: ['identity', 'jsonPath'], message: 'json 身份须给出路径' })
    }
    if (definition.identity?.source === 'page' && !definition.identity.locator) {
      ctx.addIssue({ code: 'custom', path: ['identity', 'locator'], message: 'page 身份须给出定位' })
    }
  })
export type TargetAuthProfileDefinition = z.infer<typeof targetAuthProfileDefinitionSchema>

export const authObservationSchema = z.strictObject({
  authState: z.enum(['UNKNOWN', 'AUTHENTICATED', 'EXPIRED']),
  identityState: identityStateSchema.default('UNVERIFIED'),
  observedIdentity: z.string().trim().min(1).max(256).nullable().default(null),
  unknownClass: authUnknownClassSchema.nullable().default(null),
  evidenceSummary: z.string().trim().min(1).max(512).nullable().default(null),
  authProfileRevision: z.number().int().positive().nullable().default(null),
  diagnosticCode: z.string().trim().min(1).max(64).nullable().default(null),
  diagnostic: z.string().trim().min(1).max(512).optional(),
})
export type AuthObservation = z.infer<typeof authObservationSchema>

export const authProfileValidationSchema = z.strictObject({
  recordedAt: utcInstantSchema,
  actorId: entityIdSchema,
  operationId: entityIdSchema,
  steps: z.strictObject({
    valid_pass: authObservationSchema.optional(),
    server_revoked: authObservationSchema.optional(),
    other_account: authObservationSchema.optional(),
  }),
})
export type AuthProfileValidation = z.infer<typeof authProfileValidationSchema>

export const frozenAuthVerificationSchema = z.strictObject({
  profileRevision: z.number().int().positive().nullable(),
  profileDigest: z.string().min(1).max(128).nullable(),
  loginFieldsDigest: z.string().min(1).max(128),
  expectedIdentity: z.string().trim().min(1).max(256).nullable(),
  capability: authCapabilityTierSchema,
  freshnessSeconds: z.number().int().positive(),
  verifyTimeoutMs: timeoutMsSchema,
  loginTimeoutMs: timeoutMsSchema,
  verifyRetryBackoffSeconds: z.array(z.number().int().positive()).min(1).max(8),
  platformConfigRevision: z.number().int().positive(),
})
export type FrozenAuthVerification = z.infer<typeof frozenAuthVerificationSchema>

export const authSignalSchema = z.strictObject({
  kind: authSignalKindSchema,
  at: utcInstantSchema,
  summary: z.string().trim().min(1).max(512),
})
export type AuthSignal = z.infer<typeof authSignalSchema>

export function normalizeAuthIdentity(value: string, normalize: AuthIdentityNormalizer): string {
  if (normalize === 'exact') return value
  if (normalize === 'trim') return value.trim()
  return value.trim().toLowerCase()
}

export function compareAuthIdentity(
  observed: string | null,
  expected: string | null,
  normalize: AuthIdentityNormalizer,
): IdentityState {
  if (!expected || !observed) return 'UNVERIFIED'
  return normalizeAuthIdentity(observed, normalize) === normalizeAuthIdentity(expected, normalize)
    ? 'MATCH'
    : 'MISMATCH'
}

export function deriveAuthCapability(input: {
  definition: TargetAuthProfileDefinition | null
  validation: AuthProfileValidation | null
  expectedIdentity: string | null
}): AuthCapabilityTier {
  if (!input.definition || !input.validation) return 'LEGACY'
  const pass = input.validation.steps.valid_pass
  const revoked = input.validation.steps.server_revoked
  if (pass?.authState !== 'AUTHENTICATED' || revoked?.authState !== 'EXPIRED') return 'LEGACY'
  const hasIdentity = Boolean(input.definition.identity)
  const mismatch = input.validation.steps.other_account
  if (hasIdentity && input.expectedIdentity && mismatch?.identityState === 'MISMATCH') {
    return 'IDENTITY_VERIFIED'
  }
  return 'LOGIN_VERIFIED'
}

export function resolveFreshnessSeconds(
  definition: TargetAuthProfileDefinition | null,
  sessionAuth: PlatformSessionAuth,
): number {
  return definition?.freshnessSeconds ?? sessionAuth.freshnessSecondsDefault
}

export function assertFreshnessInRange(
  freshnessSeconds: number | undefined,
  sessionAuth: PlatformSessionAuth,
): void {
  if (freshnessSeconds == null) return
  if (freshnessSeconds < sessionAuth.freshnessSecondsMin || freshnessSeconds > sessionAuth.freshnessSecondsMax) {
    throw Object.assign(new Error('新鲜度超出平台允许范围'), { code: 'AUTH_FRESHNESS_OUT_OF_RANGE' as const })
  }
}

export function classifyAuthSignals(input: {
  observation: AuthObservation
  pageUrl?: string | null
  loginUrl?: string | null
  at?: string
}): AuthSignal[] {
  const at = input.at ?? new Date().toISOString()
  const signals: AuthSignal[] = []
  if (input.observation.authState === 'EXPIRED') {
    signals.push({
      kind: 'auth_endpoint_expired',
      at,
      summary: input.observation.evidenceSummary ?? '核验判定登录已失效',
    })
  }
  if (input.pageUrl && input.loginUrl) {
    try {
      const page = new URL(input.pageUrl)
      const login = new URL(input.loginUrl)
      if (page.origin === login.origin && page.pathname === login.pathname) {
        signals.push({ kind: 'navigated_to_login', at, summary: input.pageUrl.slice(0, 512) })
      }
    } catch {
      /* 非法 URL 不记导航信号 */
    }
  }
  if (input.observation.evidenceSummary?.includes('失效定位可见')) {
    signals.push({
      kind: 'login_form_visible',
      at,
      summary: input.observation.evidenceSummary,
    })
  }
  return signals
}

export function isAuthEvidenceFresh(input: {
  lastAuthSuccessAt: string | null
  freshnessSeconds: number
  nowMs: number
  sessionGeneration: number
  frozenGeneration: number | null
  profileRevision: number | null
  frozenRevision: number | null
  expectedIdentity: string | null
  frozenExpectedIdentity: string | null
}): boolean {
  if (!input.lastAuthSuccessAt) return false
  if (input.frozenGeneration != null && input.frozenGeneration !== input.sessionGeneration) return false
  if (input.frozenRevision !== input.profileRevision) return false
  if ((input.frozenExpectedIdentity ?? null) !== (input.expectedIdentity ?? null)) return false
  return input.nowMs - Date.parse(input.lastAuthSuccessAt) <= input.freshnessSeconds * 1000
}

export async function digestAuthPayload(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value))
}

export const publishTargetAuthProfileBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  definition: targetAuthProfileDefinitionSchema,
})
export type PublishTargetAuthProfileBody = z.infer<typeof publishTargetAuthProfileBodySchema>

export const updateTargetAccountIdentityBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  expectedIdentity: z.string().trim().min(1).max(256).nullable(),
})
export type UpdateTargetAccountIdentityBody = z.infer<typeof updateTargetAccountIdentityBodySchema>

export const startAuthProfileValidationBodySchema = z.strictObject({
  targetAccountId: entityIdSchema,
  idempotencyKey: z.string().trim().min(8).max(128),
  expectedRevision: z.number().int().positive(),
})
export type StartAuthProfileValidationBody = z.infer<typeof startAuthProfileValidationBodySchema>

export const observeAuthProfileValidationBodySchema = z.strictObject({
  step: authValidationStepSchema,
})
export type ObserveAuthProfileValidationBody = z.infer<typeof observeAuthProfileValidationBodySchema>

export function validationStepComplete(
  step: AuthValidationStep,
  observation: AuthObservation,
): boolean {
  if (step === 'valid_pass') return observation.authState === 'AUTHENTICATED'
  if (step === 'server_revoked') return observation.authState === 'EXPIRED'
  return observation.identityState === 'MISMATCH'
}

export function requiredValidationSteps(
  definition: TargetAuthProfileDefinition,
): AuthValidationStep[] {
  return definition.identity
    ? ['valid_pass', 'server_revoked', 'other_account']
    : ['valid_pass', 'server_revoked']
}

export function readJsonPath(value: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean)
  let current: unknown = value
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    const index = /^\d+$/.test(part) ? Number(part) : null
    current = index != null && Array.isArray(current) ? current[index] : (current as Record<string, unknown>)[part]
  }
  return current
}

export type HttpVerifyCondition = {
  status?: number
  jsonPath?: string
  equals?: unknown
  exists?: boolean
}

export function matchHttpCondition(
  status: number,
  body: unknown,
  condition: HttpVerifyCondition,
): boolean {
  if (condition.status != null && condition.status !== status) return false
  if (condition.jsonPath) {
    const got = readJsonPath(body, condition.jsonPath)
    if (condition.exists === false && got !== undefined) return false
    if (condition.exists === true && got === undefined) return false
    if (condition.equals !== undefined) {
      try {
        return canonicalJson(got) === canonicalJson(condition.equals)
      } catch {
        return false
      }
    }
    if (condition.status == null && condition.exists == null && condition.equals === undefined) {
      return got !== undefined
    }
  }
  return condition.status != null || condition.jsonPath != null
}

export function resolveVerifyUrl(definition: TargetAuthProfileDefinition): string {
  const origin = definition.scope.origins[0]!
  const path = definition.verify.path ?? definition.scope.pathPrefixes[0]!
  const base = origin.endsWith('/') ? origin : `${origin}/`
  const relative = path.startsWith('/') ? path.slice(1) : path
  return new URL(relative, base).href
}

export function assertAuthScopeWithinTarget(
  definition: TargetAuthProfileDefinition,
  allowedOrigins: readonly string[],
): void {
  const allowed = new Set(allowedOrigins.map((item) => item.replace(/\/$/, '')))
  for (const origin of definition.scope.origins) {
    if (!allowed.has(origin.replace(/\/$/, ''))) {
      throw Object.assign(new Error('核验范围超出目标允许源'), { code: 'AUTH_SCOPE_INVALID' as const })
    }
  }
}

export type RawAuthVerifyResult =
  | { kind: 'http'; status: number; body: unknown; url: string }
  | { kind: 'page'; successVisible: boolean; failureVisible: boolean; identityText: string | null; url: string }
  | { kind: 'infra'; message: string }

function observationBase(
  revision: number | null,
): Pick<
  AuthObservation,
  'identityState' | 'observedIdentity' | 'unknownClass' | 'evidenceSummary' | 'authProfileRevision' | 'diagnosticCode'
> {
  return {
    identityState: 'UNVERIFIED',
    observedIdentity: null,
    unknownClass: null,
    evidenceSummary: null,
    authProfileRevision: revision,
    diagnosticCode: null,
  }
}

export function evaluateAuthVerify(input: {
  definition: TargetAuthProfileDefinition
  raw: RawAuthVerifyResult
  expectedIdentity: string | null
  revision: number | null
}): AuthObservation {
  const base = observationBase(input.revision)
  if (input.raw.kind === 'infra') {
    return authObservationSchema.parse({
      ...base,
      authState: 'UNKNOWN',
      unknownClass: 'infra',
      evidenceSummary: input.raw.message.slice(0, 512),
      diagnosticCode: 'AUTH_PROBE_UNKNOWN',
    })
  }

  const success =
    input.raw.kind === 'http'
      ? input.raw.status >= 500
        ? false
        : matchHttpCondition(input.raw.status, input.raw.body, input.definition.verify.success as HttpVerifyCondition)
      : input.raw.successVisible && !input.raw.failureVisible
  const failure =
    input.raw.kind === 'http'
      ? input.raw.status >= 500
        ? false
        : matchHttpCondition(input.raw.status, input.raw.body, input.definition.verify.failure as HttpVerifyCondition)
      : input.raw.failureVisible && !input.raw.successVisible

  if (input.raw.kind === 'http' && input.raw.status >= 500) {
    return authObservationSchema.parse({
      ...base,
      authState: 'UNKNOWN',
      unknownClass: 'infra',
      evidenceSummary: `HTTP ${input.raw.status} ${input.raw.url}`.slice(0, 512),
      diagnosticCode: 'AUTH_PROBE_UNKNOWN',
    })
  }

  if ((success && failure) || (!success && !failure)) {
    const summary =
      input.raw.kind === 'http'
        ? `HTTP ${input.raw.status} 条件未唯一匹配 ${input.raw.url}`
        : `页面条件未唯一匹配 ${input.raw.url}`
    return authObservationSchema.parse({
      ...base,
      authState: 'UNKNOWN',
      unknownClass: 'unmatched',
      evidenceSummary: summary.slice(0, 512),
      diagnosticCode: 'AUTH_PROBE_UNKNOWN',
    })
  }

  if (failure) {
    return authObservationSchema.parse({
      ...base,
      authState: 'EXPIRED',
      evidenceSummary: (input.raw.kind === 'http' ? `失效条件 HTTP ${input.raw.status}` : '失效定位可见').slice(0, 512),
      diagnosticCode: 'verified',
    })
  }

  let observedIdentity: string | null = null
  if (input.definition.identity) {
    if (input.definition.identity.source === 'json') {
      if (input.raw.kind !== 'http') {
        return authObservationSchema.parse({
          ...base,
          authState: 'UNKNOWN',
          unknownClass: 'unmatched',
          evidenceSummary: '身份规则要求 JSON 响应',
          diagnosticCode: 'AUTH_PROBE_UNKNOWN',
        })
      }
      const rawIdentity = readJsonPath(input.raw.body, input.definition.identity.jsonPath ?? '')
      observedIdentity = typeof rawIdentity === 'string' && rawIdentity.trim() ? rawIdentity : null
    } else {
      observedIdentity =
        input.raw.kind === 'page' && input.raw.identityText?.trim() ? input.raw.identityText.trim() : null
    }
    if (!observedIdentity) {
      return authObservationSchema.parse({
        ...base,
        authState: 'UNKNOWN',
        unknownClass: 'unmatched',
        evidenceSummary: '已满足正向条件但未读到身份',
        diagnosticCode: 'AUTH_PROBE_UNKNOWN',
      })
    }
  }

  const identityState = compareAuthIdentity(
    observedIdentity,
    input.expectedIdentity,
    input.definition.identity?.normalize ?? 'trim',
  )
  return authObservationSchema.parse({
    ...base,
    authState: 'AUTHENTICATED',
    identityState,
    observedIdentity,
    evidenceSummary: (input.raw.kind === 'http' ? `正向条件 HTTP ${input.raw.status}` : '已登录定位可见').slice(0, 512),
    diagnosticCode: 'verified',
  })
}

export type AuthEnsurePlan =
  | { action: 'reuse' }
  | { action: 'verify' }
  | { action: 'auto_login' }
  | { action: 'manual'; code: 'AUTH_IDENTITY_MISMATCH' | 'AUTH_PROBE_UNKNOWN' | 'SESSION_AUTH_UNSUPPORTED'; message: string }
  | { action: 'fail'; code: 'AUTH_CONFIGURATION_REVOKED' | 'AUTH_PROFILE_REQUIRED'; message: string }
  | { action: 'backoff_verify'; delaySeconds: number }
  | { action: 'yield'; code: 'AUTH_PROBE_UNKNOWN'; message: string }

export function planAuthEnsure(input: {
  capability: AuthCapabilityTier
  fresh: boolean
  observation?: AuthObservation | null
  infraAttempts: number
  backoffSeconds: readonly number[]
}): AuthEnsurePlan {
  if (input.capability === 'LEGACY') return { action: 'verify' }
  if (input.fresh && !input.observation) return { action: 'reuse' }
  if (!input.observation) return { action: 'verify' }

  const observation = input.observation
  if (input.capability === 'IDENTITY_VERIFIED') {
    if (observation.authState === 'AUTHENTICATED' && observation.identityState === 'MATCH') return { action: 'reuse' }
    if (observation.authState === 'AUTHENTICATED' && observation.identityState === 'MISMATCH') {
      return { action: 'manual', code: 'AUTH_IDENTITY_MISMATCH', message: '登录账号与期望身份不符' }
    }
    if (observation.authState === 'EXPIRED') return { action: 'auto_login' }
    if (observation.unknownClass === 'infra') {
      const delay = input.backoffSeconds[input.infraAttempts]
      if (delay != null) return { action: 'backoff_verify', delaySeconds: delay }
      return { action: 'yield', code: 'AUTH_PROBE_UNKNOWN', message: '核验基础设施失败，已回交' }
    }
    return { action: 'manual', code: 'AUTH_PROBE_UNKNOWN', message: '核验条件未匹配，不提交密码' }
  }

  if (observation.authState === 'AUTHENTICATED') return { action: 'reuse' }
  if (observation.unknownClass === 'infra') {
    const delay = input.backoffSeconds[input.infraAttempts]
    if (delay != null) return { action: 'backoff_verify', delaySeconds: delay }
    return { action: 'manual', code: 'AUTH_PROBE_UNKNOWN', message: '核验失败，进入人工认证' }
  }
  return { action: 'manual', code: 'AUTH_PROBE_UNKNOWN', message: '登录状态未确认，进入人工认证' }
}

export const targetAuthProfileRevisionSchema = z.strictObject({
  revision: z.number().int().positive(),
  definition: targetAuthProfileDefinitionSchema,
  digest: z.string().min(1).max(128),
  validation: authProfileValidationSchema.nullable(),
  createdAt: utcInstantSchema,
  createdBy: entityIdSchema.nullable(),
})
export type TargetAuthProfileRevision = z.infer<typeof targetAuthProfileRevisionSchema>

export const targetAuthProfileAccountSummarySchema = z.strictObject({
  accountId: entityIdSchema,
  expectedIdentity: z.string().trim().min(1).max(256).nullable(),
  configRevision: z.number().int().positive(),
  capability: authCapabilityTierSchema,
  lastAuthCheckedAt: utcInstantSchema.nullable(),
  lastAuthSuccessAt: utcInstantSchema.nullable(),
  lastAuthError: z.string().min(1).max(128).nullable(),
  autoLoginPausedReason: z.string().min(1).max(128).nullable(),
})
export type TargetAuthProfileAccountSummary = z.infer<typeof targetAuthProfileAccountSummarySchema>

export const targetAuthProfileViewSchema = z.strictObject({
  current: targetAuthProfileRevisionSchema.nullable(),
  history: z.array(targetAuthProfileRevisionSchema),
  accounts: z.array(targetAuthProfileAccountSummarySchema),
})
export type TargetAuthProfileView = z.infer<typeof targetAuthProfileViewSchema>

export const authValidationOperationSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  status: z.enum(['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  revision: z.number().int().positive(),
  requiredSteps: z.array(authValidationStepSchema),
  observations: z.partialRecord(authValidationStepSchema, authObservationSchema),
  currentStep: authValidationStepSchema.nullable(),
  sessionId: entityIdSchema.nullable(),
  ownerWorkerId: z.string().min(1).max(128).nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  finishedAt: utcInstantSchema.nullable(),
  errorCode: z.string().min(1).max(64).nullable(),
})
export type AuthValidationOperation = z.infer<typeof authValidationOperationSchema>

export const startAuthProfileValidationResponseSchema = z.strictObject({
  operation: authValidationOperationSchema,
  created: z.boolean(),
})
export type StartAuthProfileValidationResponse = z.infer<typeof startAuthProfileValidationResponseSchema>
