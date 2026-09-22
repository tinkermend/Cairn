import { index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { scenarios, scenarioVersions, runs } from './execution.js'
import { targetAccounts } from './targets.js'
import { datasets } from './datasets.js'
import type {
  BatchPacing,
  BatchFailurePolicy,
  BatchFailureDomain,
  BatchStatus,
  BatchItemStatus,
  DataBinding,
} from '@cairn/shared'

export const batches = cairnSchema.table(
  'batches',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    name: text('name').notNull(),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'cascade' }),
    scenarioVersionId: uuid('scenario_version_id')
      .notNull()
      .references(() => scenarioVersions.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    targetAccountId: uuid('target_account_id')
      .references(() => targetAccounts.id, { onDelete: 'set null' }),
    status: text('status', {
      enum: ['QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'],
    })
      .notNull()
      .default('QUEUED')
      .$type<BatchStatus>(),
    failurePolicy: text('failure_policy', {
      enum: ['continue', 'stop_on_first', 'stop_on_threshold'],
    })
      .notNull()
      .default('stop_on_threshold')
      .$type<BatchFailurePolicy>(),
    failureThreshold: integer('failure_threshold').notNull().default(5),
    dataBindings: jsonb('data_bindings').$type<DataBinding>().notNull().default({}),
    pacingConfig: jsonb('pacing_config')
      .$type<BatchPacing>()
      .notNull()
      .default({ minDelayMs: 1500, maxDelayMs: 3500 }),
    totalItems: integer('total_items').notNull().default(0),
    successItems: integer('success_items').notNull().default(0),
    failedItems: integer('failed_items').notNull().default(0),
    reviewItems: integer('review_items').notNull().default(0),
    pausedReason: text('paused_reason'),
    createdByAccountId: uuid('created_by_account_id')
      .references(() => consoleAccounts.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_batches_scenario').on(t.scenarioId),
    index('idx_batches_status').on(t.status),
    index('idx_batches_created_at').on(t.createdAt),
  ],
)

export const batchItems = cairnSchema.table(
  'batch_items',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    datasetRowIndex: integer('dataset_row_index').notNull(),
    runId: uuid('run_id')
      .references(() => runs.id, { onDelete: 'set null' }),
    itemStatus: text('item_status', {
      enum: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'],
    })
      .notNull()
      .default('PENDING')
      .$type<BatchItemStatus>(),
    outcomeVerdict: text('outcome_verdict'),
    failureDomain: text('failure_domain', {
      enum: ['ITEM', 'TARGET', 'SESSION'],
    }).$type<BatchFailureDomain>(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_batch_items_batch_status').on(t.batchId, t.itemStatus),
    index('idx_batch_items_run').on(t.runId),
    index('idx_batch_items_batch_row').on(t.batchId, t.datasetRowIndex),
  ],
)
