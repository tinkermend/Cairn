import { z } from 'zod'
import { locatorPlanSchema } from './locator-plan.js'
import type { LocatorPlan } from './locator-plan.js'
import type { PlatformConfigDocument } from './platform-config.js'
import type { TargetResolutionPolicy } from './resolution-policy.js'
import { candidateTrySchema } from './browser-command.js'
import { mapEvidenceRefSchema } from './map-c0.js'
import {
  FACTORY_RESOLUTION_CEILING,
  FACTORY_RESOLUTION_DEFAULT,
  mergeEffectiveResolution,
  policyAllowsAiRung,
  resolutionPolicySchema,
  type ResolutionPolicy,
} from './resolution-policy.js'
import { hasAiSteps, isAiStepType, waitKindSchema, type Step, type WaitKind } from './step.js'
import { nextCursorSchema } from './rbac.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const RESOLUTION_RUNGS = ['D', 'M', 'A'] as const
export type ResolutionRung = (typeof RESOLUTION_RUNGS)[number]
export const resolutionRungSchema = z.enum(RESOLUTION_RUNGS)

export const RESOLUTION_DECISIONS = ['deterministic', 'map', 'ai', 'failed'] as const
export type ResolutionDecisionKind = (typeof RESOLUTION_DECISIONS)[number]
export const resolutionDecisionKindSchema = z.enum(RESOLUTION_DECISIONS)

export const RESOLUTION_REASON_CODES = [
  'FRAME_UNSUPPORTED',
  'CEILING_CLOSED',
  'BUDGET_EXHAUSTED',
  'CROSS_CHECK_FAILED',
  'CROSS_CHECK_NOT_APPLICABLE',
  'AI_NOT_FOUND',
  'AI_AMBIGUOUS_POINT',
  'AI_HUNG',
  'AI_CALL_FAILED',
  'AI_DISABLED',
  'AI_CONFIG_INVALID',
  'WAIT_KIND_UNAVAILABLE',
  'CANCELLED',
  'LEASE_LOST',
  'SURFACE_LOST',
  'CAPABILITY_MISSING',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'PERSISTENCE_FAILED',
] as const
export type ResolutionReasonCode = (typeof RESOLUTION_REASON_CODES)[number]
export const resolutionReasonCodeSchema = z.enum(RESOLUTION_REASON_CODES)

export const RESOLUTION_CROSS_CHECKS = ['passed', 'failed', 'not_applicable', 'skipped'] as const
export type ResolutionCrossCheck = (typeof RESOLUTION_CROSS_CHECKS)[number]
export const resolutionCrossCheckSchema = z.enum(RESOLUTION_CROSS_CHECKS)

export const resolutionRungRecordSchema = z.strictObject({
  rung: resolutionRungSchema,
  aiRoute: z.enum(['text', 'vision']).optional(),
  outcomeClass: z.enum(['miss', 'ambiguous', 'hung', 'budget', 'cancelled', 'lease_lost', 'error']).optional(),
  outcome: z.string().min(1).max(64),
  spentMs: z.number().int().nonnegative().max(120_000),
  candidatesTried: z.array(candidateTrySchema).max(8).optional(),
  mapDecisionId: entityIdSchema.optional(),
  aiCallNs: z.array(z.number().int().positive()).max(8).optional(),
  center: z.tuple([z.number(), z.number()]).optional(),
  rectReliable: z.boolean().optional(),
  crossCheck: resolutionCrossCheckSchema.optional(),
})
export type ResolutionRungRecord = z.infer<typeof resolutionRungRecordSchema>

export const resolutionDecisionSchema = z.strictObject({
  decisionId: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema,
  attemptId: entityIdSchema,
  stepId: entityIdSchema,
  effectivePolicy: resolutionPolicySchema,
  plan: locatorPlanSchema.optional(),
  rungs: z.array(resolutionRungRecordSchema).max(4),
  decision: resolutionDecisionKindSchema,
  reasonCode: resolutionReasonCodeSchema.optional(),
  semanticDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidenceRefs: z.array(mapEvidenceRefSchema).max(16).default([]),
  createdAt: utcInstantSchema.optional(),
})
export type ResolutionDecision = z.infer<typeof resolutionDecisionSchema>

export const resolutionDecisionListQuerySchema = z.object({
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => (value === undefined ? 50 : typeof value === 'number' ? value : Number(value)))
    .pipe(z.number().int().min(1).max(100)),
  cursor: entityIdSchema.optional(),
})
export type ResolutionDecisionListQuery = z.infer<typeof resolutionDecisionListQuerySchema>

export const resolutionDecisionListResponseSchema = z.strictObject({
  items: z.array(resolutionDecisionSchema),
  nextCursor: nextCursorSchema,
})
export type ResolutionDecisionListResponse = z.infer<typeof resolutionDecisionListResponseSchema>

export const resolutionStatsQuerySchema = z.object({
  scenarioVersionId: entityIdSchema.optional(),
  targetId: entityIdSchema.optional(),
})
export type ResolutionStatsQuery = z.infer<typeof resolutionStatsQuerySchema>

