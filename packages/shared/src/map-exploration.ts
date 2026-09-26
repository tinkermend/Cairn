import { syncSha256 } from './sha256-sync.js'
import { z } from 'zod'
import { accessPathMatches, canonicalOrigin, normalizeAccessPathPrefix, parseHttpUrl } from './access-scope.js'
import { mapAssetRefSchema } from './map-c0.js'
import { targetDescriptorSchema, type TargetDescriptor } from './target-descriptor.js'
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
  proposal: explorationProposalSchema.optional(),
  targetDescriptor: targetDescriptorSchema.optional(),
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
  const parsed = parseHttpUrl(url)
  if (!parsed) return false
  return allowlist.some((entry) => {
    const origin = canonicalOrigin(entry.origin)
    if (!origin || parsed.origin !== origin) return false
    const prefix = normalizeAccessPathPrefix(entry.pathPrefix)
    if (prefix.kind === 'invalid') return false
    if (prefix.kind === 'all') return true
    return accessPathMatches(parsed.pathname, prefix.value)
  })
}

// ==========================================
// 1. Target State Rule & 3-Level State Keys
// ==========================================

export const routeMatchRuleSchema = z.strictObject({
  pattern: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  ignoreQueryParams: z.array(z.string().min(1).max(64)).default([]),
})
export type RouteMatchRule = z.infer<typeof routeMatchRuleSchema>

export const stateVariantRuleSchema = z.strictObject({
  key: z.string().min(1).max(64),
  kind: z.enum(['list', 'detail', 'tab', 'other']),
  selector: z.string().min(1).max(256),
  exclusiveWith: z.array(z.string().min(1).max(64)).default([]),
})
export type StateVariantRule = z.infer<typeof stateVariantRuleSchema>

export const targetStateRuleSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  ruleVersion: z.number().int().min(1),
  routeMatches: z.array(routeMatchRuleSchema).default([]),
  readyAssertion: z
    .strictObject({
      selector: z.string().max(256).optional(),
      predicate: z.string().max(256).optional(),
    })
    .default({}),
  variants: z.array(stateVariantRuleSchema).default([]),
  allowedSpaHashPrefixes: z.array(z.string().min(1).max(64)).default(['#/']),
})
export type TargetStateRule = z.infer<typeof targetStateRuleSchema>

export function normalizeExplorationPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed === '/') return '/'
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.endsWith('/') && withLeading.length > 1 ? withLeading.slice(0, -1) : withLeading
}

export function buildPageKey(input: {
  targetId: string
  url: string
  frame?: string
  allowedSpaHashPrefixes?: readonly string[]
  ignoreQueryParams?: readonly string[]
}): string {
  const parsed = parseHttpUrl(input.url)
  const canonical = parsed ? canonicalOrigin(parsed.origin) ?? '' : ''
  const pathname = parsed ? normalizeExplorationPath(parsed.pathname) : ''
  let hashPart = ''
  if (parsed && parsed.hash && input.allowedSpaHashPrefixes) {
    for (const prefix of input.allowedSpaHashPrefixes) {
      if (parsed.hash.startsWith(prefix)) {
        hashPart = parsed.hash
        break
      }
    }
  }
  let queryPart = ''
  if (parsed && parsed.search) {
    const searchParams = new URLSearchParams(parsed.search)
    const ignore = new Set(input.ignoreQueryParams ?? [])
    const filtered: [string, string][] = []
    for (const [k, v] of searchParams.entries()) {
      if (!ignore.has(k)) filtered.push([k, v])
    }
    filtered.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    if (filtered.length > 0) {
      const q = new URLSearchParams(filtered)
      queryPart = `?${q.toString()}`
    }
  }
  const framePart = input.frame ? `|frame:${input.frame.trim()}` : ''
  return `page:${input.targetId}:${canonical}${pathname}${queryPart}${hashPart}${framePart}`
}

export function buildViewStateKey(input: {
  pageKey: string
  ruleVersion: number
  variantKey?: string
}): string {
  const variant = input.variantKey ? input.variantKey.trim() : 'default'
  return `view:${input.pageKey}:${variant}:v${input.ruleVersion}`
}

export function buildPresentationStateKey(input: {
  viewStateKey: string
  ancestorPath?: readonly string[]
}): string {
  const path = (input.ancestorPath ?? []).map((s) => s.trim()).filter(Boolean)
  const pathStr = path.length > 0 ? path.join(' > ') : 'root'
  const digest = syncSha256(pathStr).slice(0, 16)
  return `pres:${input.viewStateKey}:${digest}`
}

