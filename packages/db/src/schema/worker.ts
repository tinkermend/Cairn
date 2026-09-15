import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { RunLeaseStatus, WorkerStatus } from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'

/**
 * 部分唯一索引与 CHECK 由 migration 0011 卡住；
 * Drizzle 只镜像列与查询会用到的普通索引。
 */
export const workers = cairnSchema.table('workers', {
  id: text('id').primaryKey(),
  instanceId: uuid('instance_id').notNull(),
  status: text('status').notNull().$type<WorkerStatus>(),
  capacity: integer('capacity').notNull(),
  maxSessions: integer('max_sessions').notNull().default(2),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  internalBaseUrl: text('internal_base_url'),
  lostAfterSeconds: integer('lost_after_seconds'),
  heartbeatExpiresAt: timestamp('heartbeat_expires_at', { withTimezone: true }),
  liveHandleCount: integer('live_handle_count'),
  sampledSlotCount: integer('sampled_slot_count'),
  handleMismatchStreak: integer('handle_mismatch_streak').notNull().default(0),
})

export const runLeases = cairnSchema.table(
  'run_leases',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    fencingToken: integer('fencing_token').notNull(),
    holderWorkerId: text('holder_worker_id').notNull(),
    status: text('status').notNull().$type<RunLeaseStatus>(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    index('run_leases_holder_idx').on(t.holderWorkerId, t.status),
    index('run_leases_reap_idx').on(t.status, t.expiresAt),
  ],
)

export type WorkerRow = typeof workers.$inferSelect
export type RunLeaseRow = typeof runLeases.$inferSelect
