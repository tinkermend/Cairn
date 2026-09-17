import { z } from 'zod'
import {
  mapAssetRefSchema,
  mapConditionSnapshotSchema,
  mapEvidenceRefSchema,
  mapUtcInstantSchema,
  mapVerificationDimensionSchema,
  mapVerificationVerdictSchema,
} from './map-c0.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { entityIdSchema, jsonValueSchema } from './wire.js'

export const MAP_ASSETS_PROTOCOL = 'map-assets@1' as const
export const MAP_IDENTITY_RULE_VERSION = 'map-identity@1' as const
export const MAP_ROUTE_RULE_VERSION = 'map-route@1' as const
export const MAP_VERIFY_RULE_VERSION = 'map-verify@1' as const
export const DEFAULT_MAP_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000
export const MAP_PROJECTION_BATCH_MAX = 100
export const MAP_PROJECTION_BATCH_BUDGET_MS = 500
export const MAP_QUERY_LIMIT_DEFAULT = 10
export const MAP_QUERY_LIMIT_MAX = 50
export const MAP_QUERY_PAGE_CANDIDATE_MAX = 100

/** 默认知识视图不展示空白页、about: 页和采集占位 URL。 */
export function isNoiseMapRoute(routeTemplate: string | null | undefined): boolean {
  if (!routeTemplate?.trim()) return true
  const value = routeTemplate.trim().toLowerCase()
  if (value === 'nullblank' || value === 'null' || value === 'blank') return true
  if (value.startsWith('about:') || value.startsWith('chrome:') || value.startsWith('chrome-error:')) return true
  if (value.includes('unknown.invalid')) return true
  try {
    const url = new URL(routeTemplate)
    return url.protocol !== 'http:' && url.protocol !== 'https:'
  } catch {
    return true
  }
}

const technicalKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{8,192}$/, '技术键须为 8–192 位 [A-Za-z0-9:._-]')
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'digest 须为 64 位小写 hex')

export const MAP_PAGE_KINDS = ['top', 'frame_primary', 'composite'] as const
export type MapPageKind = (typeof MAP_PAGE_KINDS)[number]
export const mapPageKindSchema = z.enum(MAP_PAGE_KINDS)

export const MAP_IDENTITY_ACTIONS = ['merge', 'split', 'alias'] as const
export type MapIdentityAction = (typeof MAP_IDENTITY_ACTIONS)[number]
export const mapIdentityActionSchema = z.enum(MAP_IDENTITY_ACTIONS)

export const MAP_PROJECTION_STATUSES = ['active', 'shadow', 'ready', 'failed', 'superseded'] as const
export type MapProjectionStatus = (typeof MAP_PROJECTION_STATUSES)[number]
export const mapProjectionStatusSchema = z.enum(MAP_PROJECTION_STATUSES)

export const MAP_LIFECYCLES = [
  'DISCOVERED',
  'OBSERVED',
  'VERIFIED',
  'TRUSTED',
  'DEGRADED',
  'STALE',
  'RETIRED',
] as const
export type MapLifecycle = (typeof MAP_LIFECYCLES)[number]
export const mapLifecycleSchema = z.enum(MAP_LIFECYCLES)

export const MAP_WRITABLE_LIFECYCLES = ['DISCOVERED', 'OBSERVED', 'VERIFIED', 'DEGRADED'] as const
export type MapWritableLifecycle = (typeof MAP_WRITABLE_LIFECYCLES)[number]
export const mapWritableLifecycleSchema = z.enum(MAP_WRITABLE_LIFECYCLES)

export const MAP_MATCH_RESULTS = [
  'MATCH',
  'MISS',
  'AMBIGUOUS',
  'CONDITION_UNKNOWN',
  'STALE',
  'EVIDENCE_UNAVAILABLE',
] as const
export type MapMatchResult = (typeof MAP_MATCH_RESULTS)[number]
export const mapMatchResultSchema = z.enum(MAP_MATCH_RESULTS)

export const MAP_CONDITION_TRI = ['satisfied', 'unsatisfied', 'unknown'] as const
export type MapConditionTri = (typeof MAP_CONDITION_TRI)[number]
export const mapConditionTriSchema = z.enum(MAP_CONDITION_TRI)

