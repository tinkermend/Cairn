import { relations, sql } from 'drizzle-orm'
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  ServiceAdmission,
  AttemptStatus,
  EvidenceStatus,
  EvidenceType,
  JsonValue,
  RunEventType,
  RunEvidenceStatus,
  RunSnapshot,
  RunStatus,
  ScenarioDefinition,
  ScenarioDocument,
  ScenarioStatus,
  ScenarioVersionKind,
  StepRunStatus,
  ResourceDeletedBy,
  DebugMode,
  DebugCheckpoint,
  DebugOverlay,
  AuthCheckpoint,
  ScenarioAuthoringDocumentV2,
  ModuleManifest,
  OutcomeStatus,
  OutcomeScope,
  OutcomeSeverity,
  OutcomeOnViolation,
  OutcomeProvenance,
  OutcomeVerdict,
  OutcomeManifest,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { serviceCallers, serviceCredentials } from './service-access.js'
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
    purpose: text('purpose', { enum: ['user', 'module_verification', 'map_job'] })
      .notNull()
      .default('user')
      .$type<'user' | 'module_verification' | 'map_job'>(),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scenarios_target_name_idx').on(t.targetId, t.name),
    index('scenarios_target_id_idx').on(t.targetId),
    index('scenarios_deleted_at_idx').on(t.deletedAt),
  ],
)

export const scenarioVersions = cairnSchema.table(
  'scenario_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no'),
    kind: text('kind', { enum: ['published', 'trial'] })
      .notNull()
      .default('published')
      .$type<ScenarioVersionKind>(),
    definition: jsonb('definition').$type<ScenarioDefinition>().notNull(),
    compilerVersion: integer('compiler_version').notNull().default(1),
    sourceDigest: text('source_digest').notNull().default(''),
    authoringDocument: jsonb('authoring_document').$type<ScenarioAuthoringDocumentV2>(),
    moduleManifest: jsonb('module_manifest').$type<ModuleManifest>(),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scenario_versions_scenario_no_idx').on(t.scenarioId, t.versionNo),
    uniqueIndex('scenario_versions_trial_digest_idx')
      .on(t.scenarioId, t.sourceDigest)
      .where(sql`${t.kind} = 'trial'`),
  ],
)

