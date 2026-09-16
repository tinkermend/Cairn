import { relations } from 'drizzle-orm'
import type { AuthProfileValidation, ResourceDeletedBy, TargetAuthProfileDefinition } from '@cairn/shared'
import {
  customType,
  index,
  integer,
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
    currentAuthProfileRevision: integer('current_auth_profile_revision'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('targets_code_idx').on(t.code),
    index('targets_deleted_at_idx').on(t.deletedAt),
  ],
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
    expectedIdentity: text('expected_identity'),
    configRevision: integer('config_revision').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: jsonb('deleted_by').$type<ResourceDeletedBy>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('target_accounts_target_username_idx').on(t.targetId, t.username),
    index('target_accounts_target_id_idx').on(t.targetId),
    index('target_accounts_deleted_at_idx').on(t.deletedAt),
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
export const targetAuthProfiles = cairnSchema.table(
  'target_auth_profiles',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    definition: jsonb('definition').$type<TargetAuthProfileDefinition>().notNull(),
    digest: text('digest').notNull(),
    validation: jsonb('validation').$type<AuthProfileValidation | null>(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('target_auth_profiles_target_revision_key').on(t.targetId, t.revision)],
)

export const targetAccountAuthBudget = cairnSchema.table(
  'target_account_auth_budget',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => targetAccounts.id, { onDelete: 'restrict' }),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    autoLoginCount: integer('auto_login_count').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    pausedReason: text('paused_reason'),
    nextAllowedAt: timestamp('next_allowed_at', { withTimezone: true }),
    lastConfigRevision: integer('last_config_revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('target_account_auth_budget_account_key').on(t.targetAccountId)],
)

export type SecretRow = typeof secrets.$inferSelect
export type TargetAuthProfileRow = typeof targetAuthProfiles.$inferSelect
export type TargetAccountAuthBudgetRow = typeof targetAccountAuthBudget.$inferSelect
