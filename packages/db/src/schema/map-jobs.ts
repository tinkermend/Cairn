import { sql } from 'drizzle-orm'
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  MapIngestCursor,
  MapIngestElement,
  MapIngestScope,
  MapIngestSummary,
  MapMenuAnchor,
  MapMenuEntry,
  MapJobKind,
  MapJobPolicy,
  MapJobStatus,
  MapJobStopReason,
  TargetAccessPolicy,
  TargetAccessRule,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { targetAccounts, targets } from './targets.js'

export const targetAccessPolicies = cairnSchema.table('target_access_policies', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  policySchemaVersion: integer('policy_schema_version').notNull(),
  policyVersion: integer('policy_version').notNull(),
  rulesJson: jsonb('rules_json').$type<TargetAccessRule[]>().notNull(),
  readOnlyRequestsJson: jsonb('read_only_requests_json').$type<Array<{ method: 'POST'; origin: string; pathPattern: string }>>().notNull().default([]),
  postReadMode: text('post_read_mode').$type<'balanced' | null>(),
  verifiedNonContentRequestsJson: jsonb('verified_non_content_requests_json').$type<NonNullable<TargetAccessPolicy['verifiedNonContentRequests']>>().notNull().default([]),
  policyDigest: text('policy_digest').notNull(),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const targetAccessPolicyCommands = cairnSchema.table(
  'target_access_policy_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('target_access_policy_commands_key').on(t.targetId, t.commandKey)],
)

export const mapJobPolicies = cairnSchema.table('map_job_policies', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  policySchemaVersion: integer('policy_schema_version').notNull(),
  policyVersion: integer('policy_version').notNull(),
  manualJobsEnabled: integer('manual_jobs_enabled').notNull(),
  sliceWorkSeconds: integer('slice_work_seconds').notNull(),
  ingestMaxDepth: integer('ingest_max_depth').notNull().default(3),
  ingestMaxPagesPerEntry: integer('ingest_max_pages_per_entry').notNull().default(30),
  ingestMaxPagesPerJob: integer('ingest_max_pages_per_job').notNull().default(200),
  ingestMaxJobSeconds: integer('ingest_max_job_seconds').notNull().default(1800),
  ingestNavTimeoutSeconds: integer('ingest_nav_timeout_seconds').notNull().default(15),
  ingestSettleTimeoutSeconds: integer('ingest_settle_timeout_seconds').notNull().default(5),
  ingestPageBudgetSeconds: integer('ingest_page_budget_seconds').notNull().default(25),
  ingestMaxViewsPerPage: integer('ingest_max_views_per_page').notNull().default(8),
  ingestMaxOptionReadsPerPage: integer('ingest_max_option_reads_per_page').notNull().default(10),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapJobPolicyCommands = cairnSchema.table(
  'map_job_policy_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_job_policy_commands_key').on(t.targetId, t.commandKey)],
)

export const mapMenuEntries = cairnSchema.table(
  'map_menu_entries',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull().references(() => targets.id, { onDelete: 'restrict' }),
    entryVersion: integer('entry_version').notNull(),
    entryName: text('entry_name').notNull(),
    entryUrl: text('entry_url'),
    menuAnchor: jsonb('menu_anchor').$type<MapMenuAnchor>(),
    menuLabelKey: text('menu_label_key'),
    arrivalName: text('arrival_name').notNull(),
    arrivalTarget: jsonb('arrival_target').$type<MapMenuEntry['arrivalTarget']>().notNull(),
    enabled: integer('enabled').notNull(),
    orderIndex: integer('order_index').notNull(),
    activeGuard: text('active_guard'),
    createdBy: uuid('created_by').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('map_menu_entries_active_url').on(t.targetId, t.entryUrl, t.activeGuard),
    uniqueIndex('map_menu_entries_active_label').on(t.targetId, t.menuLabelKey, t.activeGuard)
      .where(sql`${t.entryUrl} IS NULL`),
    index('map_menu_entries_order').on(t.targetId, t.orderIndex),
  ],
)

