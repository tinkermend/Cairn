import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { sha256Hex } from './internal-auth.js'
import { pageRefSchema } from './managed-browser.js'
import { authCapabilityTierSchema, authObservationSchema, authSignalSchema, type AuthCapabilityTier, type AuthObservation, type AuthSignal } from './session-auth.js'
import { effectTypeSchema, type EffectType } from './step.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

/** Worker 声明能力；不作为 claimRun 闸门。旧 Worker 只记 B 的信号。 */
export const SESSION_AUTH_RECOVERY_PROTOCOL = 'session-auth-recovery@1' as const

export const AUTH_RECOVERY_ERROR_CODES = [
  'AUTH_GATE_CLOSED',
  'AUTH_CONTEXT_NOT_RECOVERABLE',
  'AUTH_RECOVERY_LIMIT',
  'RUN_WAITING_FOR_AUTH',
] as const
export type AuthRecoveryErrorCode = (typeof AUTH_RECOVERY_ERROR_CODES)[number]
export const authRecoveryErrorCodeSchema = z.enum(AUTH_RECOVERY_ERROR_CODES)

export const AUTH_CHECKPOINT_STATUSES = ['closed', 'recovering', 'recovered', 'unrecoverable'] as const
export type AuthCheckpointStatus = (typeof AUTH_CHECKPOINT_STATUSES)[number]
export const authCheckpointStatusSchema = z.enum(AUTH_CHECKPOINT_STATUSES)

export const INTERRUPTED_ATTEMPT_CLASSIFICATIONS = [
  'none',
  'not_dispatched',
  'read_only_failed',
  'idempotent_failed',
  'side_effect_dispatched',
] as const
export type InterruptedAttemptClassification = (typeof INTERRUPTED_ATTEMPT_CLASSIFICATIONS)[number]
export const interruptedAttemptClassificationSchema = z.enum(INTERRUPTED_ATTEMPT_CLASSIFICATIONS)

export const AUTH_RECOVERY_KINDS = ['auto', 'manual'] as const
export type AuthRecoveryKind = (typeof AUTH_RECOVERY_KINDS)[number]
export const authRecoveryKindSchema = z.enum(AUTH_RECOVERY_KINDS)

export const AUTH_RECOVERY_DECISIONS = ['none', 'reopen', 'auto', 'manual', 'fail', 'review'] as const
export type AuthRecoveryDecisionKind = (typeof AUTH_RECOVERY_DECISIONS)[number]

export const IN_RUN_AUTH_VERIFY_PHASES = ['step_boundary', 'periodic', 'signal_confirm', 'recovery'] as const
export type InRunAuthVerifyPhase = (typeof IN_RUN_AUTH_VERIFY_PHASES)[number]

export const platformRunAuthRecoverySchema = z.strictObject({
  maxAutoRecoveriesPerRun: z.number().int().min(0).max(20),
  maxManualRecoveriesPerRun: z.number().int().min(0).max(20),
})
export type PlatformRunAuthRecovery = z.infer<typeof platformRunAuthRecoverySchema>

export const FACTORY_RUN_AUTH_RECOVERY: PlatformRunAuthRecovery = {
  maxAutoRecoveriesPerRun: 1,
  maxManualRecoveriesPerRun: 1,
}

/** 旧快照缺字段：不开放运行中恢复。 */
export const NO_RUN_AUTH_RECOVERY: PlatformRunAuthRecovery = {
  maxAutoRecoveriesPerRun: 0,
  maxManualRecoveriesPerRun: 0,
}

export function resolveRunAuthRecovery(value?: PlatformRunAuthRecovery | null): PlatformRunAuthRecovery {
  return value ?? NO_RUN_AUTH_RECOVERY
}

export const RECOVERY_PAGE_POLICIES = ['NEW_PAGE', 'REUSE_PAGE'] as const
export type RecoveryPagePolicy = (typeof RECOVERY_PAGE_POLICIES)[number]