export function computeControlFingerprint(input: {
  role: string
  accessibleName: string
  ancestorPath?: readonly string[]
  frameSelector?: string
  targetUrl?: string
  locatorDescriptor?: TargetDescriptor
}): string {
  const path = (input.ancestorPath ?? []).join('>')
  const descriptorStr = input.locatorDescriptor ? JSON.stringify(input.locatorDescriptor) : ''
  const payload = [
    input.role.toLowerCase().trim(),
    input.accessibleName.trim(),
    path,
    input.frameSelector?.trim() ?? '',
    input.targetUrl?.trim() ?? '',
    descriptorStr,
  ].join('|')
  return syncSha256(payload).slice(0, 32)
}

export const UNSAFE_ACTION_PATTERN = /(提交|保存|删除|审批|支付|发布|上传|下载|导出|注销|退出|重启|重置|停止|启动|submit|save|delete|approve|pay|publish|upload|download|export|logout|signout|write|restart|reboot|reset|stop|shutdown)/i

export function isUnsafeActionText(text: string): boolean {
  return UNSAFE_ACTION_PATTERN.test(text)
}

export function sanitizeExplorationUrl(
  rawUrl: string,
  baseUrl?: string,
  options?: {
    allowedSpaHashPrefixes?: readonly string[]
    allowlist?: readonly ExplorationAllowlistEntry[]
  },
): { ok: boolean; canonicalUrl?: string; digest?: string; reason?: string } {
  let resolved: URL
  try {
    resolved = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL 格式无法解析' }
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { ok: false, reason: '非 HTTP(S) 协议' }
  }
  if (resolved.username || resolved.password) {
    return { ok: false, reason: 'URL 包含认证信息' }
  }
  if (UNSAFE_ACTION_PATTERN.test(resolved.pathname) || UNSAFE_ACTION_PATTERN.test(resolved.search)) {
    return { ok: false, reason: 'URL 疑似写入或危险动作' }
  }
  let allowedHash = ''
  if (resolved.hash && options?.allowedSpaHashPrefixes) {
    for (const prefix of options.allowedSpaHashPrefixes) {
      if (resolved.hash.startsWith(prefix)) {
        allowedHash = resolved.hash
        break
      }
    }
  }
  const searchParams = new URLSearchParams(resolved.search)
  const SENSITIVE_QUERY = /(token|auth|sign|ticket|session|secret|key|passwd|password)/i
  for (const key of [...searchParams.keys()]) {
    if (SENSITIVE_QUERY.test(key)) {
      searchParams.delete(key)
    }
  }
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : ''
  const canonicalUrl = `${resolved.origin}${normalizeExplorationPath(resolved.pathname)}${cleanSearch}${allowedHash}`
  if (options?.allowlist && !isUrlInExploreAllowlist(canonicalUrl, options.allowlist)) {
    return { ok: false, reason: '超出探索 allowlist 范围' }
  }
  const digest = syncSha256(canonicalUrl)
  return { ok: true, canonicalUrl, digest }
}

// ==========================================
// 2. Entry Request Profile
// ==========================================

export const requestPatternSchema = z.strictObject({
  method: z.string().min(1).max(16).default('GET'),
  origin: z.string().url(),
  path: z.string().min(1).max(512),
  isReadOnly: z.boolean().default(true),
  bodyShapeSummary: z.string().max(256).optional(),
})
export type RequestPattern = z.infer<typeof requestPatternSchema>

export const staticAssetRuleSchema = z.strictObject({
  origin: z.string().url(),
  pathPrefix: z.string().max(512).optional(),
})
export type StaticAssetRule = z.infer<typeof staticAssetRuleSchema>

export const exploreEntryRequestProfileSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  profileVersion: z.number().int().min(1),
  entryUrl: z.string().url().max(2048),
  allowedRedirects: z.array(z.string().url().max(2048)).default([]),
  initialDataRequests: z.array(requestPatternSchema).default([]),
  staticAssetRules: z.array(staticAssetRuleSchema).default([]),
  readOnlyRationale: z.string().min(1).max(512),
  revision: z.number().int().min(1),
  validUntil: utcInstantSchema,
})
export type ExploreEntryRequestProfile = z.infer<typeof exploreEntryRequestProfileSchema>

// ==========================================
// 3. Source State Recipe
// ==========================================

export const recipeActionKindSchema = z.enum([
  'navigate_known_url',
  'reveal',
  'ui_navigate',
  'readonly_detail',
])
export type RecipeActionKind = z.infer<typeof recipeActionKindSchema>

