import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  RecordingBindingStatus,
  RecordingEvent,
  RecordingImportReceipt,
  RecordingInsertAnchor,
  RecordingItem,
  ResourceDeletedBy,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { scenarios } from './execution.js'
import { targets } from './targets.js'
import type { DemonstrationReceiptMetadata } from './demonstration.js'

export const recordingDrafts = cairnSchema.table(
  'recording_drafts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    recordingId: uuid('recording_id').notNull(),
    sourceVersion: text('source_version').notNull(),
    sourceProtocol: text('source_protocol').notNull().default('recording@1'),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    name: text('name').notNull(),
    eventCount: integer('event_count').notNull(),
    itemCount: integer('item_count').notNull(),
    unresolvedCount: integer('unresolved_count').notNull(),
    events: jsonb('events').$type<RecordingEvent[]>().notNull(),
    items: jsonb('items').$type<RecordingItem[]>().notNull(),
    diagnostics: jsonb('diagnostics').$type<string[]>().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_drafts_actor_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
    index('recording_drafts_target_id_idx').on(t.targetId),
    index('recording_drafts_created_at_idx').on(t.createdAt),
    index('recording_drafts_deleted_at_idx').on(t.deletedAt),
  ],
)

export type RecordingDraftRow = typeof recordingDrafts.$inferSelect
export type NewRecordingDraftRow = typeof recordingDrafts.$inferInsert

export const recordingBindings = cairnSchema.table(
  'recording_bindings',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    draftRevision: integer('draft_revision').notNull(),
    insertAnchor: jsonb('insert_anchor').$type<RecordingInsertAnchor>().notNull(),
    ticketHash: text('ticket_hash').notNull(),
    status: text('status').$type<RecordingBindingStatus>().notNull(),
    apiOrigin: text('api_origin').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }).notNull(),
    recordingDraftId: uuid('recording_draft_id').references(() => recordingDrafts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_bindings_ticket_hash_idx').on(t.ticketHash),
    index('recording_bindings_actor_created_idx').on(t.createdByConsoleAccountId, t.createdAt),
    index('recording_bindings_scenario_id_idx').on(t.scenarioId),
  ],
)

export const recordingImportReceipts = cairnSchema.table(
  'recording_import_receipts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id, { onDelete: 'restrict' }),
    recordingDraftId: uuid('recording_draft_id')
      .notNull()
      .references(() => recordingDrafts.id, { onDelete: 'restrict' }),
    createdByConsoleAccountId: uuid('created_by_console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    sourceDigest: text('source_digest').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    baseRevision: integer('base_revision').notNull(),
    newRevision: integer('new_revision').notNull(),
    insertAnchor: jsonb('insert_anchor').$type<RecordingInsertAnchor>().notNull(),
    sourceMap: jsonb('source_map').$type<RecordingImportReceipt['sourceMap']>().notNull(),
    demonstration: jsonb('demonstration').$type<DemonstrationReceiptMetadata>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_import_receipts_scenario_draft_idx').on(t.scenarioId, t.recordingDraftId),
    uniqueIndex('recording_import_receipts_actor_idempotency_idx').on(
      t.createdByConsoleAccountId,
      t.idempotencyKey,
    ),
    index('recording_import_receipts_scenario_id_idx').on(t.scenarioId),
  ],
)

export const recordingMapIngests = cairnSchema.table('recording_map_ingests', {
  recordingDraftId: uuid('recording_draft_id')
    .primaryKey()
    .references(() => recordingDrafts.id, { onDelete: 'restrict' }),
  nextIndex: integer('next_index').notNull().default(0),
  status: text('status').$type<'pending' | 'completed' | 'aborted'>().notNull().default('pending'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type RecordingBindingRow = typeof recordingBindings.$inferSelect
export type RecordingImportReceiptRow = typeof recordingImportReceipts.$inferSelect
export type RecordingMapIngestRow = typeof recordingMapIngests.$inferSelect
