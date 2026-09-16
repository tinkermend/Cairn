import { z } from 'zod'
import {
  mapDimensionStatSchema,
  mapIdentityActionSchema,
  mapIdentityAliasSchema,
  mapLifecycleSchema,
  mapMatchResultSchema,
  mapProjectionStatusSchema,
  mapQueryCluesSchema,
  MAP_QUERY_LIMIT_DEFAULT,
  MAP_QUERY_LIMIT_MAX,
} from './map-assets.js'
import {
  mapAssetRefSchema,
  mapConditionSnapshotSchema,
  mapEvidenceRefSchema,
  mapUtcInstantSchema,
} from './map-c0.js'
import { mapReleaseSchema } from './map-release.js'
import { nextCursorSchema } from './rbac.js'
import { scenarioDocumentSchema } from './scenario.js'
import { entityIdSchema } from './wire.js'

export const MAP_LIST_LIMIT_DEFAULT = 20
export const MAP_LIST_LIMIT_MAX = 100

const technicalKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{8,192}$/, '技术键须为 8–192 位 [A-Za-z0-9:._-]')
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'digest 须为 64 位小写 hex')
const reasonSchema = z.string().trim().min(1).max(512)

export const MAP_GOVERNANCE_ERROR_CODES = [
  'MAP_NOT_FOUND',
  'MAP_FORBIDDEN',
  'MAP_REVISION_CONFLICT',
  'MAP_IDEMPOTENCY_CONFLICT',
  'MAP_PROJECTION_PENDING',
  'MAP_RELEASE_INVALID',
  'MAP_REFERENCE_UNRESOLVED',
  'MAP_CURSOR_EXPIRED',
  'MAP_CONSUMER_UNAVAILABLE',
  'MAP_CONSUMPTION_NOT_ELIGIBLE',
  'MAP_DECISION_PERSISTENCE_FAILED',
  'MAP_RELEASE_NOT_PUBLISHED',
  'MAP_RELEASE_WITHDRAWN',
] as const
export type MapGovernanceErrorCode = (typeof MAP_GOVERNANCE_ERROR_CODES)[number]
export const mapGovernanceErrorCodeSchema = z.enum(MAP_GOVERNANCE_ERROR_CODES)

export const MAP_GOVERNANCE_COMMAND_KINDS = [
  'confirm_semantics',
  'correct_identity',
  'retire',
  'restore',
] as const
export type MapGovernanceCommandKind = (typeof MAP_GOVERNANCE_COMMAND_KINDS)[number]
export const mapGovernanceCommandKindSchema = z.enum(MAP_GOVERNANCE_COMMAND_KINDS)

export const MAP_GOVERNANCE_COMMAND_STATUSES = [
  'pending',
  'applying',
  'applied',
  'rejected',
  'failed',
] as const
export type MapGovernanceCommandStatus = (typeof MAP_GOVERNANCE_COMMAND_STATUSES)[number]
export const mapGovernanceCommandStatusSchema = z.enum(MAP_GOVERNANCE_COMMAND_STATUSES)

export const MAP_PUBLICATION_STATUSES = ['published', 'withdrawn'] as const
export type MapPublicationStatus = (typeof MAP_PUBLICATION_STATUSES)[number]
export const mapPublicationStatusSchema = z.enum(MAP_PUBLICATION_STATUSES)

export const MAP_BINDING_BASES = ['explicit_user', 'compiled_action', 'accepted_proposal'] as const
export type MapBindingBasis = (typeof MAP_BINDING_BASES)[number]
export const mapBindingBasisSchema = z.enum(MAP_BINDING_BASES)

export const MAP_BINDING_SCOPE_KINDS = ['draft', 'version', 'page_context'] as const
export type MapBindingScopeKind = (typeof MAP_BINDING_SCOPE_KINDS)[number]
export const mapBindingScopeKindSchema = z.enum(MAP_BINDING_SCOPE_KINDS)

