import { sql } from 'drizzle-orm'
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  JsonValue,
  ResourceDeletedBy,
  RunEvidenceStatus,
  SuiteDocument,
  SuiteFailurePolicy,
  SuiteMemberAdmission,
  SuiteRunStatus,
  SuiteStatus,
  SuiteVerdict,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { runs, scenarios, scenarioVersions } from './execution.js'
import { targetAccounts, targets } from './targets.js'

export const scenarioSuites = cairnSchema.table(
  'scenario_suites',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active').$type<SuiteStatus>(),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scenario_suites_target_name_idx').on(t.targetId, t.name),
    index('scenario_suites_target_id_idx').on(t.targetId),
    index('scenario_suites_deleted_at_idx').on(t.deletedAt),
  ],
)

export const scenarioSuiteDrafts = cairnSchema.table('scenario_suite_drafts', {
  suiteId: uuid('suite_id')
    .primaryKey()
    .references(() => scenarioSuites.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  document: jsonb('document').$type<SuiteDocument>().notNull(),
  updatedByConsoleAccountId: uuid('updated_by_console_account_id')
    .notNull()
    .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const scenarioSuiteVersions = cairnSchema.table(
  'scenario_suite_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    suiteId: uuid('suite_id')
      .notNull()
      .references(() => scenarioSuites.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    document: jsonb('document').$type<SuiteDocument>().notNull(),
    digest: text('digest').notNull(),
    publishedByConsoleAccountId: uuid('published_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scenario_suite_versions_no_idx').on(t.suiteId, t.versionNo)],
)

export const scenarioSuitePublishReceipts = cairnSchema.table('scenario_suite_publish_receipts', {
  actorId: uuid('actor_id')
    .notNull()
    .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  digest: text('digest').notNull(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => scenarioSuiteVersions.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('scenario_suite_publish_receipts_pk').on(t.actorId, t.idempotencyKey)])

export const suiteRuns = cairnSchema.table(
  'suite_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    suiteId: uuid('suite_id')
      .notNull()
      .references(() => scenarioSuites.id, { onDelete: 'restrict' }),
    suiteVersionId: uuid('suite_version_id')
      .notNull()
      .references(() => scenarioSuiteVersions.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    status: text('status').notNull().$type<SuiteRunStatus>(),
    verdict: text('verdict').$type<SuiteVerdict>(),
    evidenceStatus: text('evidence_status').notNull().default('PENDING').$type<RunEvidenceStatus>(),
    failurePolicy: text('failure_policy').notNull().$type<SuiteFailurePolicy>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    reason: text('reason'),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    snapshot: jsonb('snapshot').$type<Record<string, JsonValue>>().notNull(),
    snapshotDigest: text('snapshot_digest').notNull(),
    idempotencyKey: text('idempotency_key'),
    idempotencyDigest: text('idempotency_digest'),
    revision: integer('revision').notNull().default(0),
    eventSeq: integer('event_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suite_runs_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
    index('suite_runs_target_created_idx').on(t.targetId, t.createdAt),
    index('suite_runs_suite_created_idx').on(t.suiteId, t.createdAt),
    index('suite_runs_status_idx').on(t.status, t.updatedAt),
  ],
)

export const suiteRunItems = cairnSchema.table(
  'suite_run_items',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    suiteRunId: uuid('suite_run_id')
      .notNull()
      .references(() => suiteRuns.id, { onDelete: 'restrict' }),
    memberId: text('member_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    groupId: text('group_id'),
    displayName: text('display_name').notNull(),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    scenarioVersionId: uuid('scenario_version_id')
      .notNull()
      .references(() => scenarioVersions.id, { onDelete: 'restrict' }),
    childRunId: uuid('child_run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    admissionStatus: text('admission_status').notNull().$type<SuiteMemberAdmission>(),
    skipReason: text('skip_reason'),
    targetAccountId: uuid('target_account_id').references(() => targetAccounts.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('suite_run_items_member_idx').on(t.suiteRunId, t.memberId),
    uniqueIndex('suite_run_items_ordinal_idx').on(t.suiteRunId, t.ordinal),
    uniqueIndex('suite_run_items_child_idx').on(t.childRunId),
    uniqueIndex('suite_run_items_one_active_idx')
      .on(t.suiteRunId)
      .where(sql`${t.admissionStatus} = 'ACTIVE'`),
  ],
)

export const suiteRunEvents = cairnSchema.table('suite_run_events', {
  suiteRunId: uuid('suite_run_id')
    .notNull()
    .references(() => suiteRuns.id, { onDelete: 'restrict' }),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, JsonValue>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('suite_run_events_pk').on(t.suiteRunId, t.seq)])
