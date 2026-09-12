import { relations } from 'drizzle-orm'
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  AttemptStatus,
  EvidenceStatus,
  EvidenceType,
  JsonValue,
  RunEvidenceStatus,
  RunSnapshot,
  RunStatus,
  ScenarioDefinition,
  ScenarioStatus,
  StepRunStatus,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { targetAccounts, targets } from './targets.js'

export const scenarios = cairnSchema.table(
  'scenarios',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active')
      .$type<ScenarioStatus>(),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scenarios_target_name_idx').on(t.targetId, t.name),
    index('scenarios_target_id_idx').on(t.targetId),
  ],
)

export const scenarioVersions = cairnSchema.table(
  'scenario_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    definition: jsonb('definition').$type<ScenarioDefinition>().notNull(),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scenario_versions_scenario_no_idx').on(t.scenarioId, t.versionNo)],
)

export const runs = cairnSchema.table(
  'runs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    scenarioVersionId: uuid('scenario_version_id')
      .notNull()
      .references(() => scenarioVersions.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id').references(() => targetAccounts.id, { onDelete: 'restrict' }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    status: text('status').notNull().$type<RunStatus>(),
    evidenceStatus: text('evidence_status').notNull().default('PENDING').$type<RunEvidenceStatus>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    snapshot: jsonb('snapshot').$type<RunSnapshot>().notNull(),
    snapshotDigest: text('snapshot_digest').notNull(),
    context: jsonb('context').$type<Record<string, JsonValue>>().notNull(),
    idempotencyKey: text('idempotency_key'),
    idempotencyDigest: text('idempotency_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runs_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
    index('runs_claim_idx').on(t.status, t.createdAt, t.id),
  ],
)

export const stepRuns = cairnSchema.table(
  'step_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepId: uuid('step_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().$type<StepRunStatus>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('step_runs_run_step_idx').on(t.runId, t.stepId),
    uniqueIndex('step_runs_run_ordinal_idx').on(t.runId, t.ordinal),
  ],
)

export const attempts = cairnSchema.table(
  'attempts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id, { onDelete: 'restrict' }),
    attemptNo: integer('attempt_no').notNull(),
    status: text('status').notNull().$type<AttemptStatus>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    output: jsonb('output').$type<JsonValue>(),
    error: jsonb('error').$type<JsonValue>(),
  },
  (t) => [uniqueIndex('attempts_step_no_idx').on(t.stepRunId, t.attemptNo)],
)

export const evidences = cairnSchema.table(
  'evidences',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id').references(() => stepRuns.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'restrict' }),
    type: text('type').notNull().$type<EvidenceType>(),
    status: text('status').notNull().default('available').$type<EvidenceStatus>(),
    schemaVersion: integer('schema_version').notNull().default(1),
    payload: jsonb('payload').$type<JsonValue>(),
    objectId: uuid('object_id'),
    objectKey: text('object_key'),
    contentType: text('content_type'),
    byteSize: integer('byte_size'),
    digest: text('digest'),
    missingReason: text('missing_reason'),
    uploadAttempts: integer('upload_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('evidences_run_created_idx').on(t.runId, t.createdAt),
    index('evidences_attempt_id_idx').on(t.attemptId),
    index('evidences_status_idx').on(t.status, t.createdAt),
  ],
)

export const scenariosRelations = relations(scenarios, ({ one, many }) => ({
  target: one(targets, { fields: [scenarios.targetId], references: [targets.id] }),
  versions: many(scenarioVersions),
}))

export const scenarioVersionsRelations = relations(scenarioVersions, ({ one }) => ({
  scenario: one(scenarios, { fields: [scenarioVersions.scenarioId], references: [scenarios.id] }),
}))

export const runsRelations = relations(runs, ({ one, many }) => ({
  scenario: one(scenarios, { fields: [runs.scenarioId], references: [scenarios.id] }),
  stepRuns: many(stepRuns),
}))

export const stepRunsRelations = relations(stepRuns, ({ one, many }) => ({
  run: one(runs, { fields: [stepRuns.runId], references: [runs.id] }),
  attempts: many(attempts),
}))

export type ScenarioRow = typeof scenarios.$inferSelect
export type ScenarioVersionRow = typeof scenarioVersions.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type StepRunRow = typeof stepRuns.$inferSelect
export type AttemptRow = typeof attempts.$inferSelect
export type EvidenceRow = typeof evidences.$inferSelect
