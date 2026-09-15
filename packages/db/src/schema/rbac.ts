import { relations } from 'drizzle-orm'
import { index, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'
import { cairnSchema, consoleAccounts } from './console.js'

export const consoleRoles = cairnSchema.table(
  'console_roles',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind', { enum: ['system', 'custom'] })
      .notNull()
      .default('custom'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('console_roles_key_idx').on(t.key)],
)

export const consoleRolePermissions = cairnSchema.table(
  'console_role_permissions',
  {
    consoleRoleId: uuid('console_role_id')
      .notNull()
      .references(() => consoleRoles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.consoleRoleId, t.permission] }),
    index('console_role_permissions_perm_idx').on(t.permission),
  ],
)

export const consoleAccountRoles = cairnSchema.table(
  'console_account_roles',
  {
    consoleAccountId: uuid('console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'cascade' }),
    consoleRoleId: uuid('console_role_id')
      .notNull()
      .references(() => consoleRoles.id, { onDelete: 'restrict' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    /** 同表多外键用角色前缀区分 */
    assignedByConsoleAccountId: uuid('assigned_by_console_account_id').references(
      () => consoleAccounts.id,
      { onDelete: 'set null' },
    ),
  },
  (t) => [
    primaryKey({ columns: [t.consoleAccountId, t.consoleRoleId] }),
    index('console_account_roles_role_idx').on(t.consoleRoleId),
  ],
)

export const consoleRolesRelations = relations(consoleRoles, ({ many }) => ({
  permissions: many(consoleRolePermissions),
  accounts: many(consoleAccountRoles),
}))

export const consoleRolePermissionsRelations = relations(consoleRolePermissions, ({ one }) => ({
  role: one(consoleRoles, {
    fields: [consoleRolePermissions.consoleRoleId],
    references: [consoleRoles.id],
  }),
}))

export const consoleAccountRolesRelations = relations(consoleAccountRoles, ({ one }) => ({
  account: one(consoleAccounts, {
    fields: [consoleAccountRoles.consoleAccountId],
    references: [consoleAccounts.id],
  }),
  role: one(consoleRoles, {
    fields: [consoleAccountRoles.consoleRoleId],
    references: [consoleRoles.id],
  }),
}))

export type ConsoleRole = typeof consoleRoles.$inferSelect
export type NewConsoleRole = typeof consoleRoles.$inferInsert
export type ConsoleRolePermission = typeof consoleRolePermissions.$inferSelect
export type ConsoleAccountRole = typeof consoleAccountRoles.$inferSelect
