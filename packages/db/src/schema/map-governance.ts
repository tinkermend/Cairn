import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  MapBindingBasis,
  MapBindingScopeKind,
  MapGovernanceCommandKind,
  MapGovernanceCommandStatus,
  MapOverlayLifecycle,
  MapPublicationStatus,
  MapReferenceResolution,
  MapScanStatus,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { scenarios, scenarioVersions } from './execution.js'
import { mapReleases } from './map-assets.js'
import { targets } from './targets.js'

export const mapGovernanceHeads = cairnSchema.table('map_governance_heads', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapAssetGovernance = cairnSchema.table(
  'map_asset_governance',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    assetRefKey: text('asset_ref_key').notNull(),
    lifecycle: text('lifecycle').notNull().$type<MapOverlayLifecycle>(),
    revision: integer('revision').notNull(),
    reason: text('reason').notNull(),
    actorId: uuid('actor_id').notNull(),
    commandId: uuid('command_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_asset_governance_ref_idx').on(t.targetId, t.assetRefKey),
    index('map_asset_governance_cmd_idx').on(t.commandId),
  ],
)

export const mapGovernanceCommands = cairnSchema.table(
  'map_governance_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    kind: text('kind').notNull().$type<MapGovernanceCommandKind>(),
    status: text('status').notNull().$type<MapGovernanceCommandStatus>(),
    expectedRevision: integer('expected_revision').notNull(),
    resultRevision: integer('result_revision'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    reason: text('reason').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>[]>().notNull(),
    actorId: uuid('actor_id').notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_governance_commands_key_idx').on(t.targetId, t.commandKey)],
)

export const mapPublicationHeads = cairnSchema.table('map_publication_heads', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapReleasePublications = cairnSchema.table(
  'map_release_publications',
  {
    releaseId: uuid('release_id')
      .primaryKey()
      .references(() => mapReleases.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    publicationStatus: text('publication_status').notNull().$type<MapPublicationStatus>(),
    commandKey: text('command_key').notNull(),
    reason: text('reason').notNull(),
    actorId: uuid('actor_id').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_release_publications_cmd_idx').on(t.targetId, t.commandKey),
    uniqueIndex('map_release_publications_target_rel_idx').on(t.targetId, t.releaseId),
    index('map_release_publications_status_idx').on(t.targetId, t.publicationStatus),
  ],
)

export const mapScenarioBindings = cairnSchema.table(
  'map_scenario_bindings',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    slotKey: text('slot_key').notNull(),
    stepId: uuid('step_id'),
    assetRefKey: text('asset_ref_key').notNull(),
    pageId: uuid('page_id'),
    objectId: uuid('object_id'),
    implementationKey: text('implementation_key'),
    descriptorVersion: integer('descriptor_version'),
    basis: text('basis').notNull().$type<MapBindingBasis>(),
    scopeKind: text('scope_kind').notNull().$type<MapBindingScopeKind>(),
    draftRevision: integer('draft_revision'),
    scenarioVersionId: uuid('scenario_version_id').references(() => scenarioVersions.id, { onDelete: 'restrict' }),
    versionSlot: text('version_slot').notNull().default('draft'),
    descriptorDigest: text('descriptor_digest'),
    confirmedBy: uuid('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    resolution: text('resolution').notNull().$type<MapReferenceResolution>(),
    sourceRef: jsonb('source_ref').$type<Record<string, unknown>>(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_scenario_bindings_slot_idx').on(
      t.targetId,
      t.scenarioId,
      t.scopeKind,
      t.slotKey,
      t.versionSlot,
    ),
    index('map_scenario_bindings_asset_idx').on(t.targetId, t.assetRefKey),
    index('map_scenario_bindings_scenario_idx').on(t.scenarioId, t.status),
  ],
)

export const mapReferenceScanHeads = cairnSchema.table('map_reference_scan_heads', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  status: text('status').notNull().$type<MapScanStatus>().default('idle'),
  completeness: text('completeness').notNull().default('unknown'),
  lastScenarioId: uuid('last_scenario_id'),
  scannedCount: integer('scanned_count').notNull().default(0),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapReferenceCandidates = cairnSchema.table(
  'map_reference_candidates',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id').notNull(),
    scenarioVersionId: uuid('scenario_version_id'),
    stepId: uuid('step_id').notNull(),
    assetRefKey: text('asset_ref_key').notNull(),
    pageId: uuid('page_id'),
    objectId: uuid('object_id'),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_reference_candidates_step_idx').on(t.targetId, t.scenarioId, t.stepId, t.assetRefKey),
    index('map_reference_candidates_asset_idx').on(t.targetId, t.assetRefKey),
  ],
)

export const mapPublicationCommands = cairnSchema.table(
  'map_publication_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull().references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_publication_commands_key_idx').on(t.targetId, t.commandKey)],
)
