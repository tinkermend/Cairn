import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  BusinessSourceBuildStatus,
  BusinessSourceMappingConfig,
  BusinessSourceStatus,
  ValidationSummary,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { datasets } from './datasets.js'
import { targets } from './targets.js'

export const targetBusinessSources = cairnSchema.table(
  'target_business_sources',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    sourceKind: text('source_kind').notNull().default('dataset_snapshot'),
    currentSnapshotId: uuid('current_snapshot_id'),
    bindingRevision: integer('binding_revision').notNull().default(1),
    status: text('status').notNull().default('draft').$type<BusinessSourceStatus>(),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'cascade' }),
    approverAccountId: uuid('approver_account_id')
      .references(() => consoleAccounts.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    declaredSourceAsOf: timestamp('declared_source_as_of', { withTimezone: true }),
    declaredByAccountId: uuid('declared_by_account_id')
      .references(() => consoleAccounts.id, { onDelete: 'set null' }),
    declarationBasis: text('declaration_basis'),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    completenessBasis: text('completeness_basis').notNull().default('快照全量扫描校验'),
    completenessStatus: text('completeness_status')
      .notNull()
      .default('unknown')
      .$type<'complete' | 'partial' | 'unknown'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_target_business_sources_target_entity').on(t.targetId, t.entityType),
    index('idx_target_business_sources_target_status').on(t.targetId, t.status),
  ],
)

export const targetBusinessSourceSnapshots = cairnSchema.table(
  'target_business_source_snapshots',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sourceBindingId: uuid('source_binding_id')
      .notNull()
      .references(() => targetBusinessSources.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    buildStatus: text('build_status')
      .notNull()
      .default('building')
      .$type<BusinessSourceBuildStatus>(),
    rulesVersion: integer('rules_version').notNull().default(1),
    mappingConfig: jsonb('mapping_config').$type<BusinessSourceMappingConfig>().notNull(),
    validationSummary: jsonb('validation_summary').$type<ValidationSummary | null>(),
    sourceObservedAt: timestamp('source_observed_at', { withTimezone: true }),
    ownerWorkerId: text('owner_worker_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    fencingToken: integer('fencing_token').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_target_business_snapshots_binding').on(t.sourceBindingId, t.createdAt),
    index('idx_target_business_snapshots_status').on(t.buildStatus, t.leaseExpiresAt),
  ],
)

export const targetBusinessRecords = cairnSchema.table(
  'target_business_records',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => targetBusinessSourceSnapshots.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    recordKey: text('record_key').notNull(),
    displayName: text('display_name').notNull(),
    recordStatus: text('record_status'),
    originalDatasetId: uuid('original_dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    datasetRowId: uuid('dataset_row_id').notNull(),
    datasetRowIndex: integer('dataset_row_index').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_target_business_records_query').on(t.targetId, t.entityType, t.displayName),
    index('idx_target_business_records_key').on(t.snapshotId, t.recordKey),
    index('idx_target_business_records_snapshot_row').on(t.snapshotId, t.datasetRowIndex),
  ],
)
