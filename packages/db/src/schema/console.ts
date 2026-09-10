import { relations } from 'drizzle-orm'
import { index, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../id.js'

/**
 * DDL 的事实源是 migrations/*.sql，本文件是查询侧的 TypeScript 视图。
 * 两者必须手工保持一致——src/__tests__/schema-parity.test.ts 会在
 * 真实数据库上比对列、类型与可空性，漂移会立刻失败。
 *
 * schema 名与 CAIRN_DB_SCHEMA 一致；migration 内用 "__SCHEMA__" 占位，
 * 此处用固定名（Drizzle 需要编译期常量）。多租户隔离时另行处理。
 */
export const cairnSchema = pgSchema('cairn')

/** 主体：审计归属。角色通过 console_account_roles 绑定。不含任何认证方式信息。 */
export const consoleAccounts = cairnSchema.table(
  'console_accounts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    displayName: text('display_name').notNull(),
    email: text('email'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('console_accounts_email_idx').on(t.email)],
)

/**
 * 身份来源：本地密码只是 provider='local' 的一种，与 OIDC / LDAP 平级。
 * 接客户 SSO 时是新增一行，account 表与所有引用 console_account_id 的地方不动。
 */
export const consoleIdentities = cairnSchema.table(
  'console_identities',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    consoleAccountId: uuid('console_account_id')
      .notNull()
      .references(() => consoleAccounts.id, { onDelete: 'cascade' }),
    /** 'local' | 'oidc' | 'ldap' | …，不设枚举以便新增 provider 无需迁移 */
    provider: text('provider').notNull(),
    /** 该 provider 下的唯一标识：local 为登录名，OIDC 为 sub，LDAP 为 DN */
    subject: text('subject').notNull(),
    /** 仅 local 使用，存密码哈希；外部 provider 恒为 NULL（数据库有 CHECK 约束） */
    secret: text('secret'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('console_identities_provider_subject_idx').on(t.provider, t.subject),
    index('console_identities_account_idx').on(t.consoleAccountId),
  ],
)

export const consoleAccountsRelations = relations(consoleAccounts, ({ many }) => ({
  identities: many(consoleIdentities),
}))

export const consoleIdentitiesRelations = relations(consoleIdentities, ({ one }) => ({
  account: one(consoleAccounts, {
    fields: [consoleIdentities.consoleAccountId],
    references: [consoleAccounts.id],
  }),
}))

export type ConsoleAccount = typeof consoleAccounts.$inferSelect
export type NewConsoleAccount = typeof consoleAccounts.$inferInsert
export type ConsoleIdentity = typeof consoleIdentities.$inferSelect
export type NewConsoleIdentity = typeof consoleIdentities.$inferInsert