export const MAP_IMPACT_GRADES = ['confirmed_reference', 'potential_match', 'unknown_coverage'] as const
export type MapImpactGrade = (typeof MAP_IMPACT_GRADES)[number]
export const mapImpactGradeSchema = z.enum(MAP_IMPACT_GRADES)

export const MAP_REFERENCE_RESOLUTIONS = ['resolved', 'pending_confirmation'] as const
export type MapReferenceResolution = (typeof MAP_REFERENCE_RESOLUTIONS)[number]
export const mapReferenceResolutionSchema = z.enum(MAP_REFERENCE_RESOLUTIONS)

export const MAP_OVERLAY_LIFECYCLES = ['TRUSTED', 'RETIRED'] as const
export type MapOverlayLifecycle = (typeof MAP_OVERLAY_LIFECYCLES)[number]
export const mapOverlayLifecycleSchema = z.enum(MAP_OVERLAY_LIFECYCLES)

export const MAP_SCAN_STATUSES = ['idle', 'running', 'complete'] as const
export type MapScanStatus = (typeof MAP_SCAN_STATUSES)[number]
export const mapScanStatusSchema = z.enum(MAP_SCAN_STATUSES)

const optionalQueryString = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().min(1).optional(),
)

const conditionSnapshotQuerySchema = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}, mapConditionSnapshotSchema.optional())

export const mapListQuerySchema = z
  .object({
    projectionId: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      entityIdSchema.optional(),
    ),
    releaseId: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      entityIdSchema.optional(),
    ),
    manifestDigest: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      digestSchema.optional(),
    ),
    search: optionalQueryString,
    assetRefKey: optionalQueryString,
    scenarioId: entityIdSchema.optional(),
    stepId: entityIdSchema.optional(),
    scopeKind: mapBindingScopeKindSchema.optional(),
    lifecycle: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      mapLifecycleSchema.optional(),
    ),
    conditionSnapshot: conditionSnapshotQuerySchema,
    cursor: optionalQueryString,
    limit: z.preprocess(
      (value) => (value === '' || value === undefined || value === null ? MAP_LIST_LIMIT_DEFAULT : value),
      z.coerce.number().int().min(1).max(MAP_LIST_LIMIT_MAX),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.projectionId && value.releaseId) {
      ctx.addIssue({ code: 'custom', path: ['releaseId'], message: 'projection 与 release 不能混读' })
    }
    if (value.manifestDigest && !value.releaseId) {
      ctx.addIssue({ code: 'custom', path: ['manifestDigest'], message: 'manifestDigest 只能与 releaseId 一起使用' })
    }
  })
export type MapListQuery = z.infer<typeof mapListQuerySchema>

export const mapMatchQuerySchema = z
  .object({
    projectionId: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      entityIdSchema.optional(),
    ),
    releaseId: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      entityIdSchema.optional(),
    ),
    manifestDigest: z.preprocess(
      (value) => (value === '' || value === null ? undefined : value),
      digestSchema.optional(),
    ),
    intent: optionalQueryString,
    pageId: z.preprocess((value) => (value === '' || value === null ? undefined : value), entityIdSchema.optional()),
    objectId: z.preprocess((value) => (value === '' || value === null ? undefined : value), entityIdSchema.optional()),
    implementationKey: optionalQueryString,
    conditionSnapshot: conditionSnapshotQuerySchema,
    clues: z.preprocess((value) => {
      if (value === '' || value === null || value === undefined) return undefined
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    }, mapQueryCluesSchema.optional()),
    limit: z.preprocess(
      (value) => (value === '' || value === undefined || value === null ? MAP_QUERY_LIMIT_DEFAULT : value),
      z.coerce.number().int().min(1).max(MAP_QUERY_LIMIT_MAX),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.manifestDigest && !value.releaseId) {
      ctx.addIssue({ code: 'custom', path: ['manifestDigest'], message: 'manifestDigest 只能与 releaseId 一起使用' })
    }
    if (value.projectionId && value.releaseId) {
      ctx.addIssue({ code: 'custom', path: ['releaseId'], message: 'projection 与 release 不能混读' })
    }
  })