export const recipeStepSchema = z.strictObject({
  stepOrdinal: z.number().int().min(0).max(2),
  actionKind: recipeActionKindSchema,
  targetDescriptor: targetDescriptorSchema.optional(),
  url: z.string().url().max(2048).optional(),
  name: z.string().min(1).max(128),
  preStateAssertion: z
    .strictObject({
      viewStateKey: z.string().optional(),
      presentationStateKey: z.string().optional(),
      selector: z.string().max(256).optional(),
    })
    .optional(),
  postStateAssertion: z
    .strictObject({
      viewStateKey: z.string().optional(),
      presentationStateKey: z.string().optional(),
      selector: z.string().max(256).optional(),
    })
    .optional(),
  allowedRoutePattern: z.string().max(256).optional(),
  requestEnvelope: z.array(requestPatternSchema).default([]),
})
export type RecipeStep = z.infer<typeof recipeStepSchema>

export const exploreSourceStateRecipeSchema = z.strictObject({
  recipeId: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  safeEntryId: entityIdSchema,
  safeEntryVersion: z.number().int().min(1),
  recipeName: z.string().trim().min(1).max(128),
  revision: z.number().int().min(1),
  stateRuleVersion: z.number().int().min(1).default(1),
  status: z.enum(['draft', 'pending_review', 'approved', 'rejected', 'archived']),
  steps: z.array(recipeStepSchema).max(3),
  safetyBasis: z.strictObject({
    kind: z.string().min(1).max(64),
    summary: z.string().min(1).max(512),
    confirmedBy: entityIdSchema,
    confirmedAt: utcInstantSchema,
  }),
  usageLimit: z.number().int().min(1).max(50).default(5),
  usageRemaining: z.number().int().min(0).max(50).default(5),
  timeoutSeconds: z.number().int().min(10).max(180).default(90),
  isManualSeed: z.boolean().default(false),
  commandKey: z.string().min(8).max(128),
  createdBy: entityIdSchema,
  createdAt: utcInstantSchema,
  reviewedBy: entityIdSchema.optional(),
  reviewedAt: utcInstantSchema.optional(),
})
export type ExploreSourceStateRecipe = z.infer<typeof exploreSourceStateRecipeSchema>

// ==========================================
// 4. Explore Facts: Discovery, Review, Traversal, State
// ==========================================

export const candidateCategorySchema = z.enum([
  'explicit_url',
  'reveal',
  'opaque_navigation',
])
export type CandidateCategory = z.infer<typeof candidateCategorySchema>

export const discoveryStatusSchema = z.enum([
  'discovered',
  'pending_review',
  'approved',
  'rejected',
  'executed',
  'invalidated',
])
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>

export const exploreEvidenceStatusSchema = z.enum(['complete', 'partial', 'missing'])
export type ExploreEvidenceStatus = z.infer<typeof exploreEvidenceStatusSchema>

export const exploreDiscoverySchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  jobId: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  sourceStateId: entityIdSchema.optional(),
  sourcePresentationStateKey: z.string().min(1).max(512),
  controlFingerprint: z.string().min(1).max(128),
  accessibleName: z.string().max(256),
  role: z.string().max(64),
  ancestorPath: z.array(z.string().max(128)).max(16).default([]),
  frameSelector: z.string().max(256).default(''),
  candidateCategory: candidateCategorySchema,
  targetUrl: z.string().max(2048).optional(),
  targetDigest: z.string().max(64).optional(),
  targetHint: z.string().max(256),
  locatorDescriptor: targetDescriptorSchema.optional(),
  collectorVersion: z.string().max(64),
  evidenceStatus: exploreEvidenceStatusSchema,
  rejectionReason: z.string().max(256).optional(),
  status: discoveryStatusSchema,
  createdAt: utcInstantSchema,
})
export type ExploreDiscovery = z.infer<typeof exploreDiscoverySchema>

export const exploreReviewDecisionSchema = z.enum(['approved', 'rejected'])
export type ExploreReviewDecision = z.infer<typeof exploreReviewDecisionSchema>

export const exploreActionCategorySchema = z.enum([
  'direct_url_open',
  'reveal',
  'ui_activate',
])
export type ExploreActionCategory = z.infer<typeof exploreActionCategorySchema>