export const recoveryRuleSchema = z.strictObject({
  reuse: z.enum(RECOVERY_PAGE_POLICIES),
  entryUrl: z.string().min(1).max(2048),
  allowedOrigins: z.array(z.string().min(1).max(256)).max(16),
  loginUrl: z.string().min(1).max(2048).optional(),
})
export type RecoveryRule = z.infer<typeof recoveryRuleSchema>

export function deriveRecoveryRule(input: {
  reuse?: string | null
  entryUrl?: string | null
  loginUrl?: string | null
  allowedOrigins?: readonly string[] | null
}): RecoveryRule {
  const reuse: RecoveryPagePolicy = input.reuse === 'REUSE_PAGE' ? 'REUSE_PAGE' : 'NEW_PAGE'
  const entryUrl = input.entryUrl?.trim() || 'https://invalid.invalid/'
  const allowedOrigins = [...(input.allowedOrigins ?? [])]
  const loginUrl = input.loginUrl?.trim() || undefined
  return recoveryRuleSchema.parse({
    reuse,
    entryUrl,
    allowedOrigins,
    ...(loginUrl ? { loginUrl } : {}),
  })
}

export async function computeContextVersion(context: unknown): Promise<string> {
  return sha256Hex(canonicalJson(context ?? {}))
}

export const authCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: authCheckpointStatusSchema,
  closedAt: utcInstantSchema,
  trigger: authSignalSchema,
  nextStepId: entityIdSchema,
  nextOrdinal: z.number().int().nonnegative(),
  interruptedAttemptId: entityIdSchema.optional(),
  interruptedClassification: interruptedAttemptClassificationSchema,
  contextVersion: z.string().min(1).max(128),
  contextKeys: z.array(z.string()),
  pageRef: pageRefSchema.optional(),
  url: z.string().max(2048).optional(),
  sessionGeneration: z.number().int().nonnegative(),
  fencingToken: z.string().min(1).max(128),
  recoveryRule: recoveryRuleSchema,
  capability: authCapabilityTierSchema,
  autoRecoveriesUsed: z.number().int().nonnegative(),
  manualRecoveriesUsed: z.number().int().nonnegative(),
  recoveryKind: authRecoveryKindSchema.nullable().optional(),
  deadlineAt: utcInstantSchema.optional(),
  unrecoverableCode: z.string().min(1).max(64).optional(),
  confirmObservation: authObservationSchema.optional(),
})
export type AuthCheckpoint = z.infer<typeof authCheckpointSchema>

export function classifyInterruptedAttempt(input: {
  effectType?: EffectType | string | null
  dispatched: boolean
}): InterruptedAttemptClassification {
  if (!input.dispatched) return 'not_dispatched'
  const effect = effectTypeSchema.safeParse(input.effectType)
  if (!effect.success) return 'side_effect_dispatched'
  if (effect.data === 'READ_ONLY') return 'read_only_failed'
  if (effect.data === 'IDEMPOTENT') return 'idempotent_failed'
  return 'side_effect_dispatched'
}

export function shouldCloseAuthGate(input: {
  capability?: AuthCapabilityTier | string | null
  signals: readonly AuthSignal[]
}): boolean {
  if (input.capability === 'LEGACY' || !input.capability) return false
  return input.signals.length > 0
}

export function inRunAuthVerifyAllowed(phase: InRunAuthVerifyPhase): boolean {
  return phase === 'signal_confirm' || phase === 'recovery'
}

export function pageLooksLikeLogin(input: { pageUrl?: string | null; loginUrl?: string | null }): boolean {
  if (!input.pageUrl || !input.loginUrl) return false
  try {
    const page = new URL(input.pageUrl)
    const login = new URL(input.loginUrl)
    return page.origin === login.origin && page.pathname === login.pathname
  } catch {
    return false
  }
}