export type MapMatchQuery = z.infer<typeof mapMatchQuerySchema>

export const mapViewMetaSchema = z.strictObject({
  viewRef: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('missing') }),
    z.strictObject({
      kind: z.literal('projection'),
      projectionId: entityIdSchema,
      cursor: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal('release'),
      releaseId: entityIdSchema,
      manifestDigest: digestSchema,
    }),
  ]),
  sourceWatermark: z.number().int().nonnegative().optional(),
  policyVersion: z.string().min(1).max(64).optional(),
  identityRevision: z.number().int().nonnegative(),
  governanceRevision: z.number().int().nonnegative(),
  publicationRevision: z.number().int().nonnegative(),
  computedAt: mapUtcInstantSchema,
})
export type MapViewMeta = z.infer<typeof mapViewMetaSchema>

export const mapAssetListItemSchema = z.strictObject({
  assetRef: mapAssetRefSchema,
  assetRefKey: technicalKeySchema,
  name: z.string().trim().min(1).max(128).optional(),
  routeTemplate: z.string().trim().min(1).max(512).optional(),
  lifecycle: mapLifecycleSchema,
  overlayLifecycle: mapOverlayLifecycleSchema.optional(),
  dimensions: z.array(mapDimensionStatSchema).max(8),
  unknownFields: z.array(z.string().trim().min(1).max(64)).max(8),
  changeCount: z.number().int().nonnegative(),
  lastVerifiedAt: mapUtcInstantSchema.optional(),
  evidenceAvailability: z.enum(['available', 'partial', 'unavailable']),
})
export type MapAssetListItem = z.infer<typeof mapAssetListItemSchema>

export const mapAssetListResponseSchema = z.strictObject({
  items: z.array(mapAssetListItemSchema),
  nextCursor: nextCursorSchema,
  view: mapViewMetaSchema,
})
export type MapAssetListResponse = z.infer<typeof mapAssetListResponseSchema>

export const mapSummaryResponseSchema = z.strictObject({
  view: mapViewMetaSchema,
  projectionStatus: z.enum(['missing', 'active', 'shadow', 'ready', 'failed', 'superseded']),
  rebuildStatus: z.enum(['shadow', 'ready', 'failed']).optional(),
  rebuildProjectionId: entityIdSchema.optional(),
  rebuildCompleteness: z.enum(['complete', 'partial', 'unknown']).optional(),
  pageCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  unknownConditionCount: z.number().int().nonnegative(),
  changeCount: z.number().int().nonnegative(),
  publishedReleaseId: entityIdSchema.optional(),
  publicationStatus: mapPublicationStatusSchema.optional(),
})
export type MapSummaryResponse = z.infer<typeof mapSummaryResponseSchema>

export const mapImplementationViewSchema = z.strictObject({
  implementationKey: technicalKeySchema,
  descriptorVersion: z.number().int().positive().optional(),
  conditionUnknownFields: z.array(z.string().trim().min(1).max(64)).max(8),
  semanticName: z.string().trim().min(1).max(128).optional(),
  role: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(1).max(64).optional(),
  workspace: z.string().trim().min(1).max(64).optional(),
  conditionSnapshot: mapConditionSnapshotSchema.optional(),
})
export type MapImplementationView = z.infer<typeof mapImplementationViewSchema>

export const mapIdentityHistoryItemSchema = z.strictObject({
  revision: z.number().int().positive(),
  action: mapIdentityActionSchema,
  reason: reasonSchema,
  createdAt: mapUtcInstantSchema,
  oldRefs: z.array(mapAssetRefSchema).max(16),
  newRefs: z.array(mapAssetRefSchema).max(16),
})
export type MapIdentityHistoryItem = z.infer<typeof mapIdentityHistoryItemSchema>