export const resolutionStatsItemSchema = z.strictObject({
  stepId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  targetId: entityIdSchema,
  deterministic: z.number().int().nonnegative(),
  map: z.number().int().nonnegative(),
  ai: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  fallbackRate: z.number().min(0).max(1).nullable(),
  stepName: z.string().nullable().optional(),
})
export type ResolutionStatsItem = z.infer<typeof resolutionStatsItemSchema>

export const resolutionStatsResponseSchema = z.strictObject({
  items: z.array(resolutionStatsItemSchema).max(500),
})
export type ResolutionStatsResponse = z.infer<typeof resolutionStatsResponseSchema>

export const RESOLUTION_UNAVAILABLE_CODES = ['AI_DISABLED', 'AI_CONFIG_INVALID', 'CEILING_CLOSED'] as const
export type ResolutionUnavailableCode = (typeof RESOLUTION_UNAVAILABLE_CODES)[number]

export const WAIT_KINDS_AVAILABLE_NOW = ['time', 'visible', 'hidden', 'url', 'text'] as const satisfies readonly WaitKind[]

export const resolutionCapabilitiesSchema = z.strictObject({
  ceiling: resolutionPolicySchema,
  default: resolutionPolicySchema,
  aiRungAvailable: z.boolean(),
  textReady: z.boolean().optional(),
  visionReady: z.boolean().optional(),
  reasons: z.array(
    z.strictObject({
      code: z.enum(RESOLUTION_UNAVAILABLE_CODES),
      message: z.string().min(1).max(512),
    }),
  ),
  waitKindsAvailable: z.array(waitKindSchema).min(1).max(6),
})
export type ResolutionCapabilities = z.infer<typeof resolutionCapabilitiesSchema>

export type CompileResolutionContext = {
  ceiling: ResolutionPolicy
  default: ResolutionPolicy
  targetCeiling?: ResolutionPolicy
  targetPreference?: ResolutionPolicy
  documentResolution?: ResolutionPolicy
  documentLocatorPlan?: LocatorPlan
  locatorProtocol?: 2
  locatorDocument?: PlatformConfigDocument
  locatorTarget?: TargetResolutionPolicy | null
  aiRungAvailable?: boolean
  waitKindsAvailable?: readonly WaitKind[]
}

export const FACTORY_COMPILE_RESOLUTION: CompileResolutionContext = {
  ceiling: FACTORY_RESOLUTION_CEILING,
  default: FACTORY_RESOLUTION_DEFAULT,
  aiRungAvailable: false,
  waitKindsAvailable: WAIT_KINDS_AVAILABLE_NOW,
}

export function effectivePoliciesForSteps(
  steps: readonly { id: string; policy?: { resolution?: ResolutionPolicy } }[],
  ctx: CompileResolutionContext,
  browserAiEnabled = ctx.aiRungAvailable === true,
): Record<string, ResolutionPolicy> {
  const out: Record<string, ResolutionPolicy> = {}
  for (const step of steps) {
    out[step.id] = mergeEffectiveResolution({
      ceiling: ctx.ceiling,
      defaultResolution: ctx.default,
      targetCeiling: ctx.targetCeiling,
      targetPreference: ctx.targetPreference,
      document: ctx.documentResolution,
      step: step.policy?.resolution,
      browserAiEnabled,
    })
  }
  return out
}

export function snapshotNeedsBrowserAi(
  steps: readonly Step[],
  effectiveByStep?: Readonly<Record<string, ResolutionPolicy>>,
): boolean {
  const enabled = steps.filter((step) => !step.disabled)
  if (hasAiSteps(enabled)) return true
  if (!effectiveByStep) return false
  return enabled.some((step) => !isAiStepType(step.type) && policyAllowsAiRung(effectiveByStep[step.id] ?? 'deterministic_only'))
}

export function deriveAuthoringResolutionMode(input: {
  steps: readonly Step[]
  effectiveByStep: Readonly<Record<string, ResolutionPolicy>>
}): 'rule' | 'ai' | 'mixed' {
  const business = input.steps.filter((step) => step.type !== 'echo' && step.type !== 'delay' && step.type !== 'fail')
  const allAiSteps = business.length > 0 && business.every((step) => isAiStepType(step.type))
  const allSemanticOnly =
    business.length > 0 &&
    business.every((step) => {
      const target = targetOf(step)
      return !target || (target.candidates.length === 0 && Boolean(target.semantic))
    })
  if (allAiSteps || allSemanticOnly) return 'ai'
  const anyAiStep = business.some((step) => isAiStepType(step.type))
  const anyAiRung = business.some((step) => policyAllowsAiRung(input.effectiveByStep[step.id] ?? 'deterministic_only'))
  const anySemanticOnly = business.some((step) => {
    const target = targetOf(step)
    return Boolean(target && target.candidates.length === 0 && target.semantic)
  })
  if (anyAiStep || anyAiRung || anySemanticOnly) return 'mixed'
  return 'rule'
}

function targetOf(step: Step): { candidates: { by: string }[]; semantic?: string } | undefined {
  if (!('input' in step) || !step.input || typeof step.input !== 'object' || !('target' in step.input)) return undefined
  const target = step.input.target
  if (!target || typeof target !== 'object' || !('candidates' in target)) return undefined
  return target as { candidates: { by: string }[]; semantic?: string }
}
