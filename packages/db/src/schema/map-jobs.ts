import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  ExplorationAllowlistEntry,
  ExplorationMode,
  MapAssetRef,
  MapJobKind,
  MapJobPolicy,
  MapJobStatus,
  MapJobStopReason,
  MapSafeEntry,
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
  maxProbePages: integer('max_probe_pages').notNull(),
  maxProbeObjects: integer('max_probe_objects').notNull(),
  maxProbeActions: integer('max_probe_actions').notNull(),
  maxProbeSeconds: integer('max_probe_seconds').notNull(),
  maxRefreshPages: integer('max_refresh_pages').notNull(),
  maxRefreshObjects: integer('max_refresh_objects').notNull(),
  maxRefreshActions: integer('max_refresh_actions').notNull(),
  maxRefreshSeconds: integer('max_refresh_seconds').notNull(),
  sliceWorkSeconds: integer('slice_work_seconds').notNull(),
  defaultDepth: text('default_depth').notNull(),
  staticRefreshDays: integer('static_refresh_days').notNull(),
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

export const mapSafeEntries = cairnSchema.table(
  'map_safe_entries',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    entryVersion: integer('entry_version').notNull(),
    entryName: text('entry_name').notNull(),
    entryUrl: text('entry_url').notNull(),
    arrivalName: text('arrival_name').notNull(),
    arrivalTarget: jsonb('arrival_target').$type<MapSafeEntry['arrivalTarget']>().notNull(),
    safetyBasis: jsonb('safety_basis').$type<MapSafeEntry['safetyBasis']>().notNull(),
    jobKinds: jsonb('job_kinds').$type<MapSafeEntry['jobKinds']>().notNull(),
    commandKey: text('command_key').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_safe_entries_cmd').on(t.targetId, t.commandKey),
    index('map_safe_entries_target_idx').on(t.targetId, t.createdAt),
  ],
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
    policyRevision: integer('policy_revision').notNull(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => mapSafeEntries.id, { onDelete: 'restrict' }),
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

export const mapExplorationPolicies = cairnSchema.table('map_exploration_policies', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  policySchemaVersion: integer('policy_schema_version').notNull(),
  policyVersion: integer('policy_version').notNull(),
  exploreEnabled: integer('explore_enabled').notNull(),
  exploreMode: text('explore_mode').notNull().$type<ExplorationMode>(),
  modelEnabled: integer('model_enabled').notNull(),
  maxHopDepth: integer('max_hop_depth').notNull(),
  maxNewPages: integer('max_new_pages').notNull(),
  maxCandidates: integer('max_candidates').notNull(),
  maxActions: integer('max_actions').notNull(),
  maxSeconds: integer('max_seconds').notNull(),
  sliceWorkSeconds: integer('slice_work_seconds').notNull(),
  allowlistJson: jsonb('allowlist_json').$type<ExplorationAllowlistEntry[]>().notNull(),
  seedRefsJson: jsonb('seed_refs_json').$type<MapAssetRef[]>().notNull(),
  revision: integer('revision').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapExplorationPolicyCommands = cairnSchema.table(
  'map_exploration_policy_commands',
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
  (t) => [uniqueIndex('map_exploration_policy_commands_key').on(t.targetId, t.commandKey)],
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