export const mapAssetDetailSchema = mapAssetListItemSchema.extend({
  implementations: z.array(mapImplementationViewSchema).max(64),
  identityHistory: z.array(mapIdentityHistoryItemSchema).max(100),
  applicability: z.enum(['satisfied', 'unsatisfied', 'unknown']).optional(),
  observationCoverage: z.enum(['observed', 'partial', 'unknown']).optional(),
  view: mapViewMetaSchema,
})
export type MapAssetDetail = z.infer<typeof mapAssetDetailSchema>

export const mapFactViewSchema = z.strictObject({
  factType: z.enum(['observation', 'verification']),
  factId: entityIdSchema,
  ingestSeq: z.number().int().nonnegative(),
  contentAvailability: z.enum(['available', 'expired', 'missing']),
  sourceAvailability: z.enum(['live', 'deleted', 'unknown']),
  sourceType: z.string().min(1).max(64).optional(),
  payload: z.unknown().optional(),
})
export type MapFactView = z.infer<typeof mapFactViewSchema>

export const mapChangeItemSchema = z.strictObject({
  kind: z.enum(['asset', 'conflict']),
  assetRefKey: technicalKeySchema.optional(),
  conflictKey: technicalKeySchema.optional(),
  changeCount: z.number().int().nonnegative().optional(),
  status: z.string().min(1).max(32).optional(),
  payload: z.unknown().optional(),
})
export type MapChangeItem = z.infer<typeof mapChangeItemSchema>

export const mapChangeListResponseSchema = z.strictObject({
  items: z.array(mapChangeItemSchema),
  nextCursor: nextCursorSchema,
  view: mapViewMetaSchema,
})
export type MapChangeListResponse = z.infer<typeof mapChangeListResponseSchema>

export const mapGovernanceCommandSchema = z.strictObject({
  commandId: entityIdSchema,
  idempotencyKey: technicalKeySchema,
  targetId: entityIdSchema,
  kind: mapGovernanceCommandKindSchema,
  status: mapGovernanceCommandStatusSchema,
  expectedRevision: z.number().int().nonnegative(),
  resultRevision: z.number().int().nonnegative().optional(),
  reason: reasonSchema,
  payload: z.unknown(),
  createdAt: mapUtcInstantSchema,
})
export type MapGovernanceCommandDto = z.infer<typeof mapGovernanceCommandSchema>

export const mapCorrectIdentityPayloadSchema = z.strictObject({
  action: mapIdentityActionSchema,
  oldRefs: z.array(mapAssetRefSchema).min(1).max(16),
  newRefs: z.array(mapAssetRefSchema).min(1).max(16),
})
export type MapCorrectIdentityPayload = z.infer<typeof mapCorrectIdentityPayloadSchema>

export const mapGovernancePreviewBodySchema = z
  .strictObject({
    kind: mapGovernanceCommandKindSchema,
    reason: reasonSchema,
    expectedIdentityRevision: z.number().int().nonnegative().max(1_000_000_000).optional(),
    expectedGovernanceRevision: z.number().int().nonnegative().max(1_000_000_000).optional(),
    assetRef: mapAssetRefSchema.optional(),
    payload: mapCorrectIdentityPayloadSchema.optional(),
    evidenceRefs: z.array(mapEvidenceRefSchema).max(16).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'correct_identity') {
      if (value.expectedIdentityRevision === undefined) {
        ctx.addIssue({ code: 'custom', path: ['expectedIdentityRevision'], message: '身份纠正必须带 expectedIdentityRevision' })
      }
      if (!value.payload) {
        ctx.addIssue({ code: 'custom', path: ['payload'], message: '身份纠正必须带 merge/split/alias 载荷' })
      }
    } else {
      if (value.expectedGovernanceRevision === undefined) {
        ctx.addIssue({ code: 'custom', path: ['expectedGovernanceRevision'], message: '治理 overlay 必须带 expectedGovernanceRevision' })
      }
      if (!value.assetRef) {
        ctx.addIssue({ code: 'custom', path: ['assetRef'], message: '治理 overlay 必须带 assetRef' })
      }
    }
  })
