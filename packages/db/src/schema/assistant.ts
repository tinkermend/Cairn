import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'

export const assistantConversations = cairnSchema.table(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('assistant_conversations_owner_idem_idx').on(t.ownerAccountId, t.idempotencyKey),
    index('assistant_conversations_owner_active_idx').on(t.ownerAccountId, t.lastActiveAt),
  ],
)

export const assistantTurns = cairnSchema.table(
  'assistant_turns',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'cascade' }),
    clientTurnId: text('client_turn_id').notNull(),
    parentTurnId: uuid('parent_turn_id'),
    requestDigest: text('request_digest').notNull(),
    question: text('question').notNull(),
    capabilityId: text('capability_id'),
    slots: jsonb('slots').$type<Record<string, unknown> | null>(),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown> | null>(),
    status: text('status').notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    processingToken: text('processing_token').notNull(),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    stage: text('stage'),
    eventSeq: integer('event_seq').notNull().default(0),
    queuePosition: integer('queue_position'),
    stopReason: text('stop_reason'),
    ownerInstanceId: text('owner_instance_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    epoch: integer('epoch').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('assistant_turns_conversation_client_idx').on(t.conversationId, t.clientTurnId),
    index('assistant_turns_owner_status_idx').on(t.ownerAccountId, t.status),
    index('assistant_turns_lease_idx').on(t.status, t.leaseUntil),
  ],
)

export const assistantTurnEvents = cairnSchema.table(
  'assistant_turn_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => assistantTurns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    channel: text('channel').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('assistant_turn_events_turn_seq_idx').on(t.turnId, t.seq),
    index('assistant_turn_events_retain_idx').on(t.retainUntil),
  ],
)

export const platformAiCalls = cairnSchema.table(
  'platform_ai_calls',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ownerAccountId: uuid('owner_account_id').references(() => consoleAccounts.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id').references(() => assistantTurns.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    purpose: text('purpose').notNull(),
    configRevision: integer('config_revision'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    reservedTokens: integer('reserved_tokens'),
    usage: jsonb('usage').$type<Record<string, unknown> | null>(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    capabilityVersion: text('capability_version'),
    contextManifestId: text('context_manifest_id'),
    requestedModel: text('requested_model'),
    route: text('route'),
    cost: jsonb('cost').$type<Record<string, unknown> | null>(),
    errorClass: text('error_class'),
    validation: jsonb('validation').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('platform_ai_calls_created_idx').on(t.createdAt),
    index('platform_ai_calls_owner_idx').on(t.ownerAccountId),
  ],
)
