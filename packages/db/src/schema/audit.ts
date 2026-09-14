import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { serviceCallers, serviceCredentials } from './service-access.js'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'

export const consoleAuditEvents = cairnSchema.table(
  'console_audit_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorConsoleAccountId: uuid('actor_console_account_id').references(() => consoleAccounts.id, {
      onDelete: 'set null',
    }),
    actorServiceCallerId: uuid('actor_service_caller_id').references(() => serviceCallers.id, { onDelete: 'restrict' }),
    actorServiceCredentialId: uuid('actor_service_credential_id').references(() => serviceCredentials.id, { onDelete: 'restrict' }),
    requestId: text('request_id'),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    resourceId: uuid('resource_id'),
    summary: text('summary').notNull(),
    category: text('category').notNull().default('operation'),
    clientIp: text('client_ip'),
    userAgent: text('user_agent'),
    clientKind: text('client_kind'),
    loginIdentifier: text('login_identifier'),
    outcome: text('outcome'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('console_audit_events_created_idx').on(t.createdAt),
    index('console_audit_events_actor_idx').on(t.actorConsoleAccountId),
    index('console_audit_events_category_created_idx').on(t.category, t.createdAt),
    index('console_audit_events_login_outcome_idx').on(t.category, t.outcome, t.createdAt),
    index('console_audit_events_login_identifier_idx').on(t.loginIdentifier),
  ],
)

export type ConsoleAuditEvent = typeof consoleAuditEvents.$inferSelect
export type NewConsoleAuditEvent = typeof consoleAuditEvents.$inferInsert
