/**
 * AM-E：模块调用结果派生、归因与健康信号。
 * 唯一所有者：AM-E。可重算的派生数据，不改 Run 事实。
 */
import { z } from 'zod'
import { isAiCallEvidence } from './ai-runtime.js'
import { candidateGroupsOf, type CandidateGroup, type ModuleManifest, type ModuleManifestEntry } from './authoring-document.js'
import type { ExecutionErrorCategory } from './runtime-error.js'
import {
  isHaltedRunStatus,
  type AttemptStatus,
  type RunSnapshot,
  type RunStatus,
  type StepRunStatus,
} from './run.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { type ModuleHealthSignal, type ModuleHealthSummary, moduleHealthSummarySchema } from './action-module-health.js'

export const MODULE_INVOCATION_PROJECTOR_VERSION = 1 as const

export const MODULE_INVOCATION_OUTCOMES = [
  'VERIFIED',
  'FAILED_IMPLEMENTATION',
  'FAILED_VERIFICATION',
  'NEEDS_REVIEW',
  'NOT_REACHED',
  'CANCELLED',
  'UNKNOWN',
] as const
export type ModuleInvocationOutcome = (typeof MODULE_INVOCATION_OUTCOMES)[number]
export const moduleInvocationOutcomeSchema = z.enum(MODULE_INVOCATION_OUTCOMES)

export const MODULE_INVOCATION_ATTRIBUTIONS = ['MODULE', 'EXTERNAL_INFRA', 'UPSTREAM', 'UNKNOWN'] as const
export type ModuleInvocationAttribution = (typeof MODULE_INVOCATION_ATTRIBUTIONS)[number]
export const moduleInvocationAttributionSchema = z.enum(MODULE_INVOCATION_ATTRIBUTIONS)

export const MODULE_INVOCATION_RUN_KINDS = [
  'published',
  'trial',
  'service',
  'module_verification',
  'map_job',
] as const
export type ModuleInvocationRunKind = (typeof MODULE_INVOCATION_RUN_KINDS)[number]
export const moduleInvocationRunKindSchema = z.enum(MODULE_INVOCATION_RUN_KINDS)

export const MODULE_VERIFICATION_STRENGTHS = ['sufficient', 'insufficient'] as const
export type ModuleVerificationStrength = (typeof MODULE_VERIFICATION_STRENGTHS)[number]
export const moduleVerificationStrengthSchema = z.enum(MODULE_VERIFICATION_STRENGTHS)



export const MODULE_QUALITY_WINDOWS = [7, 30] as const
export type ModuleQualityWindowDays = (typeof MODULE_QUALITY_WINDOWS)[number]
export const moduleQualityWindowSchema = z.coerce
  .number()
  .int()
  .refine((value): value is ModuleQualityWindowDays => value === 7 || value === 30, '窗口只允许 7 或 30 天')

/** 一律记外部基础设施的错误码。 */
export const MODULE_EXTERNAL_INFRA_ERROR_CODES = [
  'SESSION_LEASE_LOST',
  'SESSION_AUTH_TIMEOUT',
  'SESSION_AUTH_UNSUPPORTED',
  'SESSION_BUSY',
  'SESSION_CAPACITY_EXCEEDED',
  'BROWSER_UNAVAILABLE',
  'BROWSER_LAUNCH_FAILED',
  'AUTH_GATE_CLOSED',
  'AUTH_CONTEXT_NOT_RECOVERABLE',
  'AUTH_RECOVERY_LIMIT',
  'AUTH_NOT_VERIFIED',
  'AUTH_CONFIGURATION_REVOKED',
  'AUTH_PROBE_UNKNOWN',
  'AUTH_IDENTITY_MISMATCH',
  'AUTH_PROFILE_REQUIRED',
  'RUN_WAITING_FOR_AUTH',
  'RUN_RECOVERY_EXHAUSTED',
  'DEBUG_WORKER_LOST',
] as const

const EXTERNAL_INFRA_CODES = new Set<string>(MODULE_EXTERNAL_INFRA_ERROR_CODES)
const LOCATION_MISS_CODES = new Set(['TARGET_NOT_FOUND', 'OBSERVE_TARGET_NOT_FOUND'])

export const moduleInvocationAuthHintSchema = z.strictObject({
  hadAuthWaitOrRecovery: z.boolean(),
  authStateExpired: z.boolean(),
})
export type ModuleInvocationAuthHint = z.infer<typeof moduleInvocationAuthHintSchema>