export const exploreReviewSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  jobId: entityIdSchema,
  discoveryId: entityIdSchema,
  reviewerId: entityIdSchema,
  decision: exploreReviewDecisionSchema,
  expectedRevision: z.number().int().min(0),
  actionCategory: exploreActionCategorySchema,
  securityBasis: z.string().min(1).max(512),
  allowedRoutePattern: z.string().max(256).optional(),
  requestEnvelope: z.array(requestPatternSchema).default([]),
  exactTargetUrl: z.string().url().max(2048).optional(),
  dispatchQuota: z.number().int().min(1).max(5).default(1),
  quotaRemaining: z.number().int().min(0).max(5).default(1),
  validUntil: utcInstantSchema,
  idempotencyKey: z.string().min(8).max(128),
  createdAt: utcInstantSchema,
})
export type ExploreReview = z.infer<typeof exploreReviewSchema>

export const traversalRelationTypeSchema = z.enum([
  'link_observed',
  'reveals_navigation',
  'ui_activate',
])
export type TraversalRelationType = z.infer<typeof traversalRelationTypeSchema>

export const exploreTraversalSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  jobId: entityIdSchema,
  runId: entityIdSchema,
  attemptId: entityIdSchema.optional(),
  discoveryId: entityIdSchema.optional(),
  reviewId: entityIdSchema.optional(),
  actionCategory: exploreActionCategorySchema,
  relationType: traversalRelationTypeSchema,
  fromStateId: entityIdSchema.optional(),
  fromPresentationStateKey: z.string().min(1).max(512),
  toStateId: entityIdSchema.optional(),
  toPresentationStateKey: z.string().max(512).optional(),
  guardDecision: z.enum(['allow', 'skip', 'stop']),
  guardReason: z.string().max(256),
  actionOutcome: z.enum(['completed', 'failed', 'unknown', 'not_dispatched']),
  locationVerify: z.enum(['support', 'deny', 'unknown']),
  actionVerify: z.enum(['support', 'deny', 'unknown']),
  pageChangeVerify: z.enum(['support', 'deny', 'unknown']),
  businessResult: z.literal('unknown'),
  promoted: z.literal(false),
  evidenceStatus: exploreEvidenceStatusSchema,
  errorMessage: z.string().max(512).optional(),
  createdAt: utcInstantSchema,
})
export type ExploreTraversal = z.infer<typeof exploreTraversalSchema>

export const exploreStateSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  jobId: entityIdSchema.optional(),
  runId: entityIdSchema.optional(),
  pageKey: z.string().min(1).max(512),
  viewStateKey: z.string().min(1).max(512),
  presentationStateKey: z.string().min(1).max(512),
  stateRuleVersion: z.number().int().min(1).default(1),
  readiness: z.enum(['ready', 'ambiguous', 'unknown']),
  snapshotData: z.record(z.string(), z.unknown()),
  evidenceRef: z.string().optional(),
  createdAt: utcInstantSchema,
})
export type ExploreState = z.infer<typeof exploreStateSchema>

// ==========================================
// 5. API DTO Schemas
// ==========================================

export const stateRecipeCreateBodySchema = z.strictObject({
  idempotencyKey: z.string().min(8).max(128),
  targetAccountId: entityIdSchema,
  safeEntryId: entityIdSchema,
  recipeName: z.string().trim().min(1).max(128),
  steps: z.array(recipeStepSchema).max(3),
  safetyBasisKind: z.string().min(1).max(64),
  safetySummary: z.string().trim().min(1).max(512),
  isManualSeed: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(10).max(180).default(90),
})
export type StateRecipeCreateBody = z.infer<typeof stateRecipeCreateBodySchema>

export const stateRecipeReviewBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(512),
  usageLimit: z.number().int().min(1).max(50).default(5),
})
export type StateRecipeReviewBody = z.infer<typeof stateRecipeReviewBodySchema>

export const candidateReviewBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(128),
  decision: exploreReviewDecisionSchema,
  actionCategory: exploreActionCategorySchema,
  securityBasis: z.string().trim().min(1).max(512),
  allowedRoutePattern: z.string().max(256).optional(),
  requestEnvelope: z.array(requestPatternSchema).default([]),
  validDurationHours: z.number().int().min(1).max(24).default(24),
})
export type CandidateReviewBody = z.infer<typeof candidateReviewBodySchema>

export const candidateRunBodySchema = z.strictObject({
  expectedReviewRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(128),
})
export type CandidateRunBody = z.infer<typeof candidateRunBodySchema>

export const reviewUnknownBodySchema = z.strictObject({
  decision: z.enum(['failed', 'cancelled']),
  reason: z.string().trim().min(1).max(512),
})
export type ReviewUnknownBody = z.infer<typeof reviewUnknownBodySchema>
