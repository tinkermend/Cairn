import { relations } from 'drizzle-orm'
import {
  customType,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const targets = cairnSchema.table(
  'targets',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    code: text('code').notNull(),
    name: text('name').notNull(),
    entryUrl: text('entry_url').notNull(),
    loginUrl: text('login_url'),
    authMethod: text('auth_method', { enum: ['password', 'manual'] })
      .notNull()
      .default('password'),
    captchaMode: text('captcha_mode', { enum: ['none', 'image', 'slider', 'sms', 'other'] })
      .notNull()
      .default('none'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    loginFields: jsonb('login_fields').$type<{
      username?: { by: 'id' | 'name' | 'css'; value: string }
      password?: { by: 'id' | 'name' | 'css'; value: string }
      submit?: { by: 'id' | 'name' | 'css'; value: string }
    }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('targets_code_idx').on(t.code)],
)

export const secrets = cairnSchema.table('secrets', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  provider: text('provider').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const targetAccounts = cairnSchema.table(
  'target_accounts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    username: text('username').notNull(),
    secretProvider: text('secret_provider'),
    secretId: uuid('secret_id').references(() => secrets.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('target_accounts_target_username_idx').on(t.targetId, t.username),
    index('target_accounts_target_id_idx').on(t.targetId),
  ],
)

export const targetsRelations = relations(targets, ({ many }) => ({
  accounts: many(targetAccounts),
}))

export const targetAccountsRelations = relations(targetAccounts, ({ one }) => ({
  target: one(targets, {
    fields: [targetAccounts.targetId],
    references: [targets.id],
  }),
  secret: one(secrets, {
    fields: [targetAccounts.secretId],
    references: [secrets.id],
  }),
}))

export type Target = typeof targets.$inferSelect
export type NewTarget = typeof targets.$inferInsert
export type TargetAccount = typeof targetAccounts.$inferSelect
export type NewTargetAccount = typeof targetAccounts.$inferInsert
export type SecretRow = typeof secrets.$inferSelect