export const moduleInvocationResultSchema = z.strictObject({
  runId: entityIdSchema,
  invocationId: entityIdSchema,
  projectorVersion: z.number().int().positive(),
  moduleId: entityIdSchema,
  moduleVersionId: entityIdSchema.optional(),
  moduleDraftRevision: z.number().int().nonnegative().optional(),
  runKind: moduleInvocationRunKindSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.optional(),
  outcome: moduleInvocationOutcomeSchema,
  attribution: moduleInvocationAttributionSchema,
  failedExpandedStepId: entityIdSchema.optional(),
  errorCategory: z.string().min(1).max(64).optional(),
  errorCode: z.string().min(1).max(128).optional(),
  manualRequirementsUnverified: z.number().int().nonnegative(),
  verificationStrength: moduleVerificationStrengthSchema,
  retriedSuccess: z.boolean(),
  startedAt: utcInstantSchema.optional(),
  finishedAt: utcInstantSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  aiCalls: z.number().int().nonnegative(),
  aiCost: z.number().nonnegative().nullable().optional(),
  sourceRunEventSeq: z.number().int().nonnegative(),
  implementationKey: z.string().min(1).max(32).optional(),
  selectedImplementationKey: z.string().min(1).max(32).optional(),
  fallbackUsed: z.boolean().optional(),
})
export type ModuleInvocationResult = z.infer<typeof moduleInvocationResultSchema>

export const moduleQualityStatsSchema = z.object({
  targetAccountId: entityIdSchema.optional().nullable(),
  calls: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  failedImplementation: z.number().int().nonnegative(),
  failedVerification: z.number().int().nonnegative(),
  externalInfra: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  notReached: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  insufficient: z.number().int().nonnegative(),
  retriedSuccess: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  verifiedRate: z.number().min(0).max(1).nullable(),
  durationMsP50: z.number().int().nonnegative().nullable(),
  durationMsP95: z.number().int().nonnegative().nullable(),
  aiCalls: z.number().int().nonnegative(),
  aiCost: z.number().nonnegative().nullable(),
  lastVerifiedAt: utcInstantSchema.nullable(),
})
export type ModuleQualityStats = z.infer<typeof moduleQualityStatsSchema>

export const moduleQualityQuerySchema = z.object({
  versionId: entityIdSchema.optional(),
  window: moduleQualityWindowSchema.optional(),
  groupBy: z.enum(['account', 'none']).optional().default('none'),
})
export type ModuleQualityQuery = z.input<typeof moduleQualityQuerySchema>

export const moduleQualityResponseSchema = z.object({
  moduleId: entityIdSchema,
  versionId: entityIdSchema.optional().nullable(),
  windowDays: z.number().int().positive(),
  groupBy: z.enum(['account', 'none']),
  asOf: utcInstantSchema,
  configRevision: z.number().int().positive(),
  health: moduleHealthSummarySchema,
  overall: moduleQualityStatsSchema,
  trial: moduleQualityStatsSchema,
  accounts: z.array(moduleQualityStatsSchema).optional(),
  implementations: z
    .array(moduleQualityStatsSchema.extend({ implementationKey: z.string().min(1).max(32) }))
    .optional(),
  fallback: z
    .strictObject({
      occurred: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
    })
    .optional(),
  pendingBackfill: z.number().int().nonnegative().default(0),
})
export type ModuleQualityResponse = z.infer<typeof moduleQualityResponseSchema>

