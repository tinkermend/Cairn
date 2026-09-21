import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  AnalysisBudget,
  AnalysisCandidateKind,
  AnalysisCandidateStatus,
  AnalysisCandidateReview,
  AnalysisJobStatus,
  AnalysisMode,
  AnalysisSourceScope,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { scheduleOccurrences, schedules } from './schedules.js'
import { targets } from './targets.js'

export const analysisJobs = cairnSchema.table(
  'analysis_jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'restrict' }),
    occurrenceId: uuid('occurrence_id').references(() => scheduleOccurrences.id, { onDelete: 'restrict' }),
    mode: text('mode').notNull().$type<AnalysisMode>(),
    status: text('status').notNull().$type<AnalysisJobStatus>(),
    sourceScope: jsonb('source_scope').$type<AnalysisSourceScope>().notNull(),
    strategyVersion: text('strategy_version').notNull(),
    budget: jsonb('budget').$type<AnalysisBudget>().notNull(),
    inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>(),
    afterSeq: integer('after_seq').notNull().default(0),
    throughSeq: integer('through_seq'),
    checkpointSeq: integer('checkpoint_seq').notNull().default(0),
    result: jsonb('result').$type<Record<string, unknown>>(),
    coverageGaps: jsonb('coverage_gaps').$type<string[]>().notNull(),
    modelUsage: jsonb('model_usage').$type<Record<string, unknown>>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    fencingToken: integer('fencing_token').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    authorizedActorId: uuid('authorized_actor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('analysis_jobs_claim_idx').on(t.status, t.nextRetryAt, t.createdAt),
    index('analysis_jobs_target_idx').on(t.targetId, t.createdAt),
    uniqueIndex('analysis_jobs_occurrence').on(t.occurrenceId),
  ],
)

export const analysisJobAttempts = cairnSchema.table(
  'analysis_job_attempts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    jobId: uuid('job_id')
      .notNull()
      .references(() => analysisJobs.id, { onDelete: 'restrict' }),
    attemptNo: integer('attempt_no').notNull(),
    modelUsage: jsonb('model_usage').$type<Record<string, unknown>>(),
    status: text('status').notNull(),
    fencingToken: integer('fencing_token').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [uniqueIndex('analysis_job_attempts_no').on(t.jobId, t.attemptNo)],
)

export const analysisJobEvents = cairnSchema.table(
  'analysis_job_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    jobId: uuid('job_id')
      .notNull()
      .references(() => analysisJobs.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('analysis_job_events_seq').on(t.jobId, t.seq)],
)

export const analysisCheckpoints = cairnSchema.table(
  'analysis_checkpoints',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scopeDigest: text('scope_digest').notNull(),
    strategyGeneration: text('strategy_generation').notNull(),
    cursorSeq: integer('cursor_seq').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('analysis_checkpoints_scope').on(t.targetId, t.scopeDigest, t.strategyGeneration)],
)

export const analysisCommitSeq = cairnSchema.table('analysis_commit_seq', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  seq: integer('seq').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const analysisSourceIndex = cairnSchema.table(
  'analysis_source_index',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceRevision: integer('source_revision').notNull().default(1),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>(),
    committedSeq: integer('committed_seq').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('analysis_source_index_unique').on(t.sourceType, t.sourceId, t.sourceRevision),
    uniqueIndex('analysis_source_index_seq').on(t.targetId, t.committedSeq),
    index('analysis_source_index_target').on(t.targetId, t.committedSeq),
  ],
)

export const analysisCandidates = cairnSchema.table(
  'analysis_candidates',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    jobId: uuid('job_id')
      .notNull()
      .references(() => analysisJobs.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull().$type<AnalysisCandidateKind>(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    sources: jsonb('sources').$type<Record<string, unknown>[]>().notNull(),
    status: text('status').notNull().$type<AnalysisCandidateStatus>(),
    revision: integer('revision').notNull().default(1),
    review: jsonb('review').$type<AnalysisCandidateReview>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('analysis_candidates_job').on(t.jobId, t.createdAt)],
)

export const analysisCommands = cairnSchema.table(
  'analysis_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('analysis_commands_key').on(t.commandKey)],
)