export const MAP_REBUILD_COMPLETENESS = ['complete', 'partial', 'unknown'] as const
export type MapRebuildCompleteness = (typeof MAP_REBUILD_COMPLETENESS)[number]
export const mapRebuildCompletenessSchema = z.enum(MAP_REBUILD_COMPLETENESS)

export const MAP_ASSET_ERROR_CODES = [
  'MAP_RELEASE_NOT_FOUND',
  'MAP_PROJECTION_NOT_FOUND',
  'MAP_TARGET_MISMATCH',
  'MAP_PROJECTION_STALE',
  'MAP_PROJECTION_FAILED',
  'MAP_IDENTITY_STALE',
  'MAP_IDENTITY_CONFLICT',
  'MAP_IDENTITY_CYCLE',
  'MAP_SEAL_CONFLICT',
  'MAP_QUERY_VIEW_CONFLICT',
] as const
export type MapAssetErrorCode = (typeof MAP_ASSET_ERROR_CODES)[number]
export const mapAssetErrorCodeSchema = z.enum(MAP_ASSET_ERROR_CODES)

export const mapViewRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('projection'),
    projectionId: entityIdSchema,
    cursor: z.number().int().nonnegative().max(1_000_000_000),
    revision: z.number().int().nonnegative().max(1_000_000_000),
  }),
  z.strictObject({
    kind: z.literal('release'),
    releaseId: entityIdSchema,
    manifestDigest: digestSchema,
  }),
])
export type MapViewRef = z.infer<typeof mapViewRefSchema>

export const mapIdentityCommandSchema = z
  .strictObject({
    targetId: entityIdSchema,
    expectedIdentityRevision: z.number().int().nonnegative().max(1_000_000_000),
    commandKey: technicalKeySchema,
    action: mapIdentityActionSchema,
    oldRefs: z.array(mapAssetRefSchema).min(1).max(16),
    newRefs: z.array(mapAssetRefSchema).min(1).max(16),
    reason: z.string().trim().min(1).max(512),
    evidenceRefs: z.array(mapEvidenceRefSchema).max(16),
    actorId: entityIdSchema,
  })
  .superRefine((value, ctx) => {
    for (const [index, ref] of value.oldRefs.entries()) {
      if (ref.targetId !== value.targetId) {
        ctx.addIssue({ code: 'custom', path: ['oldRefs', index], message: 'oldRefs 不得跨 Target' })
      }
    }
    for (const [index, ref] of value.newRefs.entries()) {
      if (ref.targetId !== value.targetId) {
        ctx.addIssue({ code: 'custom', path: ['newRefs', index], message: 'newRefs 不得跨 Target' })
      }
    }
  })
export type MapIdentityCommand = z.infer<typeof mapIdentityCommandSchema>

export const mapDescriptorFeaturesSchema = z.strictObject({
  locators: targetDescriptorSchema.optional(),
  semanticName: z.string().trim().min(1).max(128).optional(),
  role: z.string().trim().min(1).max(64).optional(),
  testId: z.string().trim().min(1).max(128).optional(),
  regionKey: z.string().trim().min(1).max(64).optional(),
  rowPattern: z
    .strictObject({
      template: z.string().trim().min(1).max(256),
      bindingKey: z.string().trim().min(1).max(64).optional(),
    })
    .optional(),
})
export type MapDescriptorFeatures = z.infer<typeof mapDescriptorFeaturesSchema>

export const mapDimensionStatSchema = z.strictObject({
  dimension: mapVerificationDimensionSchema,
  verdict: mapVerificationVerdictSchema,
  confirmedCount: z.number().int().nonnegative().max(1_000_000),
  rejectedCount: z.number().int().nonnegative().max(1_000_000),
  unknownCount: z.number().int().nonnegative().max(1_000_000),
  lastVerifiedAt: mapUtcInstantSchema.optional(),
})
export type MapDimensionStat = z.infer<typeof mapDimensionStatSchema>

export const mapPageAllocationSchema = z.strictObject({
  kind: mapPageKindSchema,
  allocationKey: technicalKeySchema,
  routeTemplate: z.string().trim().min(1).max(512),
  frameKey: z.string().trim().min(1).max(64),
  reasons: z.array(z.string().trim().min(1).max(256)).max(16),
  matchResult: mapMatchResultSchema,
})
export type MapPageAllocation = z.infer<typeof mapPageAllocationSchema>

