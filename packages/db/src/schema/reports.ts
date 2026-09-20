import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  ArtifactKind,
  ExportJobKind,
  ExportJobStatus,
  JsonValue,
  ReportConfig,
  ReportDocument,
  ReportScope,
  ReportStage,
  ReportSubjectKind,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { evidences, runs, scenarios } from './execution.js'
import { storedObjects } from './objects.js'
import { suiteRuns } from './suites.js'
import { targets } from './targets.js'

export const runReportContexts = cairnSchema.table('run_report_contexts', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'restrict' }),
  displayName: text('display_name').notNull(),
  timeZone: text('time_zone').notNull(),
  reportConfig: jsonb('report_config').$type<ReportConfig>().notNull(),
  targetName: text('target_name'),
  configSources: jsonb('config_sources').$type<Record<string, JsonValue>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const reportProfiles = cairnSchema.table(
  'report_profiles',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    revision: integer('revision').notNull(),
    config: jsonb('config').$type<ReportConfig>().notNull(),
    editScope: text('edit_scope').notNull().default('scenario').$type<'scenario' | 'suite'>(),
    updatedByConsoleAccountId: uuid('updated_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('report_profiles_target_name_idx').on(t.targetId, t.name)],
)

export const reportProfileVersions = cairnSchema.table('report_profile_versions', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  profileId: uuid('profile_id').notNull().references(() => reportProfiles.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').$type<ReportConfig>().notNull(),
  createdByConsoleAccountId: uuid('created_by_console_account_id').notNull().references(() => consoleAccounts.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('report_profile_versions_revision_idx').on(t.profileId, t.revision)])

export const scenarioReportDefaults = cairnSchema.table('scenario_report_defaults', {
  scenarioId: uuid('scenario_id').primaryKey().references(() => scenarios.id, { onDelete: 'restrict' }),
  profileId: uuid('profile_id').references(() => reportProfiles.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
})

export const artifacts = cairnSchema.table(
  'artifacts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull().$type<ArtifactKind>(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size'),
    digest: text('digest'),
    exportJobId: uuid('export_job_id').references(() => exportJobs.id, { onDelete: 'restrict' }),
    reportRevisionId: uuid('report_revision_id').references(() => reportRevisions.id, { onDelete: 'restrict' }),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    createdByConsoleAccountId: uuid('created_by_console_account_id').references(
      () => consoleAccounts.id,
      { onDelete: 'restrict' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('artifacts_target_idx').on(t.targetId, t.createdAt), index('artifacts_export_job_idx').on(t.exportJobId), index('artifacts_revision_idx').on(t.reportRevisionId)],
)

export const reports = cairnSchema.table(
  'reports',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    subjectKind: text('subject_kind').notNull().$type<ReportSubjectKind>(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'restrict' }),
    suiteRunId: uuid('suite_run_id').references(() => suiteRuns.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key'),
    requestDigest: text('request_digest'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reports_run_idx').on(t.runId, t.createdAt),
    index('reports_suite_run_idx').on(t.suiteRunId, t.createdAt),
    index('reports_target_idx').on(t.targetId, t.createdAt),
    uniqueIndex('reports_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
  ],
)

export const reportSourceSnapshots = cairnSchema.table('report_source_snapshots', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  reportId: uuid('report_id')
    .notNull()
    .references(() => reports.id, { onDelete: 'restrict' }),
  payload: jsonb('payload').$type<Record<string, JsonValue>>().notNull(),
  digest: text('digest').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
})

export const reportRevisions = cairnSchema.table(
  'report_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'restrict' }),
    revisionNo: integer('revision_no').notNull(),
    createdByConsoleAccountId: uuid('created_by_console_account_id').references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key'),
    requestDigest: text('request_digest'),
    stage: text('stage').notNull().$type<ReportStage>(),
    scope: text('scope').notNull().$type<ReportScope>(),
    title: text('title').notNull(),
    config: jsonb('config').$type<ReportConfig>().notNull(),
    templateVersion: text('template_version').notNull(),
    renderVersion: text('render_version').notNull(),
    sourceSnapshotId: uuid('source_snapshot_id')
      .notNull()
      .references(() => reportSourceSnapshots.id, { onDelete: 'restrict' }),
    parentReportRevisionId: uuid('parent_report_revision_id').references((): AnyPgColumn => reportRevisions.id, { onDelete: 'restrict' }),
    contentCompleteness: text('content_completeness').notNull().default('complete'),
    document: jsonb('document').$type<ReportDocument>(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    preparationError: text('preparation_error'),
    documentDigest: text('document_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('report_revisions_no_idx').on(t.reportId, t.revisionNo),
    uniqueIndex('report_revisions_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
  ],
)

export const reportRevisionMaterials = cairnSchema.table(
  'report_revision_materials',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => reportRevisions.id, { onDelete: 'restrict' }),
    evidenceId: uuid('evidence_id').references(() => evidences.id, { onDelete: 'restrict' }),
    artifactId: uuid('artifact_id').references(() => artifacts.id, { onDelete: 'restrict' }),
    missingReason: text('missing_reason'),
    digest: text('digest'),
    sourceDigest: text('source_digest'),
    sourceObjectId: uuid('source_object_id').references(() => storedObjects.id, { onDelete: 'restrict' }),
    sourceArtifactId: uuid('source_artifact_id').references(() => artifacts.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull().default('index').$type<'index' | 'screenshot' | 'logo'>(),
    status: text('status').notNull().default('missing').$type<'pending' | 'ready' | 'missing'>(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'restrict' }),
    caption: text('caption').notNull().default(''),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
  },
  (t) => [index('report_revision_materials_evidence_idx').on(t.evidenceId), index('report_material_revision_idx').on(t.revisionId)],
)

export const exportJobs = cairnSchema.table(
  'export_jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    kind: text('kind').notNull().$type<ExportJobKind>(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    reportId: uuid('report_id').references(() => reports.id, { onDelete: 'restrict' }),
    reportRevisionId: uuid('report_revision_id').references(() => reportRevisions.id, {
      onDelete: 'restrict',
    }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    status: text('status').notNull().$type<ExportJobStatus>(),
    contentCompleteness: text('content_completeness'),
    sourceManifest: jsonb('source_manifest').$type<Record<string, JsonValue>>().notNull(),
    requestDigest: text('request_digest').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    progress: text('progress'),
    error: text('error'),
    holderWorkerId: text('holder_worker_id'),
    holderInstanceId: uuid('holder_instance_id'),
    claimEpoch: integer('claim_epoch').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    retryCount: integer('retry_count').notNull().default(0),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('export_jobs_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
    index('export_jobs_revision_format_idx').on(t.reportRevisionId, t.kind, t.requestDigest),
    index('export_jobs_claim_idx').on(t.status, t.leaseUntil),
  ],
)

export const exportJobEvents = cairnSchema.table('export_job_events', {
  jobId: uuid('job_id')
    .notNull()
    .references(() => exportJobs.id, { onDelete: 'restrict' }),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, JsonValue>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('export_job_events_pk').on(t.jobId, t.seq)])

export const exportJobArtifacts = cairnSchema.table('export_job_artifacts', {
  jobId: uuid('job_id')
    .notNull()
    .references(() => exportJobs.id, { onDelete: 'restrict' }),
  artifactId: uuid('artifact_id')
    .notNull()
    .references(() => artifacts.id, { onDelete: 'restrict' }),
}, (t) => [uniqueIndex('export_job_artifacts_pk').on(t.jobId, t.artifactId)])

export const reportRevisionOutputs = cairnSchema.table('report_revision_outputs', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  revisionId: uuid('revision_id').notNull().references(() => reportRevisions.id, { onDelete: 'restrict' }),
  format: text('format').notNull().$type<'docx' | 'pdf'>(),
  renderVersion: text('render_version').notNull(),
  artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'restrict' }),
}, (t) => [uniqueIndex('report_revision_outputs_format_idx').on(t.revisionId, t.format, t.renderVersion)])

export const suiteReportTriggers = cairnSchema.table('suite_report_triggers', {
  suiteRunId: uuid('suite_run_id').primaryKey().references(() => suiteRuns.id, { onDelete: 'restrict' }),
  status: text('status').notNull().default('pending').$type<'pending' | 'created' | 'skipped' | 'failed'>(),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'restrict' }),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('suite_report_triggers_pending_idx').on(t.status, t.updatedAt)])
