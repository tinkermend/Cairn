import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  FrozenOutboundBinding,
  FrozenOutboundPolicy,
  OutboundPayload,
  OutboundPolicy,
  OutboundStatus,
} from '@cairn/shared'
import { cairnSchema } from './console.js'

export const scenarioOutboundPolicies = cairnSchema.table('scenario_outbound_policies', {
  scenarioId: uuid('scenario_id').primaryKey(),
  revision: integer('revision').notNull(),
  policy: jsonb('policy').$type<OutboundPolicy>().notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})
export const outboundControls = cairnSchema.table('outbound_controls', {
  key: text('key').primaryKey(),
  generation: integer('generation').notNull().default(0),
  revoked: boolean('revoked').notNull().default(false),
})
export const outboundEvents = cairnSchema.table(
  'outbound_events',
  {
    id: uuid('id').primaryKey(),
    sourceKey: text('source_key').notNull(),
    type: text('type').notNull(),
    runId: uuid('run_id'),
    targetId: uuid('target_id'),
    scenarioId: uuid('scenario_id'),
    alertId: uuid('alert_id'),
    sourceSequence: integer('source_sequence').notNull().default(0),
    state: text('state').$type<'waiting_result' | 'ready' | 'filtered' | 'suppressed'>().notNull(),
    reason: text('reason'),
    policy: jsonb('policy').$type<FrozenOutboundPolicy>(),
    bindings: jsonb('bindings').$type<FrozenOutboundBinding[]>().notNull(),
    payload: jsonb('payload').$type<OutboundPayload>(),
    consoleUrl: text('console_url'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    nextPrepareAt: timestamp('next_prepare_at', { withTimezone: true }).notNull(),
    actorId: uuid('actor_id'),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('outbound_events_source_idx').on(t.sourceKey),
    index('outbound_events_prepare_idx').on(t.state, t.nextPrepareAt, t.id),
    index('outbound_events_target_idx').on(t.targetId, t.occurredAt, t.id),
    index('outbound_events_run_idx').on(t.runId, t.occurredAt),
    index('outbound_events_alert_idx').on(t.alertId, t.sourceSequence),
    index('outbound_events_time_idx').on(t.occurredAt, t.id),
  ],
)
export const outboundDeliveries = cairnSchema.table(
  'outbound_deliveries',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('outbound_event_id')
      .notNull()
      .references(() => outboundEvents.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    recipientKey: text('recipient_key').notNull(),
    recipientLabel: text('recipient_label').notNull(),
    binding: jsonb('binding').$type<FrozenOutboundBinding>().notNull(),
    status: text('status').$type<OutboundStatus>().notNull(),
    reason: text('reason'),
    automaticAttemptCount: integer('automatic_attempt_count').notNull().default(0),
    attemptNo: integer('attempt_no').notNull().default(0),
    manualPermit: boolean('manual_permit').notNull().default(false),
    manualActorId: uuid('manual_actor_id'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    claimOwner: text('claim_owner'),
    claimInstance: uuid('claim_instance'),
    claimEpoch: integer('claim_epoch').notNull().default(0),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('outbound_deliveries_recipient_idx').on(t.eventId, t.channelId, t.recipientKey),
    index('outbound_deliveries_due_idx').on(t.status, t.nextAttemptAt, t.id),
    index('outbound_deliveries_expiry_idx').on(t.status, t.claimExpiresAt),
  ],
)
export const outboundDeliveryAttempts = cairnSchema.table(
  'outbound_delivery_attempts',
  {
    id: uuid('id').primaryKey(),
    deliveryId: uuid('outbound_delivery_id')
      .notNull()
      .references(() => outboundDeliveries.id, { onDelete: 'restrict' }),
    attemptNo: integer('attempt_no').notNull(),
    claimEpoch: integer('claim_epoch').notNull(),
    origin: text('origin').$type<'auto' | 'manual'>().notNull(),
    actorId: uuid('actor_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    result: text('result').$type<OutboundStatus>(),
    errorCode: text('error_code'),
    responseCode: integer('response_code'),
  },
  (t) => [uniqueIndex('outbound_attempts_number_idx').on(t.deliveryId, t.attemptNo)],
)
export const outboundCommands = cairnSchema.table(
  'outbound_commands',
  {
    id: text('command_key').primaryKey(),
    actorId: uuid('actor_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    action: text('action').notNull(),
    digest: text('digest').notNull(),
    resultId: uuid('result_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('outbound_commands_rate_idx').on(t.action, t.createdAt)],
)
