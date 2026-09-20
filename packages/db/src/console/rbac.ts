import type { ConsoleRole, ConsoleAccount } from '../records.js'
import { schemaFor } from '../native.js'
import { updateRows, deleteRows } from '../native.js'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  consoleAccountRoles,
  consoleAccounts,
  consoleIdentities,
  consoleRolePermissions,
  consoleRoles,
} from '../schema/index.js'
import { newId } from '../id.js'
import type { Db } from '../client.js'
import { connection, type Database } from '../database.js'
import {
  failure,
  isUniqueViolation,
  isForeignKeyViolation,
  constraintName,
  mapRestriction,
} from '../runs/errors.js'

import {
  ADMIN_ROLE_KEY,
  DEFAULT_ACCOUNT_ROLE_KEY,
  PERMISSION_CATALOG,
  accountListResponseSchema,
  accountSchema,
  operationAuditQuerySchema,
  type AuditClient,
  type LoginAuditListResponse,
  type LoginAuditQuery,
  type LoginFailureReason,
  type OperationAuditQuery,
  hasAllPermissions,
  isSystemRoleKey,
  SYSTEM_ROLE_DEFINITIONS,
  type ChangePasswordBody,
  type SetPasswordBody,
  type UpdateMeBody,
  meResponseSchema,
  permissionCatalogResponseSchema,
  roleListResponseSchema,
  roleSchema,
  uniquePermissions,
  type AccountDto,
  type AccountListResponse,
  type AssignAccountRolesBody,
  type AuditAction,
  type AuditListResponse,
  type CreateAccountBody,
  type CreateRoleBody,
  type MeResponse,
  type PermissionCatalogResponse,
  type ReplaceRolePermissionsBody,
  type RoleDto,
  type RoleListResponse,
  type UpdateAccountBody,
  type UpdateRoleBody,
  roleAccountsResponseSchema,
  type RoleAccountsResponse,
  type AddRoleAccountsBody,
  type RemoveRoleAccountsBody,
} from '@cairn/shared'
import type { PersistenceActor as RequestAccount } from './actor.js'
import { recordLoginAudit } from '../audit/record.js'
import { listLoginAuditEvents, listOperationAuditEvents } from '../audit/list.js'
import { assertScopeAdministrator, lockConsoleAuthorization } from './target-authorization.js'

function iso(value: Date): string {
  return value.toISOString()
}

export class RbacStore {
  constructor(
    private readonly database: Database,
    private readonly passwords: {
      hash: (value: string) => Promise<string>
      verify: (value: string, hash: string) => Promise<boolean>
    },
  ) {}

  private get db(): Db {
    return connection(this.database)
  }

  listPermissions(): PermissionCatalogResponse {
    return permissionCatalogResponseSchema.parse({ items: [...PERMISSION_CATALOG] })
  }

  /** 按代码目录给系统角色补缺失权限。不改自定义角色，不删已有授权。 */
  async reconcileSystemRolePermissions(): Promise<{ inserted: number }> {
    const { consoleRolePermissions, consoleRoles } = schemaFor(this.db)
    const roles = await this.db.select().from(consoleRoles)
    let inserted = 0
    for (const role of roles) {
      if (role.kind !== 'system' || !isSystemRoleKey(role.key)) continue
      const have = new Set(await this.permissionsOf(role.id))
      const missing = SYSTEM_ROLE_DEFINITIONS[role.key].permissions.filter((code) => !have.has(code))
      if (missing.length === 0) continue
      await this.db.insert(consoleRolePermissions).values(
        missing.map((permission) => ({ consoleRoleId: role.id, permission })),
      )
      inserted += missing.length
    }
    return { inserted }
  }

  async listRoles(): Promise<RoleListResponse> {
    const { consoleAccountRoles, consoleRolePermissions, consoleRoles } = schemaFor(this.db)
    const roles = await this.db.select().from(consoleRoles).orderBy(consoleRoles.key)
    const permRows = await this.db.select().from(consoleRolePermissions)
    const countRows = await this.db
      .select({
        roleId: consoleAccountRoles.consoleRoleId,
        n: sql<number>`count(*)`.as('n'),
      })
      .from(consoleAccountRoles)
      .groupBy(consoleAccountRoles.consoleRoleId)

    const permsByRole = new Map<string, string[]>()
    for (const row of permRows) {
      const list = permsByRole.get(row.consoleRoleId) ?? []
      list.push(row.permission)
      permsByRole.set(row.consoleRoleId, list)
    }
    const countByRole = new Map(countRows.map((r) => [r.roleId, Number(r.n)]))

    return roleListResponseSchema.parse({
      items: roles.map((role) =>
        this.toRoleDto(
          role,
          uniquePermissions(permsByRole.get(role.id) ?? []),
          countByRole.get(role.id) ?? 0,
        ),
      ),
    })
  }

