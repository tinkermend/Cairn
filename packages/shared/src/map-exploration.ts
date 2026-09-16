import { z } from 'zod'
import { mapAssetRefSchema } from './map-c0.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

const exploreContextKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/, 'context key 须为字母开头的标识符，最长 128')

export const MAP_EXPLORE_PROTOCOL = 'map-explore@1' as const
export const EXPLORATION_POLICY_SCHEMA_VERSION = 1 as const
export const EXPLORATION_MODES = ['allowlist', 'seeded_budget'] as const
export type ExplorationMode = (typeof EXPLORATION_MODES)[number]
export const explorationModeSchema = z.enum(EXPLORATION_MODES)

const originSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    } catch {
      return false
    }
  }, 'origin 须为 http(s) 且不含凭据')

export const explorationAllowlistEntrySchema = z.strictObject({
  origin: originSchema,
  pathPrefix: z.string().min(1).max(512).optional(),
})
export type ExplorationAllowlistEntry = z.infer<typeof explorationAllowlistEntrySchema>

export const explorationPolicySchema = z.strictObject({
  schemaVersion: z.literal(EXPLORATION_POLICY_SCHEMA_VERSION),
  policyVersion: z.number().int().min(1),
  exploreEnabled: z.boolean(),
  mode: explorationModeSchema,
  modelEnabled: z.boolean(),
  maxHopDepth: z.number().int().min(1).max(2).default(1),
  maxNewPages: z.number().int().min(1).max(10).default(1),
  maxCandidates: z.number().int().min(1).max(40).default(8),
  maxActions: z.number().int().min(1).max(20).default(1),
  maxSeconds: z.number().int().min(1).max(600).default(300),
  sliceWorkSeconds: z.number().int().min(5).max(20).default(20),
  allowlist: z.array(explorationAllowlistEntrySchema).max(16).default([]),
  seedRefs: z.array(mapAssetRefSchema).max(8).default([]),
})
export type ExplorationPolicy = z.infer<typeof explorationPolicySchema>

export const FACTORY_EXPLORATION_POLICY: ExplorationPolicy = explorationPolicySchema.parse({
  schemaVersion: 1,
  policyVersion: 1,
  exploreEnabled: false,
  mode: 'allowlist',
  modelEnabled: false,
})

export const explorationPolicyDtoSchema = z.strictObject({
  targetId: entityIdSchema,
  revision: z.number().int().min(0),
  policy: explorationPolicySchema,
  updatedAt: utcInstantSchema,
})
export type ExplorationPolicyDto = z.infer<typeof explorationPolicyDtoSchema>

export const explorationPolicyUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  exploreEnabled: z.boolean(),
  mode: explorationModeSchema,
  modelEnabled: z.boolean().default(false),
  allowlist: z.array(explorationAllowlistEntrySchema).max(16).default([]),
  seedRefs: z.array(mapAssetRefSchema).max(8).default([]),
  reason: z.string().trim().min(1).max(512),
})
export type ExplorationPolicyUpdateBody = z.infer<typeof explorationPolicyUpdateBodySchema>

export const explorationPreviewRequestSchema = z.strictObject({
  targetAccountId: entityIdSchema,
  entryId: entityIdSchema,
  selectedAssetRefs: z.array(mapAssetRefSchema).max(8).default([]),
})
export type ExplorationPreviewRequest = z.infer<typeof explorationPreviewRequestSchema>

export const explorationCreateBodySchema = z.strictObject({
  manualId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,100}$/, '探索手工键须为 8–100 位'),
  expectedExplorationRevision: z.number().int().min(0),
  targetAccountId: entityIdSchema,
  entryId: entityIdSchema,
  selectedAssetRefs: z.array(mapAssetRefSchema).max(8).default([]),
})
export type ExplorationCreateBody = z.infer<typeof explorationCreateBodySchema>

export const EXPLORATION_PROPOSAL_KINDS = ['navigate', 'reveal', 'stop'] as const
export const explorationProposalKindSchema = z.enum(EXPLORATION_PROPOSAL_KINDS)

