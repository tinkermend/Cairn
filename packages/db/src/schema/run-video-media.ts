import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { RunVideoManifest, VideoMediaJobStatus } from '@cairn/shared'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'

export const runVideoMediaJobs = cairnSchema.table(
  'run_video_media_jobs',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    status: text('status').notNull().$type<VideoMediaJobStatus>(),
    fencingToken: integer('fencing_token').notNull().default(0),
    claimOwner: text('claim_owner'),
    claimInstance: uuid('claim_instance'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    spoolDir: text('spool_dir').notNull(),
    manifest: jsonb('manifest').$type<RunVideoManifest>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_video_media_jobs_run_idx').on(t.runId),
    index('run_video_media_jobs_due_idx').on(t.status, t.claimExpiresAt, t.createdAt, t.id),
  ],
)

export type RunVideoMediaJobRow = typeof runVideoMediaJobs.$inferSelect
