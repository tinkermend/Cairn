import { index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { targets } from './targets.js'
import type { DatasetColumn, DatasetSourceType, DatasetRowValidStatus, JsonValue } from '@cairn/shared'

export const datasets = cairnSchema.table(
  'datasets',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    name: text('name').notNull(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    sourceType: text('source_type', { enum: ['excel', 'csv', 'table'] })
      .notNull()
      .$type<DatasetSourceType>(),
    sourceFilename: text('source_filename').notNull(),
    selectedSheet: text('selected_sheet'),
    rowCount: integer('row_count').notNull().default(0),
    columnsMeta: jsonb('columns_meta').$type<DatasetColumn[]>().notNull().default([]),
    createdByAccountId: uuid('created_by_account_id')
      .references(() => consoleAccounts.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_datasets_target').on(t.targetId),
    index('idx_datasets_created_at').on(t.createdAt),
    index('idx_datasets_deleted_at').on(t.deletedAt),
  ],
)

export const datasetRows = cairnSchema.table(
  'dataset_rows',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    rowData: jsonb('row_data').$type<Record<string, JsonValue>>().notNull(),
    validStatus: text('valid_status', { enum: ['valid', 'warning', 'error'] })
      .notNull()
      .default('valid')
      .$type<DatasetRowValidStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_dataset_rows_dataset_idx').on(t.datasetId, t.rowIndex),
    index('idx_dataset_rows_dataset_status').on(t.datasetId, t.validStatus),
  ],
)
