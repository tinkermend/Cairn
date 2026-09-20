import { and, eq, isNull } from 'drizzle-orm'
import { CREDENTIAL_TYPES, hasPermission, type CredentialType } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { notFound } from '../runs/errors.js'

export async function actorPermissions(db: Db, accountId: string): Promise<string[]> {
  const { consoleAccountRoles, consoleRolePermissions } = schemaFor(db)
  const rows = await db
    .select({ permission: consoleRolePermissions.permission })
    .from(consoleAccountRoles)
    .innerJoin(
      consoleRolePermissions,
      eq(consoleRolePermissions.consoleRoleId, consoleAccountRoles.consoleRoleId),
    )
    .where(eq(consoleAccountRoles.consoleAccountId, accountId))
  return [...new Set(rows.map((row) => row.permission))]
}

export function canReadCredentialType(permissions: readonly string[], type: string): boolean {
  return type === 'target_password' && hasPermission(permissions, 'target:read') && hasPermission(permissions, 'credential:read')
}

export function canWriteCredentialType(permissions: readonly string[], type: string): boolean {
  return canReadCredentialType(permissions, type) && hasPermission(permissions, 'credential:write')
}

export function readableTypes(permissions: readonly string[]): CredentialType[] {
  return CREDENTIAL_TYPES.filter((type) => canReadCredentialType(permissions, type))
}

export async function assertCredentialAccess(db: Db, id: string, actorId: string, action = 'credential:read', includeTombstone = false) {
  if (action !== 'credential:read') await lockConsoleAuthorization(db, actorId)
  const { credentials, credentialBindings, targetAccounts, targets } = schemaFor(db)
  const rows = db.select({ targetId: targets.id, accountId: targetAccounts.id }).from(credentials)
    .innerJoin(credentialBindings, and(eq(credentialBindings.credentialId, credentials.id), eq(credentialBindings.kind, 'target_account')))
    .innerJoin(targetAccounts, and(eq(targetAccounts.id, credentialBindings.targetAccountId), eq(targetAccounts.id, credentials.id), isNull(targetAccounts.deletedAt)))
    .innerJoin(targets, and(eq(targets.id, credentialBindings.targetId), eq(targets.id, targetAccounts.targetId), isNull(targets.deletedAt)))
    .where(and(eq(credentials.id, id), eq(credentials.type, 'target_password'), includeTombstone && action === 'credential:read' ? undefined : isNull(credentials.deletedAt)))
  const [row] = await rows.limit(1)
  if (!row) throw notFound('CREDENTIAL_NOT_FOUND', '账号凭据不存在或无权访问')
  await assertTargetPermission(db, actorId, row.targetId, 'credential:read')
  if (action !== 'credential:read') {
    await assertTargetPermission(db, actorId, row.targetId, action)
    const [liveTarget] = await db.select({ id: targets.id }).from(targets).where(and(eq(targets.id, row.targetId), isNull(targets.deletedAt))).for('share')
    const [liveAccount] = await db.select({ id: targetAccounts.id }).from(targetAccounts).where(and(eq(targetAccounts.id, row.accountId), isNull(targetAccounts.deletedAt))).for('update')
    const [current] = await db.select({ id: credentials.id }).from(credentials).where(and(eq(credentials.id, id), isNull(credentials.deletedAt))).for('update')
    if (!current || !liveAccount || !liveTarget) throw notFound('CREDENTIAL_NOT_FOUND', '账号凭据不存在或无权访问')
  }
  return row
}
