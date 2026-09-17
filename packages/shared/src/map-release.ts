import { z } from 'zod'
import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  MAP_QUERY_PAGE_CANDIDATE_MAX,
  mapDescriptorFeaturesSchema,
  mapDimensionStatSchema,
  mapLifecycleSchema,
} from './map-assets.js'
import { mapAssetRefSchema, mapConditionSnapshotSchema, mapUtcInstantSchema } from './map-c0.js'
import { entityIdSchema } from './wire.js'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'digest 须为 64 位小写 hex')
const technicalKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{8,192}$/, '技术键须为 8–192 位 [A-Za-z0-9:._-]')
const policyVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9.@_-]{1,64}$/, 'policyVersion 须为 1–64 位 [A-Za-z0-9.@_-]')

export const mapReleaseItemSchema = z.strictObject({
  assetRefKey: technicalKeySchema,
  pageId: entityIdSchema.optional(),
  objectId: entityIdSchema.optional(),
  implementationKey: technicalKeySchema.optional(),
  descriptorVersion: z.number().int().positive().max(1_000_000).optional(),
  identityRevision: z.number().int().nonnegative().max(1_000_000_000),
  lifecycle: mapLifecycleSchema,
  executable: z.boolean(),
  condition: mapConditionSnapshotSchema.optional(),
  features: mapDescriptorFeaturesSchema.optional(),
  routeTemplate: z.string().trim().min(1).max(512).optional(),
  dimensions: z.array(mapDimensionStatSchema).max(8).optional(),
  lastVerifiedAt: mapUtcInstantSchema.optional(),
  sampleCount: z.number().int().nonnegative().optional(),
  changeCount: z.number().int().nonnegative().optional(),
})
export type MapReleaseItem = z.infer<typeof mapReleaseItemSchema>

export const mapReleaseManifestSchema = z.strictObject({
  protocol: z.literal(MAP_ASSETS_PROTOCOL),
  algorithmVersion: z.literal(MAP_IDENTITY_RULE_VERSION),
  targetId: entityIdSchema,
  projectionId: entityIdSchema,
  policyVersion: policyVersionSchema,
  sourceWatermark: z.number().int().nonnegative().max(1_000_000_000),
  identityRevision: z.number().int().nonnegative().max(1_000_000_000),
  projectionRevision: z.number().int().nonnegative().max(1_000_000_000),
  items: z.array(mapReleaseItemSchema).max(10_000),
})
export type MapReleaseManifest = z.infer<typeof mapReleaseManifestSchema>

export const mapReleaseSchema = z.strictObject({
  releaseId: entityIdSchema,
  targetId: entityIdSchema,
  projectionId: entityIdSchema,
  releaseNo: z.number().int().positive().max(1_000_000_000),
  policyVersion: policyVersionSchema,
  sourceWatermark: z.number().int().nonnegative().max(1_000_000_000),
  manifestDigest: digestSchema,
  createdAt: mapUtcInstantSchema,
})
export type MapRelease = z.infer<typeof mapReleaseSchema>

export const mapSealReleaseInputSchema = z.strictObject({
  targetId: entityIdSchema,
  projectionId: entityIdSchema,
  expectedProjectionRevision: z.number().int().nonnegative().max(1_000_000_000),
  policyVersion: policyVersionSchema,
  commandKey: technicalKeySchema,
  actorId: entityIdSchema,
  selectedAssetKeys: z.array(technicalKeySchema).max(10_000).optional(),
  lifecycleOverrides: z
    .array(
      z.strictObject({
        assetRefKey: technicalKeySchema,
        lifecycle: z.enum(['TRUSTED', 'RETIRED']),
      }),
    )
    .max(10_000)
    .optional(),
})
export type MapSealReleaseInput = z.infer<typeof mapSealReleaseInputSchema>

export const mapQueryViewSchema = z.strictObject({
  targetId: entityIdSchema,
  viewRef: z.discriminatedUnion('kind', [
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
  ]),
  identityRevision: z.number().int().nonnegative().max(1_000_000_000),
  candidateOverflow: z.boolean().optional(),
  assets: z.array(
    z.strictObject({
      assetRef: mapAssetRefSchema,
      assetRefKey: technicalKeySchema,
      lifecycle: mapLifecycleSchema,
      importance: z.number().int().nonnegative().max(1_000),
      executable: z.boolean(),
      rejectReasons: z.array(z.string().trim().min(1).max(256)).max(16),
      dimensions: z
        .array(
          z.strictObject({
            dimension: z.enum(['identity', 'locator', 'action', 'business']),
            verdict: z.enum(['confirmed', 'rejected', 'unknown', 'not_observed']),
            confirmedCount: z.number().int().nonnegative().max(1_000_000),
            rejectedCount: z.number().int().nonnegative().max(1_000_000),
            unknownCount: z.number().int().nonnegative().max(1_000_000),
            lastVerifiedAt: mapUtcInstantSchema.optional(),
          }),
        )
        .max(8),
      lastVerifiedAt: mapUtcInstantSchema.optional(),
      sampleCount: z.number().int().nonnegative().max(1_000_000),
      changeCount: z.number().int().nonnegative().max(1_000_000),
      condition: mapConditionSnapshotSchema.optional(),
      features: mapDescriptorFeaturesSchema.optional(),
      routeTemplate: z.string().trim().min(1).max(512).optional(),
      evidenceAvailability: z.enum(['available', 'partial', 'unavailable']).default('available'),
    }),
  ).max(MAP_QUERY_PAGE_CANDIDATE_MAX),
})
export type MapQueryView = z.infer<typeof mapQueryViewSchema>