export const mapObjectAllocationSchema = z.strictObject({
  allocationKey: technicalKeySchema,
  pageAllocationKey: technicalKeySchema,
  regionKey: z.string().trim().min(1).max(64),
  stableToken: z.string().trim().min(1).max(64),
  reasons: z.array(z.string().trim().min(1).max(256)).max(16),
  matchResult: mapMatchResultSchema,
})
export type MapObjectAllocation = z.infer<typeof mapObjectAllocationSchema>

export const mapAssignmentPlanSchema = z.strictObject({
  observationId: entityIdSchema,
  pageAllocationKey: technicalKeySchema.optional(),
  objectAllocationKey: technicalKeySchema.optional(),
  matchResult: mapMatchResultSchema,
  reasons: z.array(z.string().trim().min(1).max(256)).max(16),
})
export type MapAssignmentPlan = z.infer<typeof mapAssignmentPlanSchema>

export const mapImplementationPlanSchema = z.strictObject({
  objectAllocationKey: technicalKeySchema,
  implementationKey: technicalKeySchema,
  condition: mapConditionSnapshotSchema,
})
export type MapImplementationPlan = z.infer<typeof mapImplementationPlanSchema>

export const mapDescriptorPlanSchema = z.strictObject({
  objectAllocationKey: technicalKeySchema,
  implementationKey: technicalKeySchema,
  features: mapDescriptorFeaturesSchema,
  condition: mapConditionSnapshotSchema,
})
export type MapDescriptorPlan = z.infer<typeof mapDescriptorPlanSchema>

export const mapAssetPlanSchema = z.strictObject({
  pageAllocationKey: technicalKeySchema.optional(),
  objectAllocationKey: technicalKeySchema.optional(),
  implementationKey: technicalKeySchema.optional(),
  lifecycle: mapWritableLifecycleSchema,
  importance: z.number().int().nonnegative().max(1_000).default(0),
  executable: z.boolean(),
  rejectReasons: z.array(z.string().trim().min(1).max(256)).max(16),
  dimensions: z.array(mapDimensionStatSchema).max(8),
  sampleCount: z.number().int().nonnegative().max(1_000_000),
  changeCount: z.number().int().nonnegative().max(1_000_000),
  lastVerifiedAt: mapUtcInstantSchema.optional(),
})
export type MapAssetPlan = z.infer<typeof mapAssetPlanSchema>

export const mapConflictPlanSchema = z.strictObject({
  conflictKey: technicalKeySchema,
  payload: jsonValueSchema,
})
export type MapConflictPlan = z.infer<typeof mapConflictPlanSchema>

export const mapProjectionPlanSchema = z.strictObject({
  protocol: z.literal(MAP_ASSETS_PROTOCOL),
  algorithmVersion: z.literal(MAP_IDENTITY_RULE_VERSION),
  pages: z.array(mapPageAllocationSchema).max(MAP_PROJECTION_BATCH_MAX),
  objects: z.array(mapObjectAllocationSchema).max(MAP_PROJECTION_BATCH_MAX),
  assignments: z.array(mapAssignmentPlanSchema).max(MAP_PROJECTION_BATCH_MAX),
  implementations: z.array(mapImplementationPlanSchema).max(MAP_PROJECTION_BATCH_MAX),
  descriptors: z.array(mapDescriptorPlanSchema).max(MAP_PROJECTION_BATCH_MAX),
  assets: z.array(mapAssetPlanSchema).max(200),
  conflicts: z.array(mapConflictPlanSchema).max(50),
  nextCursor: z.number().int().nonnegative().max(1_000_000_000),
  rebuildCompleteness: mapRebuildCompletenessSchema.optional(),
})
export type MapProjectionPlan = z.infer<typeof mapProjectionPlanSchema>

export const mapIdentityAliasSchema = z.strictObject({
  revision: z.number().int().positive().max(1_000_000_000),
  action: mapIdentityActionSchema,
  oldPageId: entityIdSchema.optional(),
  oldObjectId: entityIdSchema.optional(),
  oldAllocationKey: technicalKeySchema.optional(),
  newPageId: entityIdSchema.optional(),
  newObjectId: entityIdSchema.optional(),
  newAllocationKey: technicalKeySchema.optional(),
})
export type MapIdentityAlias = z.infer<typeof mapIdentityAliasSchema>