export const moduleInvocationListQuerySchema = z.object({
  versionId: entityIdSchema.optional(),
  outcome: moduleInvocationOutcomeSchema.optional(),
  attribution: moduleInvocationAttributionSchema.optional(),
  accountId: entityIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ModuleInvocationListQuery = z.input<typeof moduleInvocationListQuerySchema>

export const moduleInvocationListItemSchema = moduleInvocationResultSchema.extend({
  runHref: z.string().min(1).max(256),
})
export type ModuleInvocationListItem = z.infer<typeof moduleInvocationListItemSchema>

export const moduleInvocationListResponseSchema = z.object({
  items: z.array(moduleInvocationListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  asOf: utcInstantSchema,
})
export type ModuleInvocationListResponse = z.infer<typeof moduleInvocationListResponseSchema>

export type ModuleQualityDeriveStepRun = {
  stepId: string
  status: StepRunStatus
  startedAt?: string | Date | null
  finishedAt?: string | Date | null
}

export type ModuleQualityDeriveAttempt = {
  stepId: string
  attemptNo: number
  status: AttemptStatus
  startedAt?: string | Date | null
  finishedAt?: string | Date | null
  output?: unknown
  error?: { code?: string; category?: string } | null
}

export type ModuleQualityDeriveEvidence = {
  stepId?: string | null
  type?: string | null
  payload?: unknown
}

export type DeriveInvocationResultsInput = {
  snapshot: Pick<RunSnapshot, 'runId' | 'targetId' | 'targetAccountId' | 'steps' | 'moduleManifest' | 'candidateGroups'>
  run: {
    status: RunStatus
    eventSeq: number
    runKind: ModuleInvocationRunKind
    context?: Record<string, unknown> | null
    authHint?: ModuleInvocationAuthHint
  }
  stepRuns: readonly ModuleQualityDeriveStepRun[]
  attempts: readonly ModuleQualityDeriveAttempt[]
  evidences?: readonly ModuleQualityDeriveEvidence[]
  manualRequirementCounts?: Readonly<Record<string, number>>
  projectorVersion?: number
}

export function classifyModuleRunKind(input: {
  scenarioPurpose?: 'user' | 'module_verification' | 'map_job' | null
  versionKind?: 'published' | 'trial' | null
  serviceCallerId?: string | null
}): ModuleInvocationRunKind {
  if (input.scenarioPurpose === 'module_verification') return 'module_verification'
  if (input.scenarioPurpose === 'map_job') return 'map_job'
  if (input.versionKind === 'trial') return 'trial'
  if (input.serviceCallerId) return 'service'
  return 'published'
}

export function isFormalModuleRunKind(kind: ModuleInvocationRunKind): boolean {
  return kind === 'published' || kind === 'service'
}

export function isExcludedFromFormalStats(kind: ModuleInvocationRunKind): boolean {
  return kind === 'module_verification' || kind === 'map_job'
}

export function passRateBucket(
  result: Pick<ModuleInvocationResult, 'outcome' | 'attribution' | 'verificationStrength'>,
): 'numerator' | 'denominator' | 'excluded' {
  if (result.verificationStrength !== 'sufficient') return 'excluded'
  if (result.outcome === 'VERIFIED') return 'numerator'
  if (result.outcome === 'FAILED_VERIFICATION') return 'denominator'
  if (
    result.outcome === 'FAILED_IMPLEMENTATION' &&
    (result.attribution === 'MODULE' || result.attribution === 'UNKNOWN')
  ) {
    return 'denominator'
  }
  return 'excluded'
}

export function attributeExecutionError(
  error: { code?: string; category?: string } | null | undefined,
  authHint: ModuleInvocationAuthHint = { hadAuthWaitOrRecovery: false, authStateExpired: false },
): ModuleInvocationAttribution | null {
  const code = error?.code
  if (code && EXTERNAL_INFRA_CODES.has(code)) return 'EXTERNAL_INFRA'
  if (code && LOCATION_MISS_CODES.has(code)) {
    return authHint.hadAuthWaitOrRecovery || authHint.authStateExpired ? 'EXTERNAL_INFRA' : 'UNKNOWN'
  }
  if (error?.category === 'INFRASTRUCTURE') return 'EXTERNAL_INFRA'
  return null
}

function iso(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
}

function hasStarted(step: ModuleQualityDeriveStepRun | undefined): boolean {
  if (!step) return false
  return step.status !== 'PENDING' && step.status !== 'SKIPPED'
}

function verificationStrengthOf(entry: ModuleManifestEntry): ModuleVerificationStrength {
  return entry.postconditionStepIds.length === 0 && entry.outputRequired.length === 0
    ? 'insufficient'
    : 'sufficient'
}

function contextHasOutput(context: Record<string, unknown> | null | undefined, entry: ModuleManifestEntry, key: string): boolean {
  if (!context) return false
  if (context[key] !== undefined && context[key] !== null) return true
  const namespaced = `m${entry.ordinal}_${key}`
  return context[namespaced] !== undefined && context[namespaced] !== null
}

function failedAttemptOf(
  stepId: string,
  attempts: readonly ModuleQualityDeriveAttempt[],
): ModuleQualityDeriveAttempt | undefined {
  return [...attempts]
    .filter((item) => item.stepId === stepId && item.status === 'FAILED')
    .sort((a, b) => b.attemptNo - a.attemptNo)[0]
}

function deriveOne(
  entry: ModuleManifestEntry,
  input: DeriveInvocationResultsInput,
  group?: CandidateGroup,
): ModuleInvocationResult {
  const authHint = input.run.authHint ?? { hadAuthWaitOrRecovery: false, authStateExpired: false }
  const byId = new Map(input.stepRuns.map((item) => [item.stepId, item]))
  const winningAlt = group?.alternatives.find((item) =>
    item.stepIds.length > 0 && item.stepIds.every((stepId) => byId.get(stepId)?.status === 'SUCCEEDED'),
  )
  const attemptedAlts =
    group?.alternatives.filter((item) => item.stepIds.some((stepId) => hasStarted(byId.get(stepId)))) ?? []
  const focusStepIds = winningAlt?.stepIds
    ?? attemptedAlts.at(-1)?.stepIds
    ?? entry.expandedStepIds
  const expanded = focusStepIds.map((stepId) => byId.get(stepId))
  const started = (group ? attemptedAlts.length > 0 : entry.expandedStepIds.some((stepId) => hasStarted(byId.get(stepId))))
  const failedSteps = focusStepIds.filter((stepId) => byId.get(stepId)?.status === 'FAILED')
  const firstFailed = winningAlt ? undefined : failedSteps[0]
  const failedAttempt = firstFailed ? failedAttemptOf(firstFailed, input.attempts) : undefined
  const mapped = attributeExecutionError(failedAttempt?.error, authHint)
  const verificationStrength = verificationStrengthOf(entry)
  const retriedSuccess = focusStepIds.some((stepId) => {
    const step = byId.get(stepId)
    if (step?.status !== 'SUCCEEDED') return false
    return input.attempts.some((item) => item.stepId === stepId && item.status === 'FAILED')
  })
  const startedAt = iso(
    expanded
      .map((step) => step?.startedAt)
      .filter((item): item is string | Date => Boolean(item))
      .sort((a, b) => String(iso(a)).localeCompare(String(iso(b))))[0],
  )
  const finishedAt = iso(
    expanded
      .map((step) => step?.finishedAt)
      .filter((item): item is string | Date => Boolean(item))
      .sort((a, b) => String(iso(b)).localeCompare(String(iso(a))))[0],
  )
  const durationMs =
    startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined
  const expandedSet = new Set(group ? group.alternatives.flatMap((item) => item.stepIds) : entry.expandedStepIds)
  const aiEvidences = (input.evidences ?? []).filter((item) => {
    if (!isAiCallEvidence(item.payload)) return false
    return !item.stepId || expandedSet.has(item.stepId)
  })
  const aiCalls = aiEvidences.length
  const aiCostValues = aiEvidences
    .map((item) => (isAiCallEvidence(item.payload) ? item.payload.cost : null))
    .filter((item): item is number => typeof item === 'number')
  const aiCost = aiCostValues.length > 0 ? aiCostValues.reduce((sum, item) => sum + item, 0) : undefined
  const missingOutput = entry.outputRequired.some((key) => !contextHasOutput(input.run.context, entry, key))
  const postconditionIds = winningAlt?.postconditionStepIds ?? entry.postconditionStepIds
  const postconditionFailed = postconditionIds.some((stepId) => byId.get(stepId)?.status === 'FAILED')
  const allSucceeded = Boolean(
    winningAlt ||
      (focusStepIds.length > 0 && focusStepIds.every((stepId) => byId.get(stepId)?.status === 'SUCCEEDED')),
  )

  let outcome: ModuleInvocationOutcome = 'UNKNOWN'
  let attribution: ModuleInvocationAttribution = 'UNKNOWN'
  if (!started && isHaltedRunStatus(input.run.status)) {
    outcome = 'NOT_REACHED'
    attribution = 'UPSTREAM'
  } else if (input.run.status === 'CANCELLED' && started) {
    outcome = 'CANCELLED'
    attribution = 'UNKNOWN'
  } else if (input.run.status === 'NEEDS_REVIEW' && (failedSteps.length > 0 || expanded.some((step) => step?.status === 'RUNNING'))) {
    outcome = 'NEEDS_REVIEW'
    attribution = 'UNKNOWN'
  } else if (firstFailed && mapped === 'EXTERNAL_INFRA') {
    outcome = 'FAILED_IMPLEMENTATION'
    attribution = 'EXTERNAL_INFRA'
  } else if (firstFailed && mapped === 'UNKNOWN' && failedAttempt?.error?.code && LOCATION_MISS_CODES.has(failedAttempt.error.code)) {
    outcome = 'FAILED_IMPLEMENTATION'
    attribution = 'UNKNOWN'
  } else if (postconditionFailed || (allSucceeded && missingOutput)) {
    outcome = 'FAILED_VERIFICATION'
    attribution = 'MODULE'
  } else if (firstFailed) {
    outcome = 'FAILED_IMPLEMENTATION'
    const category = failedAttempt?.error?.category as ExecutionErrorCategory | undefined
    attribution = mapped ?? (category === 'UNKNOWN' || !category ? 'UNKNOWN' : 'MODULE')
  } else if (allSucceeded && !missingOutput) {
    outcome = 'VERIFIED'
    attribution = 'MODULE'
  }

  return moduleInvocationResultSchema.parse({
    runId: input.snapshot.runId,
    invocationId: entry.invocationId,
    projectorVersion: input.projectorVersion ?? MODULE_INVOCATION_PROJECTOR_VERSION,
    moduleId: entry.moduleId,
    ...(entry.moduleVersionId ? { moduleVersionId: entry.moduleVersionId } : {}),
    ...(entry.moduleDraftRevision !== undefined ? { moduleDraftRevision: entry.moduleDraftRevision } : {}),
    runKind: input.run.runKind,
    targetId: input.snapshot.targetId,
    ...(input.snapshot.targetAccountId ? { targetAccountId: input.snapshot.targetAccountId } : {}),
    outcome,
    attribution,
    ...(firstFailed && outcome !== 'NOT_REACHED' && outcome !== 'CANCELLED' ? { failedExpandedStepId: firstFailed } : {}),
    ...(failedAttempt?.error?.category && outcome !== 'NOT_REACHED' && outcome !== 'VERIFIED'
      ? { errorCategory: failedAttempt.error.category }
      : {}),
    ...(failedAttempt?.error?.code && outcome !== 'NOT_REACHED' && outcome !== 'VERIFIED'
      ? { errorCode: failedAttempt.error.code }
      : {}),
    manualRequirementsUnverified: input.manualRequirementCounts?.[entry.invocationId] ?? 0,
    verificationStrength,
    retriedSuccess,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    aiCalls,
    ...(aiCost !== undefined ? { aiCost } : {}),
    sourceRunEventSeq: input.run.eventSeq,
    implementationKey: entry.implementationKey,
    ...(winningAlt ? { selectedImplementationKey: winningAlt.implementationKey } : {}),
    ...(group ? { fallbackUsed: attemptedAlts.length > 1 } : {}),
  })
}

export function deriveInvocationResults(input: DeriveInvocationResultsInput): ModuleInvocationResult[] {
  const manifest: ModuleManifest | undefined = input.snapshot.moduleManifest
  if (!manifest?.entries.length) return []
  const groups = candidateGroupsOf(input.snapshot)
  return manifest.entries.map((entry) =>
    deriveOne(entry, input, groups.find((group) => group.invocationId === entry.invocationId)),
  )
}

export type EvaluateModuleHealthInput = {
  sampleCount: number
  verifiedRate: number | null
  recentFailureStreak: number
  verificationInsufficient: boolean
  windowDays: number
  configRevision: number
  config: {
    minSamples: number
    degradedVerifiedRateBelow: number
    recentFailureStreak: number
  }
  asOf: string
}

export function evaluateModuleHealth(input: EvaluateModuleHealthInput): ModuleHealthSummary {
  let signal: ModuleHealthSignal = 'unknown'
  if (input.sampleCount >= input.config.minSamples) {
    const rateDegraded =
      input.verifiedRate !== null && input.verifiedRate < input.config.degradedVerifiedRateBelow
    const streakDegraded = input.recentFailureStreak >= input.config.recentFailureStreak
    signal = rateDegraded || streakDegraded ? 'degraded' : 'healthy'
  }
  return moduleHealthSummarySchema.parse({
    signal,
    sampleCount: input.sampleCount,
    verifiedRate: input.verifiedRate,
    windowDays: input.windowDays,
    configRevision: input.configRevision,
    asOf: input.asOf,
    verificationInsufficient: input.verificationInsufficient,
  })
}

export function runHrefForInvocation(runId: string, invocationId: string): string {
  return `/runs/${runId}?invocation=${invocationId}`
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? null
}
export * from './action-module-health.js'