export const mapMenuEntryCommands = cairnSchema.table(
  'map_menu_entry_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull().references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_menu_entry_commands_key').on(t.targetId, t.commandKey)],
)

export const mapMenuEntryRevisions = cairnSchema.table(
  'map_menu_entry_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    entryId: uuid('entry_id').notNull().references(() => mapMenuEntries.id, { onDelete: 'restrict' }),
    entryVersion: integer('entry_version').notNull(),
    snapshotJson: jsonb('snapshot_json').$type<MapMenuEntry>().notNull(),
    updatedBy: uuid('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_menu_entry_revisions_version').on(t.entryId, t.entryVersion)],
)

export const mapJobs = cairnSchema.table(
  'map_jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => targetAccounts.id, { onDelete: 'restrict' }),
    jobKind: text('job_kind').notNull().$type<MapJobKind>(),
    jobStatus: text('job_status').notNull().$type<MapJobStatus>(),
    stopReason: text('stop_reason').$type<MapJobStopReason>(),
    revision: integer('revision').notNull(),
    remainingBudgetSeconds: integer('remaining_budget_seconds').notNull(),
    scope: text('scope').notNull().$type<MapIngestScope>().default('full'),
    ingestCursor: jsonb('ingest_cursor').$type<MapIngestCursor>(),
    ingestSummary: jsonb('ingest_summary').$type<MapIngestSummary>(),
    frozenEntriesJson: jsonb('frozen_entries_json').$type<MapMenuEntry[]>().notNull().default([]),
    frozenAccessRevision: integer('frozen_access_revision').notNull().default(0),
    policyRevision: integer('policy_revision').notNull(),
    releaseId: uuid('release_id'),
    requestJson: jsonb('request_json').$type<Record<string, unknown>>().notNull(),
    frozenPolicyJson: jsonb('frozen_policy_json').$type<MapJobPolicy>().notNull(),
    activeGuard: text('active_guard'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_jobs_active_target').on(t.targetId, t.activeGuard),
    index('map_jobs_target_idx').on(t.targetId, t.createdAt),
  ],
)

export const mapIngestPages = cairnSchema.table(
  'map_ingest_pages',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    jobId: uuid('job_id').notNull().references(() => mapJobs.id, { onDelete: 'restrict' }),
    entryId: uuid('entry_id').notNull().references(() => mapMenuEntries.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id').notNull().references(() => targets.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id').notNull().references(() => targetAccounts.id, { onDelete: 'restrict' }),
    pageKey: text('page_key').notNull(),
    viewStateKey: text('view_state_key').notNull(),
    presentationStateKey: text('presentation_state_key').notNull(),
    arrivalMethod: text('arrival_method').notNull().$type<'goto' | 'reveal' | 'opaque_click'>(),
    menuPathJson: jsonb('menu_path_json').$type<string[]>().notNull(),
    title: text('title').notNull(),
    urlPattern: text('url_pattern').notNull(),
    elementsJson: jsonb('elements_json').$type<MapIngestElement[]>().notNull(),
    completeness: text('completeness').notNull().$type<'complete' | 'partial'>(),
    reasonsJson: jsonb('reasons_json').$type<string[]>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('map_ingest_pages_view').on(t.jobId, t.viewStateKey),
    index('map_ingest_pages_target_page').on(t.targetId, t.pageKey),
    index('map_ingest_pages_entry').on(t.entryId, t.observedAt),
  ],
)

export const mapJobSlices = cairnSchema.table(
  'map_job_slices',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    jobId: uuid('job_id')
      .notNull()
      .references(() => mapJobs.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    sliceOrdinal: integer('slice_ordinal').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    reservedSeconds: integer('reserved_seconds').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_job_slices_ord').on(t.jobId, t.sliceOrdinal),
    uniqueIndex('map_job_slices_run').on(t.runId),
    index('map_job_slices_target_idx').on(t.targetId, t.createdAt),
  ],
)

export const mapJobCommands = cairnSchema.table(
  'map_job_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('map_job_commands_key').on(t.targetId, t.commandKey)],
)