  async getRole(id: string): Promise<RoleDto> {
    const role = await this.requireRole(id)
    const [permissions, accountCount] = await Promise.all([
      this.permissionsOf(id),
      this.accountCountOf(id),
    ])
    return this.toRoleDto(role, permissions, accountCount)
  }

  async createRole(body: CreateRoleBody, actor: RequestAccount | null): Promise<RoleDto> {
    if (actor) await assertScopeAdministrator(this.db, actor.id)
    const { consoleRolePermissions, consoleRoles } = schemaFor(this.db)
    this.assertCanGrant(actor, body.permissions)
    if (isSystemRoleKey(body.key)) {
      throw failure('conflict', '不能占用系统角色的 key')
    }
    const id = newId()
    const now = new Date()
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(consoleRoles).values({
          id,
          key: body.key,
          name: body.name,
          description: body.description ?? null,
          kind: 'custom',
          createdAt: now,
          updatedAt: now,
        })
        await tx
          .insert(consoleRolePermissions)
          .values(body.permissions.map((permission) => ({ consoleRoleId: id, permission })))
        await this.insertAudit(
          tx,
          actor?.id ?? null,
          'role.create',
          'role',
          id,
          `创建角色 ${body.key}`,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw failure('conflict', '角色 key 已存在')
      }
      throw error
    }
    return this.getRole(id)
  }

  async updateRole(
    id: string,
    body: UpdateRoleBody,
    actor: RequestAccount | null,
  ): Promise<RoleDto> {
    const { consoleRolePermissions, consoleRoles } = schemaFor(this.db)
    if (body.permissions && actor) await assertScopeAdministrator(this.db, actor.id)
    const role = await this.requireRole(id)
    if (role.kind === 'system') {
      throw failure('bad_request', '系统角色不可修改')
    }
    if (body.permissions) this.assertCanGrant(actor, body.permissions)
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(consoleRoles)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            updatedAt: new Date(),
          })
          .where(eq(consoleRoles.id, id))
        if (body.permissions) {
          const { consoleAccountRoles } = schemaFor(tx)
          const members = await tx.select({ id: consoleAccountRoles.consoleAccountId }).from(consoleAccountRoles)
            .where(eq(consoleAccountRoles.consoleRoleId, id))
          for (const memberId of [...new Set(members.map((member) => member.id))].sort()) await lockConsoleAuthorization(tx, memberId)
          if (actor) await assertScopeAdministrator(tx, actor.id)
          await tx
            .delete(consoleRolePermissions)
            .where(eq(consoleRolePermissions.consoleRoleId, id))
          await tx
            .insert(consoleRolePermissions)
            .values(body.permissions.map((permission) => ({ consoleRoleId: id, permission })))
        }
        await this.insertAudit(
          tx,
          actor?.id ?? null,
          'role.update',
          'role',
          id,
          `更新角色 ${role.key}`,
        )
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw failure('conflict', '角色 key 已存在')
      }
      throw error
    }
    return this.getRole(id)
  }

  async replaceRolePermissions(
    id: string,
    body: ReplaceRolePermissionsBody,
    actor: RequestAccount | null,
  ): Promise<RoleDto> {
    return this.updateRole(id, { permissions: body.permissions }, actor)
  }

  async deleteRole(id: string, actor: RequestAccount | null): Promise<void> {
    const { consoleRoles } = schemaFor(this.db)
    const role = await this.requireRole(id)
    if (role.kind === 'system') {
      throw failure('bad_request', '系统角色不可删除')
    }
    const accountCount = await this.accountCountOf(id)
    if (accountCount > 0) {
      throw failure('conflict', '仍有账号使用该角色')
    }
    await this.db.transaction(async (tx) => {
      await this.insertAudit(
        tx,
        actor?.id ?? null,
        'role.delete',
        'role',
        id,
        `删除角色 ${role.key}`,
      )
      await tx.delete(consoleRoles).where(eq(consoleRoles.id, id))
    })
  }

  async listRoleAccounts(
    roleId: string,
    query?: { cursor?: string; limit?: number; search?: string },
  ): Promise<RoleAccountsResponse> {
    await this.requireRole(roleId)
    const { consoleAccountRoles, consoleAccounts } = schemaFor(this.db)
    const limit = query?.limit ?? 50
    const conditions = [eq(consoleAccountRoles.consoleRoleId, roleId)]
    if (query?.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`
      conditions.push(
        or(
          sql`lower(${consoleAccounts.displayName}) like ${term}`,
          sql`lower(${consoleAccounts.email}) like ${term}`,
        )!,
      )
    }
    const rows = await this.db
      .select({
        id: consoleAccounts.id,
        displayName: consoleAccounts.displayName,
        email: consoleAccounts.email,
        status: consoleAccounts.status,
        assignedAt: consoleAccountRoles.assignedAt,
      })
      .from(consoleAccountRoles)
      .innerJoin(consoleAccounts, eq(consoleAccounts.id, consoleAccountRoles.consoleAccountId))
      .where(and(...conditions))
      .orderBy(desc(consoleAccountRoles.assignedAt), desc(consoleAccounts.id))
      .limit(limit + 1)

    const hasNext = rows.length > limit
    const pageRows = hasNext ? rows.slice(0, limit) : rows
    const lastItem = pageRows[pageRows.length - 1]
    const nextCursor = hasNext && lastItem ? lastItem.id : undefined

    return roleAccountsResponseSchema.parse({
      items: pageRows.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        email: r.email,
        status: r.status,
        assignedAt: iso(r.assignedAt),
      })),
      nextCursor,
    })
  }

  async addRoleAccounts(
    roleId: string,
    body: AddRoleAccountsBody,
    actor: RequestAccount | null,
  ): Promise<{ addedCount: number }> {
    if (actor) await assertScopeAdministrator(this.db, actor.id)
    const role = await this.requireRole(roleId)
    const { consoleAccountRoles, consoleAccounts } = schemaFor(this.db)
    await this.assertCanGrantRoles(actor, [roleId])

    const accountIds = [...new Set(body.accountIds)]
    if (accountIds.length === 0) return { addedCount: 0 }

    const existingAccounts = await this.db
      .select({ id: consoleAccounts.id })
      .from(consoleAccounts)
      .where(inArray(consoleAccounts.id, accountIds))

    if (existingAccounts.length !== accountIds.length) {
      throw failure('bad_request', '包含不存在的账号')
    }

    const alreadyAssigned = await this.db
      .select({ accountId: consoleAccountRoles.consoleAccountId })
      .from(consoleAccountRoles)
      .where(
        and(
          eq(consoleAccountRoles.consoleRoleId, roleId),
          inArray(consoleAccountRoles.consoleAccountId, accountIds),
        ),
      )
    const alreadySet = new Set(alreadyAssigned.map((r) => r.accountId))
    const toInsert = accountIds.filter((id) => !alreadySet.has(id))

    if (toInsert.length === 0) return { addedCount: 0 }

    const now = new Date()
    await this.db.transaction(async (tx) => {
      for (const accountId of [...toInsert].sort()) await lockConsoleAuthorization(tx, accountId)
      if (actor) await assertScopeAdministrator(tx, actor.id)
      await tx.insert(consoleAccountRoles).values(
        toInsert.map((consoleAccountId) => ({
          consoleAccountId,
          consoleRoleId: roleId,
          assignedAt: now,
          assignedByConsoleAccountId: actor?.id ?? null,
          targetScopeMode: role.kind === 'system' && role.key === ADMIN_ROLE_KEY ? 'all' as const : 'none' as const,
        })),
      )
      await this.insertAudit(
        tx,
        actor?.id ?? null,
        'account.roles',
        'role',
        roleId,
        `向角色 ${role.name} 添加了 ${toInsert.length} 名成员`,
      )
    })

    return { addedCount: toInsert.length }
  }

  async removeRoleAccounts(
    roleId: string,
    body: RemoveRoleAccountsBody,
    actor: RequestAccount | null,
  ): Promise<{ removedCount: number }> {
    const role = await this.requireRole(roleId)
    const { consoleAccountRoles } = schemaFor(this.db)
    const accountIds = [...new Set(body.accountIds)]
    if (accountIds.length === 0) return { removedCount: 0 }

    if (role.key === ADMIN_ROLE_KEY) {
      for (const accountId of accountIds) {
        await this.assertNotLastActiveAdmin(accountId, 'active', [])
      }
    }

    await this.db.transaction(async (tx) => {
      for (const accountId of [...accountIds].sort()) await lockConsoleAuthorization(tx, accountId)
      await tx
        .delete(consoleAccountRoles)
        .where(
          and(
            eq(consoleAccountRoles.consoleRoleId, roleId),
            inArray(consoleAccountRoles.consoleAccountId, accountIds),
          ),
        )
      await this.insertAudit(
        tx,
        actor?.id ?? null,
        'account.roles',
        'role',
        roleId,
        `从角色 ${role.name} 移除了成员`,
      )
    })

    return { removedCount: accountIds.length }
  }

  async listAccounts(): Promise<AccountListResponse> {
    const { consoleAccounts } = schemaFor(this.db)
    const rows = await this.db.select().from(consoleAccounts).orderBy(consoleAccounts.createdAt)
    const items = await this.assembleAccounts(rows)
    return accountListResponseSchema.parse({ items })
  }

  async getAccount(id: string): Promise<AccountDto> {
    const { consoleAccounts } = schemaFor(this.db)
    const [row] = await this.db
      .select()
      .from(consoleAccounts)
      .where(eq(consoleAccounts.id, id))
      .limit(1)
    if (!row) throw failure('not_found', '账号不存在')
    const [account] = await this.assembleAccounts([row])
    return accountSchema.parse(account)
  }

  async getMe(accountId: string): Promise<MeResponse> {
    return meResponseSchema.parse({ account: await this.getAccount(accountId) })
  }

  async updateMe(accountId: string, body: UpdateMeBody): Promise<MeResponse> {
    const { consoleAccounts } = schemaFor(this.db)
    const current = await this.getAccount(accountId)
    await this.db
      .update(consoleAccounts)
      .set({ displayName: body.displayName, updatedAt: new Date() })
      .where(eq(consoleAccounts.id, accountId))
    await this.recordAudit(
      accountId,
      'account.update',
      'account',
      accountId,
      `修改了自己的显示名（${current.displayName} → ${body.displayName}）`,
    )
    return this.getMe(accountId)
  }

  async createAccount(body: CreateAccountBody, actor: RequestAccount | null): Promise<AccountDto> {
    const { consoleAccountRoles, consoleAccounts, consoleIdentities } = schemaFor(this.db)
    const id = newId()
    const now = new Date()
    const email = body.email.trim().toLowerCase()
    const roleIds = body.roleIds?.length
      ? body.roleIds
      : [await this.roleIdByKey(DEFAULT_ACCOUNT_ROLE_KEY)]
    await this.requireRolesExist(roleIds)
    await this.assertCanGrantRoles(actor, roleIds)
    const adminRoleId = await this.roleIdByKey(ADMIN_ROLE_KEY)
    const scopes = body.targetScopes ?? []
    if (new Set(scopes.map(s => s.roleId)).size !== scopes.length || scopes.some(s => !roleIds.includes(s.roleId) || s.roleId === adminRoleId && s.mode !== 'all')) throw failure('bad_request', '目标范围与角色不匹配')
    const targetIds = [...new Set(scopes.flatMap(s => s.targetIds))]
    if (targetIds.length) {
      const { targets } = schemaFor(this.db)
      const found = await this.db.select({ id: targets.id }).from(targets).where(and(inArray(targets.id, targetIds), sql`${targets.deletedAt} IS NULL`))
      if (found.length !== targetIds.length) throw failure('bad_request', '包含不存在的目标系统')
    }
    const secret = await this.passwords.hash(body.password)
    try {
      await this.db.transaction(async (tx) => {
        if (actor) { await lockConsoleAuthorization(tx, actor.id); await assertScopeAdministrator(tx, actor.id) }
        await tx.insert(consoleAccounts).values({
          id,
          displayName: body.displayName,
          email,
          status: body.status ?? 'active',
          createdAt: now,
          updatedAt: now,
        })
        await tx.insert(consoleIdentities).values({
          id: newId(),
          consoleAccountId: id,
          provider: 'local',
          subject: email,
          secret,
          createdAt: now,
        })
        await tx.insert(consoleAccountRoles).values(
          roleIds.map((consoleRoleId) => ({
            consoleAccountId: id,
            consoleRoleId,
            assignedAt: now,
            assignedByConsoleAccountId: actor?.id ?? null,
            targetScopeMode: consoleRoleId === adminRoleId ? 'all' as const : scopes.find(s => s.roleId === consoleRoleId)?.mode ?? 'none',
            targetScopeIds: consoleRoleId === adminRoleId ? [] : scopes.find(s => s.roleId === consoleRoleId)?.targetIds ?? [],
          })),
        )
        await this.insertAudit(
          tx,
          actor?.id ?? null,
          'account.create',
          'account',
          id,
          `创建账号 ${email}`,
        )
      })
    } catch (error) {
      this.rethrowAccountWriteError(error)
    }
    return this.getAccount(id)
  }

  async updateAccount(
    id: string,
    body: UpdateAccountBody,
    actor: RequestAccount | null,
  ): Promise<AccountDto> {
    const { consoleAccounts, consoleIdentities } = schemaFor(this.db)
    const current = await this.getAccount(id)
    if (actor && id === actor.id && body.status === 'disabled') {
      throw failure('forbidden', '不能停用自己的账号')
    }
    const nextStatus = body.status ?? current.status
    if (nextStatus === 'disabled' || (body.status === 'disabled' && current.status === 'active')) {
      await this.assertNotLastActiveAdmin(
        id,
        nextStatus,
        current.roles.map((r) => r.id),
      )
    }
    const nextEmail =
      body.email === undefined
        ? undefined
        : body.email === null
          ? null
          : body.email.trim().toLowerCase()
    try {
      await this.db.transaction(async (tx) => {
        const [updated] = await updateRows(
          tx,
          consoleAccounts,
          {
            ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(nextEmail !== undefined ? { email: nextEmail } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
            updatedAt: new Date(),
          },
          eq(consoleAccounts.id, id),
        )
        if (!updated) throw failure('not_found', '账号不存在')
        if (nextEmail) {
          await tx
            .update(consoleIdentities)
            .set({ subject: nextEmail })
            .where(
              and(
                eq(consoleIdentities.consoleAccountId, id),
                eq(consoleIdentities.provider, 'local'),
              ),
            )
        }
        await this.insertAudit(
          tx,
          actor?.id ?? null,
          'account.update',
          'account',
          id,
          `更新账号 ${current.displayName}`,
        )
      })
    } catch (error) {
      this.rethrowAccountWriteError(error)
    }
    return this.getAccount(id)
  }

  async deleteAccount(id: string, actor: RequestAccount | null): Promise<void> {
    const { consoleAccounts } = schemaFor(this.db)
    const current = await this.getAccount(id)
    if (actor && id === actor.id) {
      throw failure('forbidden', '不能删除自己的账号')
    }
    await this.assertNotLastActiveAdmin(
      id,
      'disabled',
      current.roles.map((r) => r.id),
    )
    await this.db.transaction(async (tx) => {
      await this.insertAudit(
        tx,
        actor?.id ?? null,
        'account.delete',
        'account',
        id,
        `删除账号 ${current.displayName}`,
      )
      const deleted = await deleteRows(tx, consoleAccounts, eq(consoleAccounts.id, id), {
        id: consoleAccounts.id,
      })
      if (deleted.length === 0) throw failure('not_found', '账号不存在')
    })
  }

  async assignAccountRoles(
    id: string,
    body: AssignAccountRolesBody,
    actor: RequestAccount | null,
  ): Promise<AccountDto> {
    const { consoleAccountRoles, consoleAccounts } = schemaFor(this.db)
    const current = await this.getAccount(id)
    await this.requireRolesExist(body.roleIds)
    await this.assertCanGrantRoles(actor, body.roleIds)
    await this.assertNotLastActiveAdmin(id, current.status, body.roleIds)
    if (actor) await assertScopeAdministrator(this.db, actor.id)
    const adminRoleId = await this.roleIdByKey(ADMIN_ROLE_KEY)
    const scopes = body.targetScopes ?? current.targetScopes ?? []
    if (new Set(scopes.map((scope) => scope.roleId)).size !== scopes.length ||
      (body.targetScopes && scopes.some((scope) => !body.roleIds.includes(scope.roleId)))) {
      throw failure('bad_request', '目标范围必须对应唯一的已选角色')
    }
    const targetIds = [...new Set(scopes.flatMap((scope) => scope.targetIds))]
    if (targetIds.length) {
      const { targets } = schemaFor(this.db)
      const found = await this.db.select({ id: targets.id }).from(targets).where(and(inArray(targets.id, targetIds), sql`${targets.deletedAt} IS NULL`))
      if (found.length !== targetIds.length) throw failure('bad_request', '包含不存在的目标系统')
    }
    if (scopes.some((scope) => scope.roleId === adminRoleId && scope.mode !== 'all')) throw failure('bad_request', '系统管理员角色须保持全部目标范围')
    const now = new Date()
    await this.db.transaction(async (tx) => {
      await lockConsoleAuthorization(tx, id, false)
      if (actor) await assertScopeAdministrator(tx, actor.id)
      await tx.delete(consoleAccountRoles).where(eq(consoleAccountRoles.consoleAccountId, id))
      await tx.insert(consoleAccountRoles).values(
        body.roleIds.map((consoleRoleId) => ({
          consoleAccountId: id,
          consoleRoleId,
          assignedAt: now,
          assignedByConsoleAccountId: actor?.id ?? null,
          targetScopeMode: consoleRoleId === adminRoleId ? 'all' : scopes.find((scope) => scope.roleId === consoleRoleId)?.mode ?? 'none',
          targetScopeIds: consoleRoleId === adminRoleId ? [] : scopes.find((scope) => scope.roleId === consoleRoleId)?.targetIds ?? [],
        })),
      )
      await tx.update(consoleAccounts).set({ updatedAt: now }).where(eq(consoleAccounts.id, id))
      await this.insertAudit(
        tx,
        actor?.id ?? null,
        'account.roles',
        'account',
        id,
        `调整账号 ${current.displayName} 的角色`,
      )
      if (body.targetScopes) await this.insertAudit(tx, actor?.id ?? null, 'account.roles', 'account', id,
        `调整目标范围 ${current.displayName}：${JSON.stringify(scopes)}`)
    })
    return this.getAccount(id)
  }

  async changePassword(accountId: string, body: ChangePasswordBody): Promise<void> {
    const { consoleIdentities } = schemaFor(this.db)
    const identity = await this.requireLocalIdentity(accountId)
    const ok = await this.passwords.verify(body.currentPassword, identity.secret!)
    if (!ok) throw failure('forbidden', '当前密码不正确')
    await this.db
      .update(consoleIdentities)
      .set({ secret: await this.passwords.hash(body.newPassword) })
      .where(eq(consoleIdentities.id, identity.id))
    await this.recordAudit(accountId, 'account.password', 'account', accountId, '修改了自己的密码')
  }

  async setPassword(
    accountId: string,
    body: SetPasswordBody,
    actor: RequestAccount,
  ): Promise<void> {
    const { consoleIdentities } = schemaFor(this.db)
    const account = await this.getAccount(accountId)
    const identity = await this.findLocalIdentityByAccount(accountId)
    if (!identity) {
      if (!account.email) throw failure('bad_request', '该账号没有登录名，无法设置本地密码')
      await this.createLocalIdentity(accountId, account.email, body.password)
    } else {
      await this.db
        .update(consoleIdentities)
        .set({ secret: await this.passwords.hash(body.password) })
        .where(eq(consoleIdentities.id, identity.id))
    }
    await this.recordAudit(
      actor.id,
      'account.password',
      'account',
      accountId,
      `重置了 ${account.displayName} 的密码`,
    )
  }

  async createLocalIdentity(accountId: string, email: string, password: string): Promise<void> {
    const { consoleIdentities } = schemaFor(this.db)
    await this.db.insert(consoleIdentities).values({
      id: newId(),
      consoleAccountId: accountId,
      provider: 'local',
      subject: email.trim().toLowerCase(),
      secret: await this.passwords.hash(password),
      createdAt: new Date(),
    })
  }

  async recordAudit(
    actorId: string | null,
    action: AuditAction,
    resource: string,
    resourceId: string | null,
    summary: string,
  ): Promise<void> {
    await this.insertAudit(this.db, actorId, action, resource, resourceId, summary)
  }

  async listAuditEvents(
    query: OperationAuditQuery = operationAuditQuerySchema.parse({}),
  ): Promise<AuditListResponse> {
    return listOperationAuditEvents(this.db, query)
  }

  async listLoginAuditEvents(query: LoginAuditQuery): Promise<LoginAuditListResponse> {
    return listLoginAuditEvents(this.db, query)
  }

  async completeSuccessfulLogin(input: {
    identityId: string
    accountId: string
    identifier: string
    client?: AuditClient
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { consoleIdentities } = schemaFor(tx)
      await tx
        .update(consoleIdentities)
        .set({ lastUsedAt: new Date() })
        .where(eq(consoleIdentities.id, input.identityId))
      await recordLoginAudit(tx as unknown as Db, {
        identifier: input.identifier,
        outcome: 'success',
        accountId: input.accountId,
        client: input.client,
      })
    })
  }

  async recordLoginFailure(input: {
    identifier: string
    reason: LoginFailureReason
    accountId?: string | null
    client?: AuditClient
  }): Promise<void> {
    await recordLoginAudit(this.db, {
      identifier: input.identifier,
      outcome: 'failure',
      failureReason: input.reason,
      accountId: input.accountId ?? null,
      client: input.client,
    })
  }

  private async requireRole(id: string) {
    const { consoleRoles } = schemaFor(this.db)
    const [role] = await this.db.select().from(consoleRoles).where(eq(consoleRoles.id, id)).limit(1)
    if (!role) throw failure('not_found', '角色不存在')
    return role
  }

  /**
   * 系统角色的稳定标识是 key，不是 id——id 是 seed 时生成的 UUID。
   * 拿 `ADMIN_ROLE_KEY` 当 id 用会静默查不到行，让「最后一个管理员」
   * 这类守卫失效，所以一律先解析。
   */
  private async roleIdByKey(key: string): Promise<string> {
    const { consoleRoles } = schemaFor(this.db)
    const [role] = await this.db
      .select({ id: consoleRoles.id })
      .from(consoleRoles)
      .where(eq(consoleRoles.key, key))
      .limit(1)
    if (!role) throw new Error(`系统角色缺失：${key}（0002_rbac 未执行？）`)
    return role.id
  }

  private async requireRolesExist(ids: string[]): Promise<void> {
    const { consoleRoles } = schemaFor(this.db)
    const unique = [...new Set(ids)]
    const rows = await this.db
      .select({ id: consoleRoles.id })
      .from(consoleRoles)
      .where(inArray(consoleRoles.id, unique))
    if (rows.length !== unique.length) {
      throw failure('bad_request', '包含不存在的角色')
    }
  }

  private async permissionsOf(roleId: string): Promise<string[]> {
    const { consoleRolePermissions } = schemaFor(this.db)
    const rows = await this.db
      .select({ permission: consoleRolePermissions.permission })
      .from(consoleRolePermissions)
      .where(eq(consoleRolePermissions.consoleRoleId, roleId))
    return uniquePermissions(rows.map((r) => r.permission))
  }

  private async accountCountOf(roleId: string): Promise<number> {
    const { consoleAccountRoles } = schemaFor(this.db)
    const [row] = await this.db
      .select({ n: sql<number>`count(*)`.as('n') })
      .from(consoleAccountRoles)
      .where(eq(consoleAccountRoles.consoleRoleId, roleId))
    return Number(row?.n ?? 0)
  }

  private toRoleDto(role: ConsoleRole, permissions: string[], accountCount: number): RoleDto {
    return roleSchema.parse({
      id: role.id,
      key: role.key,
      name: role.name,
      kind: role.kind,
      description: role.description,
      permissions,
      accountCount,
      createdAt: iso(role.createdAt),
      updatedAt: iso(role.updatedAt),
    })
  }

  private async assembleAccounts(rows: ConsoleAccount[]): Promise<AccountDto[]> {
    const { consoleAccountRoles, consoleRolePermissions, consoleRoles } = schemaFor(this.db)
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const bindRows = await this.db
      .select({
        accountId: consoleAccountRoles.consoleAccountId,
        roleId: consoleRoles.id,
        key: consoleRoles.key,
        name: consoleRoles.name,
        kind: consoleRoles.kind,
        permission: consoleRolePermissions.permission,
        scopeMode: consoleAccountRoles.targetScopeMode,
        scopeIds: consoleAccountRoles.targetScopeIds,
      })
      .from(consoleAccountRoles)
      .innerJoin(consoleRoles, eq(consoleRoles.id, consoleAccountRoles.consoleRoleId))
      .leftJoin(consoleRolePermissions, eq(consoleRolePermissions.consoleRoleId, consoleRoles.id))
      .where(inArray(consoleAccountRoles.consoleAccountId, ids))

    const rolesByAccount = new Map<string, Map<string, AccountDto['roles'][number]>>()
    const permsByAccount = new Map<string, string[]>()
    for (const row of bindRows) {
      const roleMap = rolesByAccount.get(row.accountId) ?? new Map()
      roleMap.set(row.roleId, { id: row.roleId, key: row.key, name: row.name, kind: row.kind })
      rolesByAccount.set(row.accountId, roleMap)
      if (row.permission) {
        const perms = permsByAccount.get(row.accountId) ?? []
        perms.push(row.permission)
        permsByAccount.set(row.accountId, perms)
      }
    }

    return rows.map((row) =>
      accountSchema.parse({
        id: row.id,
        displayName: row.displayName,
        email: row.email,
        status: row.status,
        roles: [...(rolesByAccount.get(row.id)?.values() ?? [])],
        permissions: uniquePermissions(permsByAccount.get(row.id) ?? []),
        targetScopes: [...new Map(bindRows.filter((binding) => binding.accountId === row.id).map((binding) => [binding.roleId, {
          roleId: binding.roleId, mode: binding.scopeMode, targetIds: binding.scopeIds,
        }])).values()],
        targetScopePermissions: [...(rolesByAccount.get(row.id)?.keys() ?? [])].map(roleId => ({ roleId, permissions: bindRows.filter(b => b.accountId === row.id && b.roleId === roleId && b.permission).map(b => b.permission!) })),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }),
    )
  }

  /**
   * 最后一个处于 active 且持有 admin 角色的账号，不能被停用、删除或撤掉 admin。
   */
  private async assertNotLastActiveAdmin(
    accountId: string,
    nextStatus: AccountDto['status'],
    nextRoleIds: string[],
  ): Promise<void> {
    const { consoleAccountRoles, consoleAccounts } = schemaFor(this.db)
    const adminRoleId = await this.roleIdByKey(ADMIN_ROLE_KEY)
    const adminRows = await this.db
      .select({ accountId: consoleAccountRoles.consoleAccountId })
      .from(consoleAccountRoles)
      .innerJoin(consoleAccounts, eq(consoleAccounts.id, consoleAccountRoles.consoleAccountId))
      .where(
        and(
          eq(consoleAccountRoles.consoleRoleId, adminRoleId),
          eq(consoleAccounts.status, 'active'),
        ),
      )

    const activeAdmins = new Set(adminRows.map((r) => r.accountId))
    const currentlyAdmin = activeAdmins.has(accountId)
    const willBeAdmin = nextStatus === 'active' && nextRoleIds.includes(adminRoleId)
    if (willBeAdmin || !currentlyAdmin) return
    if (activeAdmins.size <= 1) {
      throw failure('conflict', '不能移除最后一个管理员')
    }
  }

  private rethrowAccountWriteError(error: unknown): never {
    if (isUniqueViolation(error)) {
      throw failure('conflict', '邮箱已被使用')
    }
    if (isForeignKeyViolation(error)) {
      throw failure('bad_request', '包含不存在的角色')
    }
    throw error
  }

  /**
   * 不能授予自己没有的权限。bootstrap（actor 为空）跳过——它只在空库种首位 admin。
   */
  private assertCanGrant(actor: RequestAccount | null, permissions: readonly string[]): void {
    if (!actor) return
    if (!hasAllPermissions(actor.permissions, permissions)) {
      throw failure('forbidden', '不能授予超出自身权限的角色或权限')
    }
  }

  private async assertCanGrantRoles(
    actor: RequestAccount | null,
    roleIds: string[],
  ): Promise<void> {
    const { consoleRolePermissions } = schemaFor(this.db)
    if (!actor) return
    await assertScopeAdministrator(this.db, actor.id)
    const unique = [...new Set(roleIds)]
    const rows = await this.db
      .select({ permission: consoleRolePermissions.permission })
      .from(consoleRolePermissions)
      .where(inArray(consoleRolePermissions.consoleRoleId, unique))
    this.assertCanGrant(actor, uniquePermissions(rows.map((r) => r.permission)))
  }

  private async findLocalIdentityByAccount(accountId: string) {
    const { consoleIdentities } = schemaFor(this.db)
    const [row] = await this.db
      .select()
      .from(consoleIdentities)
      .where(
        and(
          eq(consoleIdentities.consoleAccountId, accountId),
          eq(consoleIdentities.provider, 'local'),
        ),
      )
      .limit(1)
    return row ?? null
  }

  private async requireLocalIdentity(accountId: string) {
    const identity = await this.findLocalIdentityByAccount(accountId)
    if (!identity?.secret) throw failure('bad_request', '该账号没有本地密码')
    return identity
  }

  private async insertAudit(
    db: Db,
    actorId: string | null,
    action: AuditAction,
    resource: string,
    resourceId: string | null,
    summary: string,
  ): Promise<void> {
    const { consoleAuditEvents } = schemaFor(db)
    await db.insert(consoleAuditEvents).values({
      id: newId(),
      actorConsoleAccountId: actorId,
      action,
      resource,
      resourceId,
      summary,
      category: 'operation',
      loginIdentifier: null,
      outcome: null,
      failureReason: null,
      createdAt: new Date(),
    })
  }
}