export type MapGovernancePreviewBody = z.infer<typeof mapGovernancePreviewBodySchema>

export const mapGovernanceCommandBodySchema = z
  .strictObject({
    kind: mapGovernanceCommandKindSchema,
    reason: reasonSchema,
    expectedIdentityRevision: z.number().int().nonnegative().max(1_000_000_000).optional(),
    expectedGovernanceRevision: z.number().int().nonnegative().max(1_000_000_000).optional(),
    assetRef: mapAssetRefSchema.optional(),
    payload: mapCorrectIdentityPayloadSchema.optional(),
    evidenceRefs: z.array(mapEvidenceRefSchema).max(16).default([]),
    idempotencyKey: technicalKeySchema,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'correct_identity') {
      if (value.expectedIdentityRevision === undefined) {
        ctx.addIssue({ code: 'custom', path: ['expectedIdentityRevision'], message: '身份纠正必须带 expectedIdentityRevision' })
      }
      if (!value.payload) {
        ctx.addIssue({ code: 'custom', path: ['payload'], message: '身份纠正必须带 merge/split/alias 载荷' })
      }
    } else {
      if (value.expectedGovernanceRevision === undefined) {
        ctx.addIssue({ code: 'custom', path: ['expectedGovernanceRevision'], message: '治理 overlay 必须带 expectedGovernanceRevision' })
      }
      if (!value.assetRef) {
        ctx.addIssue({ code: 'custom', path: ['assetRef'], message: '治理 overlay 必须带 assetRef' })
      }
    }
  })
export type MapGovernanceCommandBody = z.infer<typeof mapGovernanceCommandBodySchema>

export const mapGovernancePreviewResponseSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  kind: mapGovernanceCommandKindSchema,
  affectedAssetKeys: z.array(technicalKeySchema).max(64),
  visibleReferenceCount: z.number().int().nonnegative(),
  pendingConfirmationCount: z.number().int().nonnegative(),
  restricted: z.boolean(),
  rejectReasons: z.array(z.string().trim().min(1).max(256)).max(16),
})
export type MapGovernancePreviewResponse = z.infer<typeof mapGovernancePreviewResponseSchema>

export const mapSealPublishBodySchema = z.strictObject({
  projectionId: entityIdSchema,
  expectedProjectionRevision: z.number().int().nonnegative().max(1_000_000_000),
  expectedPublicationRevision: z.number().int().nonnegative().max(1_000_000_000),
  idempotencyKey: technicalKeySchema,
  reason: reasonSchema,
  selectedAssetKeys: z.array(technicalKeySchema).max(10_000).optional(),
})
export type MapSealPublishBody = z.infer<typeof mapSealPublishBodySchema>

export const mapPublicationBodySchema = z.strictObject({
  expectedPublicationRevision: z.number().int().nonnegative().max(1_000_000_000),
  idempotencyKey: technicalKeySchema,
  reason: reasonSchema,
})
export type MapPublicationBody = z.infer<typeof mapPublicationBodySchema>

export const mapReleasePublicationSchema = z.strictObject({
  release: mapReleaseSchema,
  publicationStatus: mapPublicationStatusSchema.optional(),
  publicationRevision: z.number().int().nonnegative(),
  reason: reasonSchema.optional(),
  publishedAt: mapUtcInstantSchema.optional(),
  withdrawnAt: mapUtcInstantSchema.optional(),
})
export type MapReleasePublication = z.infer<typeof mapReleasePublicationSchema>

export const mapReleaseListResponseSchema = z.strictObject({
  items: z.array(mapReleasePublicationSchema),
  nextCursor: nextCursorSchema,
  publicationRevision: z.number().int().nonnegative(),
})
export type MapReleaseListResponse = z.infer<typeof mapReleaseListResponseSchema>

