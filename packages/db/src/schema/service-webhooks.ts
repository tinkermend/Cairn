import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  ServiceWebhookEvent,
  ServiceWebhookDeliveryStatus,
  ServiceWebhookPayload,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { runs } from './execution.js'
import { serviceCallers } from './service-access.js'
import { secrets } from './targets.js'

/** One caller has one current callback destination and a write-only signing key. */
export const serviceWebhooks = cairnSchema.table(
  'service_webhooks',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => serviceCallers.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secretId: uuid('secret_id')
      .notNull()
      .references(() => secrets.id, { onDelete: 'restrict' }),
    events: jsonb('events').$type<ServiceWebhookEvent[]>().notNull(),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    /** Events before this instant are never backfilled when enabling or editing. */
    enabledAt: timestamp('enabled_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('service_webhooks_caller_idx').on(t.callerId)],
)

/**
 * The delivery itself is the immutable de-duplication fact. Claims protect the
 * submission boundary from stale Workers while preserving at-least-once semantics.
 */
export const serviceWebhookDeliveries = cairnSchema.table(
  'service_webhook_deliveries',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => serviceWebhooks.id, { onDelete: 'cascade' }),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => serviceCallers.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    eventType: text('event_type').$type<ServiceWebhookEvent>().notNull(),
    payload: jsonb('payload').$type<ServiceWebhookPayload>().notNull(),
    status: text('status').$type<ServiceWebhookDeliveryStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    replayCount: integer('replay_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true, precision: 3 }),
    lastResponseCode: integer('last_response_code'),
    lastResponseBody: text('last_response_body'),
    lastError: text('last_error'),
    claimOwner: text('claim_owner'),
    claimInstance: uuid('claim_instance'),
    claimEpoch: integer('claim_epoch').notNull().default(0),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true, precision: 3 }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('service_webhook_deliveries_event_idx').on(
      t.webhookId,
      t.runId,
      t.eventType,
    ),
    index('service_webhook_deliveries_due_idx').on(
      t.status,
      t.nextRetryAt,
      t.id,
    ),
    index('service_webhook_deliveries_claim_idx').on(t.status, t.claimExpiresAt),
    index('service_webhook_deliveries_caller_created_idx').on(
      t.callerId,
      t.createdAt,
      t.id,
    ),
  ],
)
