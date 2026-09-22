import { index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { ResourceDeletedBy } from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'
import { targets } from './targets.js'
import { scenarios } from './execution.js'

export const targetFixtures = cairnSchema.table(
  'target_fixtures',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull().references(() => targets.id, { onDelete: 'restrict' }),
    scenarioId: uuid('scenario_id').references(() => scenarios.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size'),
    digest: text('digest'),
    /** 与录制附件一致的上传代次，保证 reserve→commit 幂等。 */
    uploadGenerationId: uuid('upload_generation_id'),
    uploadDeadlineAt: timestamp('upload_deadline_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdByConsoleAccountId: uuid('created_by_console_account_id').references(() => consoleAccounts.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('target_fixtures_target_idx').on(t.targetId, t.createdAt),
    index('target_fixtures_scenario_idx').on(t.scenarioId),
    index('target_fixtures_deleted_at_idx').on(t.deletedAt),
  ],
)

export type TargetFixtureRow = typeof targetFixtures.$inferSelect
export type TargetFixtureInsert = typeof targetFixtures.$inferInsert