export const mapBindingScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('draft'), revision: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('version'), scenarioVersionId: entityIdSchema }),
  z.strictObject({ kind: z.literal('page_context') }),
])
export type MapBindingScope = z.infer<typeof mapBindingScopeSchema>

export const mapScenarioBindingSchema = z.strictObject({
  bindingId: entityIdSchema,
  targetId: entityIdSchema,
  scenarioId: entityIdSchema,
  stepId: entityIdSchema.optional(),
  assetRef: mapAssetRefSchema,
  assetRefKey: technicalKeySchema,
  basis: mapBindingBasisSchema,
  scope: mapBindingScopeSchema,
  descriptorDigest: digestSchema.optional(),
  confirmedBy: entityIdSchema.optional(),
  confirmedAt: mapUtcInstantSchema.optional(),
  resolution: mapReferenceResolutionSchema,
  sourceRef: z.unknown().optional(),
})
export type MapScenarioBindingDto = z.infer<typeof mapScenarioBindingSchema>

export const mapScenarioBindingBodySchema = z
  .strictObject({
    scenarioId: entityIdSchema,
    stepId: entityIdSchema.optional(),
    assetRef: mapAssetRefSchema,
    basis: mapBindingBasisSchema.default('explicit_user'),
    scopeKind: mapBindingScopeKindSchema.default('draft'),
    scenarioVersionId: entityIdSchema.optional(),
    expectedDraftRevision: z.number().int().nonnegative().max(1_000_000_000),
    descriptorDigest: digestSchema.optional(),
    sourceRef: z.unknown().optional(),
    document: scenarioDocumentSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scopeKind === 'version' && (!value.scenarioVersionId || value.document)) {
      ctx.addIssue({ code: 'custom', path: ['scenarioVersionId'], message: '历史注释必须指定版本，且不能保存草稿' })
    }
    if (value.scopeKind !== 'page_context' && !value.stepId) {
      ctx.addIssue({ code: 'custom', path: ['stepId'], message: '步骤绑定必须提供 stepId' })
    }
    if (value.scopeKind === 'page_context' && value.stepId) {
      ctx.addIssue({ code: 'custom', path: ['stepId'], message: '页面级引用不能虚构 stepId' })
    }
  })
export type MapScenarioBindingBody = z.infer<typeof mapScenarioBindingBodySchema>

export const mapBindingRemoveBodySchema = z.strictObject({
  expectedDraftRevision: z.number().int().nonnegative().max(1_000_000_000),
})
export type MapBindingRemoveBody = z.infer<typeof mapBindingRemoveBodySchema>

export const mapBindingRemovedSchema = z.strictObject({
  bindingId: entityIdSchema,
  removed: z.boolean(),
})
export type MapBindingRemoved = z.infer<typeof mapBindingRemovedSchema>

export const mapReferenceItemSchema = z.strictObject({
  grade: mapImpactGradeSchema,
  bindingId: entityIdSchema.optional(),
  scenarioId: entityIdSchema.optional(),
  scenarioName: z.string().trim().min(1).max(128).optional(),
  stepId: entityIdSchema.optional(),
  assetRefKey: technicalKeySchema.optional(),
  assetRef: mapAssetRefSchema.optional(),
  resolution: mapReferenceResolutionSchema.optional(),
  scope: mapBindingScopeSchema.optional(),
  reasons: z.array(z.string().trim().min(1).max(256)).max(16),
})
export type MapReferenceItem = z.infer<typeof mapReferenceItemSchema>

export const mapReferenceListResponseSchema = z.strictObject({
  items: z.array(mapReferenceItemSchema),
  nextCursor: nextCursorSchema,
  restricted: z.boolean(),
  scanStatus: mapScanStatusSchema,
  scanCompleteness: z.enum(['complete', 'partial', 'unknown']),
})
export type MapReferenceListResponse = z.infer<typeof mapReferenceListResponseSchema>