export const scenarioDrafts = cairnSchema.table(
  'scenario_drafts',
  {
    scenarioId: uuid('scenario_id')
      .primaryKey()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    document: jsonb('document').$type<ScenarioAuthoringDocumentV2 | ScenarioDocument>().notNull(),
    updatedByConsoleAccountId: uuid('updated_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scenario_drafts_updated_at_idx').on(t.updatedAt)],
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
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    serviceCallerId: uuid('service_caller_id').references(() => serviceCallers.id, { onDelete: 'restrict' }),
    serviceCredentialId: uuid('service_credential_id').references(() => serviceCredentials.id, { onDelete: 'restrict' }),
    serviceAdmission: jsonb('service_admission').$type<ServiceAdmission>(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    status: text('status').notNull().$type<RunStatus>(),
    outcomeStatus: text('outcome_status').notNull().default('NOT_EVALUATED').$type<OutcomeStatus>(),
    evidenceStatus: text('evidence_status').notNull().default('PENDING').$type<RunEvidenceStatus>(),
    debugMode: text('debug_mode').notNull().default('runThrough').$type<DebugMode>(),
    checkpoint: jsonb('checkpoint').$type<DebugCheckpoint>(),
    debugOverlay: jsonb('debug_overlay').$type<DebugOverlay>(),
    authCheckpoint: jsonb('auth_checkpoint').$type<AuthCheckpoint>(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    snapshot: jsonb('snapshot').$type<RunSnapshot>().notNull(),
    snapshotDigest: text('snapshot_digest').notNull(),
    context: jsonb('context').$type<Record<string, JsonValue>>().notNull(),
    idempotencyKey: text('idempotency_key'),
    idempotencyDigest: text('idempotency_digest'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    eventSeq: integer('event_seq').notNull().default(0),
  },
  (t) => [
    uniqueIndex('runs_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
    uniqueIndex('runs_idempotency_service_idx').on(t.serviceCallerId, t.idempotencyKey),
    index('runs_service_status_idx').on(t.serviceCallerId, t.status),
    index('runs_deadline_idx').on(t.deadlineAt, t.status),
    index('runs_claim_idx').on(t.status, t.createdAt, t.id),
    index('runs_deleted_at_idx').on(t.deletedAt),
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
    outcomeStatus: text('outcome_status').notNull().default('NOT_EVALUATED').$type<OutcomeStatus>(),
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
    externalAccess: integer('external_access').notNull().default(0),
    uploadAttempts: integer('upload_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('evidences_run_created_idx').on(t.runId, t.createdAt),
    index('evidences_attempt_id_idx').on(t.attemptId),
    index('evidences_status_idx').on(t.status, t.createdAt),
  ],
)

export const runEvents = cairnSchema.table(
  'run_events',
  {
    eventId: uuid('event_id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    type: text('type').notNull().$type<RunEventType>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    stepRunId: uuid('step_run_id'),
    attemptId: uuid('attempt_id'),
    workerId: text('worker_id'),
    requestId: text('request_id'),
    payload: jsonb('payload').$type<JsonValue>().notNull(),
  },
  (t) => [
    uniqueIndex('run_events_run_seq_idx').on(t.runId, t.sequence),
    index('run_events_run_occurred_idx').on(t.runId, t.occurredAt),
  ],
)

export const outcomeResults = cairnSchema.table(
  'outcome_results',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => stepRuns.id, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'restrict' }),
    contractId: uuid('contract_id').notNull(),
    scope: text('scope').notNull().$type<OutcomeScope>(),
    meaning: text('meaning').notNull(),
    severity: text('severity').notNull().$type<OutcomeSeverity>(),
    onViolation: text('on_violation').notNull().$type<OutcomeOnViolation>(),
    provenance: text('provenance').notNull().$type<OutcomeProvenance>(),
    verdict: text('verdict').notNull().$type<OutcomeVerdict>(),
    expected: jsonb('expected').$type<JsonValue>(),
    actual: jsonb('actual').$type<JsonValue>(),
    evidenceId: uuid('evidence_id').references(() => evidences.id, { onDelete: 'restrict' }),
    details: jsonb('details').$type<Record<string, JsonValue>>(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outcome_results_attempt_contract_idx').on(t.attemptId, t.contractId),
    index('outcome_results_run_idx').on(t.runId),
    index('outcome_results_step_run_idx').on(t.stepRunId),
    index('outcome_results_verdict_idx').on(t.verdict),
  ],
)

export const scenariosRelations = relations(scenarios, ({ one, many }) => ({
  target: one(targets, { fields: [scenarios.targetId], references: [targets.id] }),
  versions: many(scenarioVersions),
  draft: one(scenarioDrafts),
}))

export const scenarioDraftsRelations = relations(scenarioDrafts, ({ one }) => ({
  scenario: one(scenarios, { fields: [scenarioDrafts.scenarioId], references: [scenarios.id] }),
}))

export const scenarioVersionsRelations = relations(scenarioVersions, ({ one }) => ({
  scenario: one(scenarios, { fields: [scenarioVersions.scenarioId], references: [scenarios.id] }),
}))

export const runsRelations = relations(runs, ({ one, many }) => ({
  scenario: one(scenarios, { fields: [runs.scenarioId], references: [scenarios.id] }),
  stepRuns: many(stepRuns),
  outcomeResults: many(outcomeResults),
}))

export const stepRunsRelations = relations(stepRuns, ({ one, many }) => ({
  run: one(runs, { fields: [stepRuns.runId], references: [runs.id] }),
  attempts: many(attempts),
  outcomeResults: many(outcomeResults),
}))

export const outcomeResultsRelations = relations(outcomeResults, ({ one }) => ({
  run: one(runs, { fields: [outcomeResults.runId], references: [runs.id] }),
  stepRun: one(stepRuns, { fields: [outcomeResults.stepRunId], references: [stepRuns.id] }),
  attempt: one(attempts, { fields: [outcomeResults.attemptId], references: [attempts.id] }),
  evidence: one(evidences, { fields: [outcomeResults.evidenceId], references: [evidences.id] }),
}))

export type ScenarioRow = typeof scenarios.$inferSelect
export type ScenarioVersionRow = typeof scenarioVersions.$inferSelect
export type ScenarioDraftRow = typeof scenarioDrafts.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type StepRunRow = typeof stepRuns.$inferSelect
export type AttemptRow = typeof attempts.$inferSelect
export type EvidenceRow = typeof evidences.$inferSelect
export type OutcomeResultRow = typeof outcomeResults.$inferSelect
export type OutcomeResultInsert = typeof outcomeResults.$inferInsert