export const explorationCandidateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.literal('navigate'),
  url: z.string().url().max(2048),
  reason: z.string().min(1).max(256),
})
export type ExplorationCandidate = z.infer<typeof explorationCandidateSchema>

export const observationBundleSchema = z.strictObject({
  currentUrl: z.string().max(2048).default(''),
  origin: z.string().max(2048).default(''),
  title: z.string().max(256).optional(),
  allowlisted: z.boolean(),
  allowlist: z.array(explorationAllowlistEntrySchema).max(16).default([]),
  candidates: z.array(explorationCandidateSchema).max(16),
  visited: z.array(z.string().max(2048)).max(16),
})
export type ObservationBundle = z.infer<typeof observationBundleSchema>

export const explorationProposalSchema = z.strictObject({
  kind: explorationProposalKindSchema,
  candidateId: z.string().min(1).max(128).optional(),
  url: z.string().url().max(2048).optional(),
  reason: z.string().min(1).max(256),
})
export type ExplorationProposal = z.infer<typeof explorationProposalSchema>

export const EXPLORATION_GUARD_DECISIONS = ['allow', 'skip', 'stop'] as const
export const explorationGuardDecisionSchema = z.strictObject({
  decision: z.enum(EXPLORATION_GUARD_DECISIONS),
  reason: z.string().min(1).max(256),
})
export type ExplorationGuardDecision = z.infer<typeof explorationGuardDecisionSchema>

export const EXPLORATION_ACTION_STATES = ['not_dispatched', 'dispatched', 'completed', 'unknown'] as const
export const explorationActionResultSchema = z.strictObject({
  state: z.enum(EXPLORATION_ACTION_STATES),
  url: z.string().max(2048).optional(),
  error: z.string().max(256).optional(),
})
export type ExplorationActionResult = z.infer<typeof explorationActionResultSchema>

export const EXPLORATION_VERIFY_DIMS = ['support', 'deny', 'unknown'] as const
export const explorationVerificationSchema = z.strictObject({
  location: z.enum(EXPLORATION_VERIFY_DIMS),
  action: z.enum(EXPLORATION_VERIFY_DIMS),
  pageChange: z.enum(EXPLORATION_VERIFY_DIMS),
  businessResult: z.enum(EXPLORATION_VERIFY_DIMS),
  promoted: z.literal(false),
  currentUrl: z.string().max(2048).optional(),
})
export type ExplorationVerification = z.infer<typeof explorationVerificationSchema>

export const mapObserveInputSchema = z.strictObject({
  mode: explorationModeSchema,
  allowlist: z.array(explorationAllowlistEntrySchema).max(16),
  seedUrls: z.array(z.string().url().max(2048)).max(8).default([]),
})
export type MapObserveInput = z.infer<typeof mapObserveInputSchema>

export const mapProposeInputSchema = z.strictObject({
  from: exploreContextKeySchema,
})
export type MapProposeInput = z.infer<typeof mapProposeInputSchema>

export const mapGuardedActionInputSchema = z.strictObject({
  from: exploreContextKeySchema,
})
export type MapGuardedActionInput = z.infer<typeof mapGuardedActionInputSchema>

export const mapVerifyInputSchema = z.strictObject({
  from: exploreContextKeySchema,
  observationFrom: exploreContextKeySchema,
})
export type MapVerifyInput = z.infer<typeof mapVerifyInputSchema>

export function mapExploreCommandKey(manualId: string): string {
  const key = `map:explore:${manualId}`
  if (key.length > 128) throw new Error('探索命令键超过 128')
  return key
}

export function isUrlInExploreAllowlist(
  url: string,
  allowlist: readonly ExplorationAllowlistEntry[],
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return false
  }
  return allowlist.some((entry) => {
    try {
      const origin = new URL(entry.origin).origin
      if (parsed.origin !== origin) return false
      if (!entry.pathPrefix) return true
      return parsed.pathname.startsWith(entry.pathPrefix)
    } catch {
      return false
    }
  })
}
