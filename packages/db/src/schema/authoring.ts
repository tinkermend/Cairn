import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { RecordingEvent, RecordingItem } from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { targets } from './targets.js'

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
    idempotencyKey: text('idempotency_key').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    name: text('name').notNull(),
    eventCount: integer('event_count').notNull(),
    itemCount: integer('item_count').notNull(),
    unresolvedCount: integer('unresolved_count').notNull(),
    events: jsonb('events').$type<RecordingEvent[]>().notNull(),
    items: jsonb('items').$type<RecordingItem[]>().notNull(),
    diagnostics: jsonb('diagnostics').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recording_drafts_actor_idempotency_idx').on(t.createdByConsoleAccountId, t.idempotencyKey),
    index('recording_drafts_target_id_idx').on(t.targetId),
    index('recording_drafts_created_at_idx').on(t.createdAt),
  ],
)

export type RecordingDraftRow = typeof recordingDrafts.$inferSelect
export type NewRecordingDraftRow = typeof recordingDrafts.$inferInsert