export const mapImpactQuerySchema = z.object({
  assetRefKey: optionalQueryString,
  fromReleaseId: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    entityIdSchema.optional(),
  ),
  toReleaseId: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    entityIdSchema.optional(),
  ),
  cursor: optionalQueryString,
  limit: z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? MAP_LIST_LIMIT_DEFAULT : value),
    z.coerce.number().int().min(1).max(MAP_LIST_LIMIT_MAX),
  ),
})
export type MapImpactQuery = z.infer<typeof mapImpactQuerySchema>

export const mapImpactListResponseSchema = z.strictObject({
  items: z.array(mapReferenceItemSchema),
  nextCursor: nextCursorSchema,
  restricted: z.boolean(),
  notes: z.array(z.string().trim().min(1).max(256)).max(16),
})
export type MapImpactListResponse = z.infer<typeof mapImpactListResponseSchema>

export const mapDiagnosisClueSchema = z.strictObject({
  dimension: z.enum(['identity', 'locator', 'action', 'business']),
  verdict: z.enum(['confirmed', 'rejected', 'unknown', 'not_observed']),
  count: z.number().int().nonnegative(),
  notes: z.array(z.string().trim().min(1).max(256)).max(16),
})
export type MapDiagnosisClue = z.infer<typeof mapDiagnosisClueSchema>

export const mapRunCluesResponseSchema = z.strictObject({
  runId: entityIdSchema,
  targetId: entityIdSchema,
  clues: z.array(mapDiagnosisClueSchema).max(8),
  hypotheses: z.array(z.string().trim().min(1).max(256)).max(16),
  counterExamples: z.array(z.string().trim().min(1).max(256)).max(16),
  gaps: z.array(z.string().trim().min(1).max(256)).max(16),
})
export type MapRunCluesResponse = z.infer<typeof mapRunCluesResponseSchema>

export const mapRebuildResponseSchema = z.strictObject({
  projectionId: entityIdSchema,
  status: mapProjectionStatusSchema,
})
export type MapRebuildResponse = z.infer<typeof mapRebuildResponseSchema>

export const mapScanStartResponseSchema = z.strictObject({
  status: mapScanStatusSchema,
  completeness: z.enum(['complete', 'partial', 'unknown']),
  scannedCount: z.number().int().nonnegative(),
})
export type MapScanStartResponse = z.infer<typeof mapScanStartResponseSchema>

export function deriveMapEvidenceAvailability(input: {
  sealed: boolean
  rebuildCompleteness?: string | null
  projectionStatus?: string
  lastVerifiedAt?: string
  changeCount: number
  hasDimensions: boolean
}): 'available' | 'partial' | 'unavailable' {
  if (input.sealed) return 'available'
  if (input.rebuildCompleteness === 'partial' || input.projectionStatus === 'failed') return 'partial'
  if (input.lastVerifiedAt) return 'available'
  if (input.hasDimensions || input.changeCount > 0) return 'partial'
  return 'unavailable'
}

// Repository facts; classification is performed by @cairn/map in the API.
export const mapImpactSourceSchema = z.strictObject({
  restricted: z.boolean(),
  changedAssetKeys: z.array(technicalKeySchema),
  identityAliases: z.array(mapIdentityAliasSchema).default([]),
  bindings: z.array(mapReferenceItemSchema.omit({ grade: true, reasons: true }).extend({ scenarioId: entityIdSchema, assetRefKey: technicalKeySchema })),
  candidates: z.array(mapReferenceItemSchema.omit({ grade: true }).extend({ scenarioId: entityIdSchema, assetRefKey: technicalKeySchema })),
  visibleScenarioIds: z.array(entityIdSchema),
  scannedScenarioIds: z.array(entityIdSchema),
  scenarioNames: z.record(z.string(), z.string()),
})
export type MapImpactSource = z.infer<typeof mapImpactSourceSchema>
