import { index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { ObjectOwnerKind, PurgeReason, StoredObjectStatus } from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { artifacts } from './reports.js'

export const storedObjects = cairnSchema.table(
  'stored_objects',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    objectKey: text('object_key').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'restrict' }),
    ownerKind: text('owner_kind').notNull().default('run').$type<ObjectOwnerKind>(),
    artifactId: uuid('artifact_id').references(() => artifacts.id, { onDelete: 'restrict' }),
    status: text('status').notNull().$type<StoredObjectStatus>(),
    contentType: text('content_type'),
    byteSize: integer('byte_size'),
    digest: text('digest'),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp('available_at', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    purgeReason: text('purge_reason').$type<PurgeReason>(),
    purgeAttempts: integer('purge_attempts').notNull().default(0),
    lastPurgeErrorAt: timestamp('last_purge_error_at', { withTimezone: true }),
    deleteRequestedAt: timestamp('delete_requested_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('stored_objects_object_key_idx').on(t.objectKey),
    index('stored_objects_purge_idx').on(t.status, t.purgeAttempts, t.retainUntil),
    index('stored_objects_status_retain_idx').on(t.status, t.retainUntil),
    index('stored_objects_pending_idx').on(t.status, t.createdAt),
    index('stored_objects_run_id_idx').on(t.runId),
    index('stored_objects_delete_requested_idx').on(t.deleteRequestedAt),
    index('stored_objects_artifact_id_idx').on(t.artifactId),
    index('stored_objects_owner_kind_idx').on(t.ownerKind, t.retainUntil),
  ],
)

export type StoredObjectRow = typeof storedObjects.$inferSelect
