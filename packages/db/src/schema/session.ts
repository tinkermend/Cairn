import { index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type {
  AuthCapabilityTier,
  IdentityState,
  SessionAuthState,
  SessionHealth,
  SessionLeaseOwnerKind,
  SessionLeasePurpose,
  SessionLeaseStatus,
  SessionOperationKind,
  SessionOperationOrigin,
  SessionOperationStatus,
  SessionProfileCleanup,
  SessionProfileState,
  SessionReclaimMode,
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
    ownerWorkerInstanceId: uuid('owner_worker_instance_id'),
    generation: integer('generation').notNull(),
    fencingToken: integer('fencing_token').notNull().default(0),
    version: integer('version').notNull().default(0),
    profileKey: text('profile_key').notNull(),
    reusePolicy: text('reuse_policy').notNull().$type<SessionReusePolicy>(),
    idleTtlSeconds: integer('idle_ttl_seconds').notNull(),
    maxLifetimeSeconds: integer('max_lifetime_seconds').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    authControlEpoch: integer('auth_control_epoch').notNull().default(0),
    authControlActorId: uuid('auth_control_actor_id'),
    authControlTokenHash: text('auth_control_token_hash'),
    authControlExpiresAt: timestamp('auth_control_expires_at', { withTimezone: true }),
    authControlPageId: uuid('auth_control_page_id'),
    lastAuthCheckedAt: timestamp('last_auth_checked_at', { withTimezone: true }),
    lastAuthSuccessAt: timestamp('last_auth_success_at', { withTimezone: true }),
    lastAuthGeneration: integer('last_auth_generation'),
    lastExpectedIdentity: text('last_expected_identity'),
    authValidUntil: timestamp('auth_valid_until', { withTimezone: true }),
    authExpirySource: text('auth_expiry_source'),
    lastAuthError: text('last_auth_error'),
    authProfileRevision: integer('auth_profile_revision'),
    identityState: text('identity_state').$type<IdentityState>(),
    identityVerifiedAt: timestamp('identity_verified_at', { withTimezone: true }),
    observedTier: text('observed_tier').$type<AuthCapabilityTier>(),
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    nextAuthCheckAt: timestamp('next_auth_check_at', { withTimezone: true }),
    reclaimMode: text('reclaim_mode').notNull().default('IDLE').$type<SessionReclaimMode>(),
    keepAliveUntil: timestamp('keep_alive_until', { withTimezone: true }),
    keepAliveSeconds: integer('keep_alive_seconds'),
    authProbeIntervalSeconds: integer('auth_probe_interval_seconds'),
    evictionPriority: integer('eviction_priority').notNull().default(0),
    predecessorSessionId: uuid('predecessor_session_id'),
    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('browser_sessions_owner_idx').on(t.ownerWorkerId, t.status),
    index('browser_sessions_reap_idx').on(t.status, t.lastUsedAt),
    index('browser_sessions_retain_idx').on(t.retainUntil),
    index('browser_sessions_auth_check_idx').on(t.status, t.nextAuthCheckAt),
    index('browser_sessions_keep_alive_idx').on(t.ownerWorkerId, t.status, t.keepAliveUntil),
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
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'restrict' }),
    runFencingToken: integer('run_fencing_token'),
    purpose: text('purpose').notNull().default('EXECUTION').$type<SessionLeasePurpose>(),
    ownerKind: text('owner_kind').notNull().default('RUN').$type<SessionLeaseOwnerKind>(),
    operationId: uuid('operation_id'),
    waitDeadlineAt: timestamp('wait_deadline_at', { withTimezone: true }),
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
    index('session_leases_operation_id_idx').on(t.operationId),
  ],
)

export const sessionOperations = cairnSchema.table(
  'session_operations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    targetAccountId: uuid('target_account_id').notNull(),
    kind: text('kind').notNull().$type<SessionOperationKind>(),
    kindParams: jsonb('kind_params').$type<Record<string, unknown>>().notNull().default({}),
    origin: text('origin').notNull().$type<SessionOperationOrigin>(),
    status: text('status').notNull().$type<SessionOperationStatus>(),
    expectedSessionId: uuid('expected_session_id'),
    expectedGeneration: integer('expected_generation'),
    idempotencyKey: text('idempotency_key').notNull(),
    contentDigest: text('content_digest').notNull(),
    authRuleRevision: integer('auth_rule_revision'),
    accountConfigDigest: text('account_config_digest'),
    secretRefs: jsonb('secret_refs').$type<unknown[]>().notNull().default([]),
    resourcePolicy: jsonb('resource_policy').$type<Record<string, unknown> | null>(),
    platformConfigRevision: integer('platform_config_revision').notNull(),
    queueDeadlineAt: timestamp('queue_deadline_at', { withTimezone: true }).notNull(),
    claimToken: text('claim_token'),
    ownerWorkerId: text('owner_worker_id'),
    ownerWorkerInstanceId: uuid('owner_worker_instance_id'),
    attemptNo: integer('attempt_no').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('session_operations_claim_idx').on(t.status, t.createdAt),
    index('session_operations_key_idx').on(t.targetId, t.targetAccountId, t.status),
  ],
)

export const sessionProfiles = cairnSchema.table(
  'session_profiles',
  {
    targetId: uuid('target_id').notNull(),
    targetAccountId: uuid('target_account_id').notNull(),
    revision: integer('revision').notNull(),
    locationWorkerId: text('location_worker_id'),
    state: text('state').notNull().$type<SessionProfileState>(),
    pendingCleanups: jsonb('pending_cleanups').$type<SessionProfileCleanup[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.targetId, t.targetAccountId] })],
)

export type BrowserSessionRow = typeof browserSessions.$inferSelect
export type NewBrowserSession = typeof browserSessions.$inferInsert
export type SessionLeaseRow = typeof sessionLeases.$inferSelect
export type NewSessionLease = typeof sessionLeases.$inferInsert
export type SessionOperationRow = typeof sessionOperations.$inferSelect
export type NewSessionOperation = typeof sessionOperations.$inferInsert
export const sessionRetentionIntents = cairnSchema.table(
  'session_retention_intents',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    targetAccountId: uuid('target_account_id').notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    platformConfigRevision: integer('platform_config_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('session_retention_intents_key_idx').on(t.targetId, t.targetAccountId)],
)

export const sessionEvents = cairnSchema.table(
  'session_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    seq: integer('seq').notNull(),
    targetId: uuid('target_id').notNull(),
    targetAccountId: uuid('target_account_id').notNull(),
    sessionId: uuid('session_id'),
    generation: integer('generation'),
    operationId: uuid('operation_id'),
    runId: uuid('run_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_events_key_seq_idx').on(t.targetId, t.targetAccountId, t.seq),
    index('session_events_session_idx').on(t.sessionId, t.seq),
  ],
)

export type SessionProfileRow = typeof sessionProfiles.$inferSelect
export type NewSessionProfile = typeof sessionProfiles.$inferInsert
export type SessionRetentionIntentRow = typeof sessionRetentionIntents.$inferSelect
export type NewSessionRetentionIntent = typeof sessionRetentionIntents.$inferInsert
export type SessionEventRow = typeof sessionEvents.$inferSelect
export type NewSessionEvent = typeof sessionEvents.$inferInsert