export function isContextRecoverable(input: {
  rule: RecoveryRule
  pageUrl?: string | null
}): boolean {
  if (input.rule.reuse === 'NEW_PAGE') {
    return isContextRecoverable({ rule: { ...input.rule, reuse: 'REUSE_PAGE' }, pageUrl: input.rule.entryUrl })
  }
  if (!input.pageUrl) return false
  if (pageLooksLikeLogin({ pageUrl: input.pageUrl, loginUrl: input.rule.loginUrl })) return false
  try {
    const origin = new URL(input.pageUrl).origin
    const allowed = new Set(input.rule.allowedOrigins.map((item) => item.replace(/\/$/, '')))
    return allowed.has(origin.replace(/\/$/, ''))
  } catch {
    return false
  }
}

export type AuthRecoveryDecision =
  | { kind: 'none' }
  | { kind: 'reopen' }
  | { kind: 'auto' }
  | { kind: 'manual' }
  | { kind: 'fail'; code: 'AUTH_CONTEXT_NOT_RECOVERABLE' | 'AUTH_RECOVERY_LIMIT' }
  | { kind: 'review' }

export function decideAuthRecovery(input: {
  capability?: AuthCapabilityTier | string | null
  classification: InterruptedAttemptClassification
  confirm?: AuthObservation | null
  autoUsed: number
  manualUsed: number
  limits: PlatformRunAuthRecovery
  contextRecoverable: boolean
}): AuthRecoveryDecision {
  if (input.capability === 'LEGACY' || !input.capability) return { kind: 'none' }
  const confirm = input.confirm
  if (confirm?.authState === 'AUTHENTICATED' && (input.capability !== 'IDENTITY_VERIFIED' || confirm.identityState === 'MATCH')) {
    return { kind: 'reopen' }
  }
  if (input.classification === 'side_effect_dispatched') return { kind: 'review' }
  if (!input.contextRecoverable) return { kind: 'fail', code: 'AUTH_CONTEXT_NOT_RECOVERABLE' }
  if (input.capability === 'LOGIN_VERIFIED') return { kind: 'fail', code: 'AUTH_CONTEXT_NOT_RECOVERABLE' }
  if (input.capability !== 'IDENTITY_VERIFIED') return { kind: 'fail', code: 'AUTH_CONTEXT_NOT_RECOVERABLE' }

  if (confirm?.identityState === 'MISMATCH') {
    return input.manualUsed < input.limits.maxManualRecoveriesPerRun
      ? { kind: 'manual' }
      : { kind: 'fail', code: 'AUTH_RECOVERY_LIMIT' }
  }

  if (input.autoUsed < input.limits.maxAutoRecoveriesPerRun) return { kind: 'auto' }
  if (input.manualUsed < input.limits.maxManualRecoveriesPerRun) return { kind: 'manual' }
  return { kind: 'fail', code: 'AUTH_RECOVERY_LIMIT' }
}

export function authGateDoesNotConsumeRetry(classification: InterruptedAttemptClassification): boolean {
  return classification === 'not_dispatched'
}

export function authGateClosedError(classification: InterruptedAttemptClassification): {
  code: 'AUTH_GATE_CLOSED'
  category: 'UNKNOWN' | 'INFRASTRUCTURE'
  retryable: false
  safeMessage: string
  cause: { code: InterruptedAttemptClassification; message?: string }
} {
  return {
    code: 'AUTH_GATE_CLOSED',
    category: classification === 'side_effect_dispatched' ? 'UNKNOWN' : 'INFRASTRUCTURE',
    retryable: false,
    safeMessage: '登录已失效，已阻止继续操作',
    cause: { code: classification },
  }
}

export function redactAuthUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2048)
  } catch {
    return undefined
  }
}

export type AuthRecoveryOutcome =
  | { ok: true }
  | { ok: false; waitingForAuth: true }
  | { ok: false; manualRequired: true; code: string }
  | { ok: false; unrecoverable: true; code: string; runStatus: 'FAILED' | 'NEEDS_REVIEW' }
