import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type {
  SessionAuthState,
  SessionHealth,
  SessionLeaseStatus,
  SessionReusePolicy,
  SessionStatus,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { targetAccounts } from './targets.js'

/**
 * 部分唯一索引与 CHECK 约束由 migration 0008 卡住；
 * Drizzle 只镜像列与查询会用到的普通索引。
 */
export const browserSessions = cairnSchema.table(
  'browser_sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => targetAccounts.id, { onDelete: 'restrict' }),
    status: text('status').notNull().$type<SessionStatus>(),
    health: text('health').notNull().default('UNKNOWN').$type<SessionHealth>(),
    authState: text('auth_state').notNull().default('UNKNOWN').$type<SessionAuthState>(),
    ownerWorkerId: text('owner_worker_id').notNull(),
    generation: integer('generation').notNull(),
    fencingToken: integer('fencing_token').notNull().default(0),
    version: integer('version').notNull().default(0),
    profileKey: text('profile_key').notNull(),
    reusePolicy: text('reuse_policy').notNull().$type<SessionReusePolicy>(),
    idleTtlSeconds: integer('idle_ttl_seconds').notNull(),
    maxLifetimeSeconds: integer('max_lifetime_seconds').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    authHoldWorkerId: text('auth_hold_worker_id'),
    authHoldExpiresAt: timestamp('auth_hold_expires_at', { withTimezone: true }),
    authHoldRunId: uuid('auth_hold_run_id').references(() => runs.id, { onDelete: 'restrict' }),
    authHoldSessionGeneration: integer('auth_hold_session_generation'),
    authHoldWorkerInstanceId: uuid('auth_hold_worker_instance_id'),
    authControlEpoch: integer('auth_control_epoch').notNull().default(0),
    authControlActorId: uuid('auth_control_actor_id'),
    authControlTokenHash: text('auth_control_token_hash'),
    authControlExpiresAt: timestamp('auth_control_expires_at', { withTimezone: true }),
    authControlPageId: uuid('auth_control_page_id'),
    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('browser_sessions_owner_idx').on(t.ownerWorkerId, t.status),
    index('browser_sessions_reap_idx').on(t.status, t.lastUsedAt),
  ],
)

export const sessionLeases = cairnSchema.table(
  'session_leases',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => browserSessions.id, { onDelete: 'restrict' }),
    sessionGeneration: integer('session_generation').notNull(),
    sessionFencingToken: integer('session_fencing_token').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    runFencingToken: integer('run_fencing_token'),
    holderWorkerId: text('holder_worker_id').notNull(),
    status: text('status').notNull().$type<SessionLeaseStatus>(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    index('session_leases_reap_idx').on(t.status, t.expiresAt),
    index('session_leases_run_id_idx').on(t.runId),
    index('session_leases_holder_idx').on(t.holderWorkerId, t.status),
  ],
)

export type BrowserSessionRow = typeof browserSessions.$inferSelect
export type NewBrowserSession = typeof browserSessions.$inferInsert
export type SessionLeaseRow = typeof sessionLeases.$inferSelect
export type NewSessionLease = typeof sessionLeases.$inferInsert
