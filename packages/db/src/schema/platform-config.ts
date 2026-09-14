import { integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { PlatformConfigDocument, PlatformConfigSource } from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { secrets } from './targets.js'

export const platformAiSecretBindings = cairnSchema.table('platform_ai_secret_bindings', {
  secretId: uuid('secret_id')
    .primaryKey()
    .references(() => secrets.id, { onDelete: 'restrict' }),
  modelOrigin: text('model_origin').notNull(),
})

export const platformConfig = cairnSchema.table('platform_config', {
  id: uuid('id').primaryKey(),
  revision: integer('revision').notNull(),
  document: jsonb('document').$type<PlatformConfigDocument>().notNull(),
  updatedByConsoleAccountId: uuid('updated_by_console_account_id').references(
    () => consoleAccounts.id,
    {
      onDelete: 'restrict',
    },
  ),
  reason: text('reason').notNull(),
  source: text('source').notNull().$type<PlatformConfigSource>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const platformConfigRevisions = cairnSchema.table(
  'platform_config_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    revision: integer('revision').notNull(),
    document: jsonb('document').$type<PlatformConfigDocument>().notNull(),
    actorConsoleAccountId: uuid('actor_console_account_id').references(() => consoleAccounts.id, {
      onDelete: 'restrict',
    }),
    reason: text('reason').notNull(),
    source: text('source').notNull().$type<PlatformConfigSource>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('platform_config_revisions_revision_idx').on(t.revision)],
)