export const mapProjectionPageStateSchema = z.strictObject({
  id: entityIdSchema,
  allocationKey: technicalKeySchema,
  kind: mapPageKindSchema,
  routeTemplate: z.string().trim().min(1).max(512),
})
export type MapProjectionPageState = z.infer<typeof mapProjectionPageStateSchema>
export const mapProjectionObjectStateSchema = z.strictObject({
  id: entityIdSchema,
  allocationKey: technicalKeySchema,
  pageId: entityIdSchema,
  pageAllocationKey: technicalKeySchema,
  regionKey: z.string().trim().min(1).max(64).optional(),
  stableToken: z.string().trim().min(1).max(64).optional(),
})
export type MapProjectionObjectState = z.infer<typeof mapProjectionObjectStateSchema>
export const mapProjectionImplementationStateSchema = z.strictObject({
  objectId: entityIdSchema,
  objectAllocationKey: technicalKeySchema,
  implementationKey: technicalKeySchema,
  condition: mapConditionSnapshotSchema,
  currentDescriptorVersion: z.number().int().positive().max(1_000_000).optional(),
  changeCount: z.number().int().nonnegative().max(1_000_000),
})
export const mapProjectionDescriptorStateSchema = z.strictObject({
  objectId: entityIdSchema,
  implementationKey: technicalKeySchema,
  version: z.number().int().positive().max(1_000_000),
  features: mapDescriptorFeaturesSchema,
  condition: mapConditionSnapshotSchema,
  digest: digestSchema,
})
export const mapProjectionAssignmentStateSchema = z.strictObject({
  observationId: entityIdSchema,
  pageId: entityIdSchema.optional(),
  objectId: entityIdSchema.optional(),
  assignmentRevision: z.number().int().positive().max(1_000_000_000),
})
export const mapProjectionAssetStateSchema = z.strictObject({
  assetRefKey: technicalKeySchema,
  pageId: entityIdSchema.optional(),
  objectId: entityIdSchema.optional(),
  implementationKey: technicalKeySchema.optional(),
  descriptorVersion: z.number().int().positive().max(1_000_000).optional(),
  lifecycle: mapLifecycleSchema,
  importance: z.number().int().nonnegative().max(1_000),
  executable: z.boolean(),
  rejectReasons: z.array(z.string().trim().min(1).max(256)).max(16),
  dimensions: z.array(mapDimensionStatSchema).max(8),
  sampleCount: z.number().int().nonnegative().max(1_000_000),
  changeCount: z.number().int().nonnegative().max(1_000_000),
  lastVerifiedAt: mapUtcInstantSchema.optional(),
  features: mapDescriptorFeaturesSchema.optional(),
  condition: mapConditionSnapshotSchema.optional(),
})

export const mapProjectionStateSchema = z.strictObject({
  targetId: entityIdSchema,
  projectionId: entityIdSchema,
  generation: z.number().int().positive().max(1_000_000_000),
  status: mapProjectionStatusSchema,
  cursor: z.number().int().nonnegative().max(1_000_000_000),
  revision: z.number().int().nonnegative().max(1_000_000_000),
  identityRevision: z.number().int().nonnegative().max(1_000_000_000),
  sourceWatermark: z.number().int().nonnegative().max(1_000_000_000).optional(),
  rebuildCompleteness: mapRebuildCompletenessSchema.optional(),
  pages: z.array(mapProjectionPageStateSchema).max(10_000),
  objects: z.array(mapProjectionObjectStateSchema).max(20_000),
  implementations: z.array(mapProjectionImplementationStateSchema).max(20_000),
  descriptors: z.array(mapProjectionDescriptorStateSchema).max(40_000),
  assignments: z.array(mapProjectionAssignmentStateSchema).max(100_000),
  assets: z.array(mapProjectionAssetStateSchema).max(40_000),
  aliases: z.array(mapIdentityAliasSchema).max(10_000),
})
export type MapProjectionState = z.infer<typeof mapProjectionStateSchema>

export const mapQueryCluesSchema = z.strictObject({
  url: z.string().trim().min(1).max(512).optional(),
  role: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(128).optional(),
  region: z.string().trim().min(1).max(64).optional(),
})
export type MapQueryClues = z.infer<typeof mapQueryCluesSchema>

