import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  MapLifecycle,
  MapPageKind,
  MapProjectionStatus,
  MapRebuildCompleteness,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { targets } from './targets.js'

export const mapPages = cairnSchema.table(
  'map_pages',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    allocationKey: text('allocation_key').notNull(),
    kind: text('kind').notNull().$type<MapPageKind>(),
    routeTemplate: text('route_template').notNull(),
    status: text('status').notNull().default('discovered'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_pages_target_alloc_idx').on(t.targetId, t.allocationKey),
    uniqueIndex('map_pages_target_id_idx').on(t.targetId, t.id),
  ],
)

export const mapObjects = cairnSchema.table(
  'map_objects',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    pageId: uuid('page_id').notNull(),
    allocationKey: text('allocation_key').notNull(),
    status: text('status').notNull().default('discovered'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_objects_target_alloc_idx').on(t.targetId, t.allocationKey),
    uniqueIndex('map_objects_target_id_idx').on(t.targetId, t.id),
    uniqueIndex('map_objects_target_page_id_idx').on(t.targetId, t.pageId, t.id),
    index('map_objects_page_idx').on(t.targetId, t.pageId),
  ],
)

export const mapIdentityRevisions = cairnSchema.table(
  'map_identity_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    commandKey: text('command_key').notNull(),
    action: text('action').notNull(),
    oldRefs: jsonb('old_refs').$type<Record<string, unknown>[]>().notNull(),
    newRefs: jsonb('new_refs').$type<Record<string, unknown>[]>().notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>[]>().notNull(),
    actorId: uuid('actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_identity_revisions_rev_idx').on(t.targetId, t.revision),
    uniqueIndex('map_identity_revisions_cmd_idx').on(t.targetId, t.commandKey),
  ],
)

export const mapProjections = cairnSchema.table(
  'map_projections',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    generation: integer('generation').notNull(),
    status: text('status').notNull().$type<MapProjectionStatus>(),
    algorithmVersion: text('algorithm_version').notNull(),
    policyVersion: text('policy_version').notNull(),
    identityRevision: integer('identity_revision').notNull(),
    revision: integer('revision').notNull().default(0),
    cursor: integer('ingest_cursor').notNull().default(0),
    sourceWatermark: integer('source_watermark'),
    lastError: text('last_error'),
    rebuildCompleteness: text('rebuild_completeness').$type<MapRebuildCompleteness>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_projections_generation_idx').on(t.targetId, t.generation),
    uniqueIndex('map_projections_target_id_idx').on(t.targetId, t.id),
    index('map_projections_status_idx').on(t.targetId, t.status),
  ],
)

export const mapProjectionHeads = cairnSchema.table('map_projection_heads', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  currentProjectionId: uuid('current_projection_id').notNull(),
  identityRevision: integer('identity_revision').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapIdentityAssignments = cairnSchema.table(
  'map_identity_assignments',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    projectionId: uuid('projection_id').notNull(),
    observationId: uuid('observation_id').notNull(),
    targetId: uuid('target_id').notNull(),
    pageId: uuid('page_id'),
    objectId: uuid('object_id'),
    assignmentRevision: integer('assignment_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_identity_assignments_rev_idx').on(t.projectionId, t.observationId, t.assignmentRevision),
    index('map_identity_assignments_obs_idx').on(t.projectionId, t.observationId),
  ],
)

export const mapObjectDescriptors = cairnSchema.table(
  'map_object_descriptors',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    objectId: uuid('object_id').notNull(),
    implementationKey: text('implementation_key').notNull(),
    descriptorVersion: integer('descriptor_version').notNull(),
    features: jsonb('features').$type<Record<string, unknown>>().notNull(),
    conditionSnapshot: jsonb('condition_snapshot').$type<Record<string, unknown>>().notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_object_descriptors_ver_idx').on(t.objectId, t.implementationKey, t.descriptorVersion),
    uniqueIndex('map_object_descriptors_digest_idx').on(t.objectId, t.implementationKey, t.contentDigest),
    uniqueIndex('map_object_descriptors_fk_idx').on(
      t.objectId,
      t.implementationKey,
      t.descriptorVersion,
    ),
  ],
)

export const mapImplementations = cairnSchema.table(
  'map_implementations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    objectId: uuid('object_id').notNull(),
    implementationKey: text('implementation_key').notNull(),
    currentDescriptorVersion: integer('current_descriptor_version'),
    conditionSnapshot: jsonb('condition_snapshot').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_implementations_key_idx').on(t.objectId, t.implementationKey),
    uniqueIndex('map_implementations_target_key_idx').on(t.targetId, t.objectId, t.implementationKey),
  ],
)

export const mapProjectionAssets = cairnSchema.table(
  'map_projection_assets',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    projectionId: uuid('projection_id').notNull(),
    targetId: uuid('target_id').notNull(),
    assetRefKey: text('asset_ref_key').notNull(),
    pageId: uuid('page_id'),
    objectId: uuid('object_id'),
    implementationKey: text('implementation_key'),
    descriptorVersion: integer('descriptor_version'),
    lifecycle: text('lifecycle').notNull().$type<MapLifecycle>(),
    importance: integer('importance').notNull().default(0),
    executable: integer('executable').notNull().default(0),
    rejectReasons: jsonb('reject_reasons').$type<string[]>().notNull(),
    dimensions: jsonb('dimensions').$type<Record<string, unknown>[]>().notNull(),
    sampleCount: integer('sample_count').notNull().default(0),
    changeCount: integer('change_count').notNull().default(0),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_projection_assets_ref_idx').on(t.projectionId, t.assetRefKey),
    index('map_projection_assets_object_idx').on(t.projectionId, t.objectId),
  ],
)

export const mapConflicts = cairnSchema.table(
  'map_conflicts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    projectionId: uuid('projection_id'),
    conflictKey: text('conflict_key').notNull(),
    status: text('status').notNull().default('open'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    handlingRevision: integer('handling_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_conflicts_key_idx').on(t.targetId, t.conflictKey)],
)

export const mapReleases = cairnSchema.table(
  'map_releases',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    releaseNo: integer('release_no').notNull(),
    projectionId: uuid('projection_id').notNull(),
    policyVersion: text('policy_version').notNull(),
    sourceWatermark: integer('source_watermark').notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    commandKey: text('command_key').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_releases_no_idx').on(t.targetId, t.releaseNo),
    uniqueIndex('map_releases_cmd_idx').on(t.targetId, t.commandKey),
    uniqueIndex('map_releases_target_id_idx').on(t.targetId, t.id),
    uniqueIndex('map_releases_digest_idx').on(t.targetId, t.manifestDigest),
  ],
)

export const mapReleaseItems = cairnSchema.table(
  'map_release_items',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    releaseId: uuid('release_id').notNull(),
    targetId: uuid('target_id').notNull(),
    assetRefKey: text('asset_ref_key').notNull(),
    pageId: uuid('page_id'),
    objectId: uuid('object_id'),
    implementationKey: text('implementation_key'),
    descriptorVersion: integer('descriptor_version'),
    identityRevision: integer('identity_revision').notNull(),
    lifecycle: text('lifecycle').notNull().$type<MapLifecycle>(),
    executable: integer('executable').notNull().default(0),
    conditionSnapshot: jsonb('condition_snapshot').$type<Record<string, unknown>>(),
    features: jsonb('features').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('map_release_items_ref_idx').on(t.releaseId, t.assetRefKey)],
)
