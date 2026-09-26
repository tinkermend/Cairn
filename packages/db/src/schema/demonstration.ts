import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  DemonstrationSource,
  ApplyDemonstrationBody,
  DemonstrationDecision,
  GeneralizationRound,
  RecordingGeneralizationStatus,
} from '@cairn/shared'
import { cairnSchema, consoleAccounts } from './console.js'
import { recordingDrafts, recordingImportReceipts } from './authoring.js'
import { runs, scenarios, scenarioVersions } from './execution.js'
import { newId } from '../id.js'

export type DemonstrationReceiptMetadata = {
  protocolVersion: 'demonstration@1'
  factDigest: string
  suggestionDigest: string
  modelProposalDigest?: string
  adapterVersion: string
  ruleVersion: string
  placement: ApplyDemonstrationBody['placement']
  decisions: ApplyDemonstrationBody['decisions']
  sourceMap: Array<{
    sourceIds: string[]
    nodeId?: string
    contractId?: string
    disposition: string
  }>
}

export const recordingDemonstrationSources = cairnSchema.table('recording_demonstration_sources', {
  recordingDraftId: uuid('recording_draft_id')
    .primaryKey()
    .references(() => recordingDrafts.id, { onDelete: 'restrict' }),
  source: jsonb('source').$type<DemonstrationSource>().notNull(),
  factDigest: text('fact_digest').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

export const recordingArtifacts = cairnSchema.table(
  'recording_artifacts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    recordingDraftId: uuid('recording_draft_id')
      .notNull()
      .references(() => recordingDrafts.id, { onDelete: 'restrict' }),
    clientAssetId: text('client_asset_id').notNull(),
    manifest: jsonb('manifest').$type<DemonstrationSource['assetManifest'][number]>().notNull(),
    status: text('status')
      .$type<'pending' | 'available' | 'missing' | 'deleting' | 'purged'>()
      .notNull(),
    generationId: uuid('generation_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_artifacts_source_asset_idx').on(t.recordingDraftId, t.clientAssetId),
    index('recording_artifacts_expiry_idx').on(t.status, t.expiresAt),
  ],
)

export const recordingArtifactUploads = cairnSchema.table(
  'recording_artifact_uploads',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => recordingArtifacts.id, { onDelete: 'restrict' }),
    objectKey: text('object_key').notNull(),
    status: text('status').$type<'pending' | 'committed' | 'deleting' | 'purged'>().notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    nextSweepAt: timestamp('next_sweep_at', { withTimezone: true }).notNull(),
    sweepCount: integer('sweep_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_artifact_uploads_key_idx').on(t.objectKey),
    index('recording_artifact_uploads_sweep_idx').on(t.status, t.nextSweepAt),
  ],
)

export const scenarioValidationSubjects = cairnSchema.table(
  'scenario_validation_subjects',
  {
    scenarioVersionId: uuid('scenario_version_id')
      .primaryKey()
      .references(() => scenarioVersions.id, { onDelete: 'restrict' }),
    protocolVersion: text('protocol_version').notNull(),
    subjectDigest: text('subject_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scenario_validation_subjects_digest_idx').on(t.subjectDigest)],
)

export const runValidationContexts = cairnSchema.table(
  'run_validation_contexts',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'restrict' }),
    subjectDigest: text('subject_digest').notNull(),
    executionScopeDigest: text('execution_scope_digest').notNull(),
    inputDigest: text('input_digest').notNull(),
    provenance: text('provenance').$type<'full_trial' | 'intervened'>().notNull(),
    interventions: jsonb('interventions').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_validation_contexts_subject_idx').on(t.subjectDigest)],
)

export const recordingGeneralizations = cairnSchema.table(
  'recording_generalizations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    recordingDraftId: uuid('recording_draft_id')
      .notNull()
      .references(() => recordingDrafts.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull().default(1),
    status: text('status')
      .$type<RecordingGeneralizationStatus>()
      .notNull()
      .default('editing'),
    factDigest: text('fact_digest').notNull(),
    suggestionDigest: text('suggestion_digest').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    ruleVersion: text('rule_version').notNull(),
    candidateDigest: text('candidate_digest').notNull(),
    decisions: jsonb('decisions').$type<DemonstrationDecision[]>().notNull(),
    rounds: jsonb('rounds').$type<GeneralizationRound[]>().notNull(),
    handedOffScenarioId: uuid('handed_off_scenario_id').references(() => scenarios.id, { onDelete: 'set null' }),
    handedOffReceiptId: uuid('handed_off_receipt_id').references(() => recordingImportReceipts.id, { onDelete: 'set null' }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_generalizations_draft_unique').on(t.recordingDraftId),
    index('recording_generalizations_draft_idx').on(t.recordingDraftId),
    index('recording_generalizations_status_idx').on(t.status),
    index('recording_generalizations_scenario_idx').on(t.handedOffScenarioId),
  ],
)
export type RecordingGeneralizationRow = typeof recordingGeneralizations.$inferSelect
export type NewRecordingGeneralizationRow = typeof recordingGeneralizations.$inferInsert