export const mapQueryRequestSchema = z
  .strictObject({
    targetId: entityIdSchema,
    view: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('projection'), projectionId: entityIdSchema }),
      z.strictObject({
        kind: z.literal('release'),
        releaseId: entityIdSchema,
        manifestDigest: digestSchema,
      }),
    ]),
    intent: z.string().trim().min(1).max(256).optional(),
    assetRef: mapAssetRefSchema.optional(),
    condition: mapConditionSnapshotSchema.optional(),
    clues: mapQueryCluesSchema.optional(),
    limit: z.number().int().min(1).max(MAP_QUERY_LIMIT_MAX).default(MAP_QUERY_LIMIT_DEFAULT),
    asOf: mapUtcInstantSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.assetRef && value.assetRef.targetId !== value.targetId) {
      ctx.addIssue({ code: 'custom', path: ['assetRef'], message: 'assetRef 不得跨 Target' })
    }
    if (value.condition && value.condition.targetId !== value.targetId) {
      ctx.addIssue({ code: 'custom', path: ['condition'], message: '查询条件不得跨 Target' })
    }
  })
export type MapQueryRequest = z.infer<typeof mapQueryRequestSchema>

export const mapQueryCandidateSchema = z.strictObject({
  assetRef: mapAssetRefSchema,
  viewRef: mapViewRefSchema,
  matchResult: mapMatchResultSchema,
  reasons: z.array(z.string().trim().min(1).max(256)).max(16),
  condition: mapConditionTriSchema,
  lifecycle: mapLifecycleSchema,
  freshUntil: mapUtcInstantSchema.optional(),
  executable: z.boolean(),
  rejectReasons: z.array(z.string().trim().min(1).max(256)).max(16),
  dimensions: z.array(mapDimensionStatSchema).max(8),
  evidenceAvailability: z.enum(['available', 'partial', 'unavailable']),
})
export type MapQueryCandidate = z.infer<typeof mapQueryCandidateSchema>

export const mapQueryResultSchema = z.strictObject({
  matchResult: mapMatchResultSchema,
  candidates: z.array(mapQueryCandidateSchema).max(MAP_QUERY_LIMIT_MAX),
  usedRefs: z.array(mapAssetRefSchema).max(MAP_QUERY_LIMIT_MAX),
  viewRef: mapViewRefSchema,
})
export type MapQueryResult = z.infer<typeof mapQueryResultSchema>

function token(value: string | undefined, fallback = 'u', max = 32): string {
  if (!value) return fallback
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return cleaned || fallback
}

export function mapImplementationKey(condition: {
  locale?: string
  viewport?: { category: string }
  permissionProfile?: { source: string; version: string }
  workspace?: string
  featureVersion?: string
}): string {
  const perm = condition.permissionProfile
    ? token(`${condition.permissionProfile.source}.${condition.permissionProfile.version}`, 'u', 40)
    : 'u'
  return [
    'impl',
    'v1',
    token(condition.locale),
    token(condition.viewport?.category),
    perm,
    token(condition.workspace),
    token(condition.featureVersion),
  ].join(':')
}

export function mapAssetRefKey(input: {
  pageId?: string
  objectId?: string
  implementationKey?: string
  descriptorVersion?: number
}): string {
  const key = [
    'p',
    input.pageId ?? 'x',
    'o',
    input.objectId ?? 'x',
    'i',
    input.implementationKey ?? 'x',
    'd',
    String(input.descriptorVersion ?? 0),
  ].join(':')
  if (key.length > 192) return `${key.slice(0, 192)}`
  return key
}

export function overlayMapFreshness(input: {
  lifecycle: MapLifecycle
  lastVerifiedAt?: string
  asOf: string
  freshnessMs?: number
}): { lifecycle: MapLifecycle; freshUntil?: string } {
  if (input.lifecycle === 'RETIRED' || input.lifecycle === 'TRUSTED' || input.lifecycle === 'DEGRADED') {
    return { lifecycle: input.lifecycle, freshUntil: input.lastVerifiedAt }
  }
  if (!input.lastVerifiedAt) return { lifecycle: input.lifecycle }
  const freshnessMs = input.freshnessMs ?? DEFAULT_MAP_FRESHNESS_MS
  const until = new Date(Date.parse(input.lastVerifiedAt) + freshnessMs).toISOString()
  if (Date.parse(input.asOf) > Date.parse(until)) {
    return { lifecycle: 'STALE', freshUntil: until }
  }
  return { lifecycle: input.lifecycle, freshUntil: until }
}
