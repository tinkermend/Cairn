import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'

export const consoleAuditEvents = cairnSchema.table(
  'console_audit_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorConsoleAccountId: uuid('actor_console_account_id').references(() => consoleAccounts.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    resourceId: uuid('resource_id'),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('console_audit_events_created_idx').on(t.createdAt),
    index('console_audit_events_actor_idx').on(t.actorConsoleAccountId),
  ],
)

export type ConsoleAuditEvent = typeof consoleAuditEvents.$inferSelect
export type NewConsoleAuditEvent = typeof consoleAuditEvents.$inferInsert
