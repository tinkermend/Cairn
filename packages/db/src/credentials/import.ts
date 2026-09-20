import { and, eq, isNull } from 'drizzle-orm'
import { credentialImportResolveBodySchema, type CredentialImportResolveBody, type CredentialImportResolveResponse } from '@cairn/shared'
import type { AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { assertTargetPermission, targetScopeFilter, targetScopeFor } from '../console/target-authorization.js'
import { getCredential } from './catalog.js'
import { assertCredentialAccess } from './access.js'

export async function resolveCredentialImport(db: Db, raw: CredentialImportResolveBody, actor: AuditActor) {
  const body = credentialImportResolveBodySchema.parse(raw)
  const { targetAccounts, targets, credentialBindings, credentials } = schemaFor(db)
  const readScope = await targetScopeFor(db, actor.id, 'credential:read')
  const targetScope = await targetScopeFor(db, actor.id, 'target:read')
  const writeScope = await targetScopeFor(db, actor.id, 'credential:write')
  const importScope = await targetScopeFor(db, actor.id, 'credential:import')
  const rows: CredentialImportResolveResponse['rows'] = []
  for (const row of body.rows) {
    let item = null
    if (row.credentialId || row.targetAccountId || ((row.targetId || row.targetCode) && row.username)) {
      const [found] = await db.select({ id: credentials.id }).from(credentials)
        .innerJoin(credentialBindings, eq(credentialBindings.credentialId, credentials.id))
        .innerJoin(targetAccounts, and(eq(targetAccounts.id, credentialBindings.targetAccountId), eq(targetAccounts.id, credentials.id)))
        .innerJoin(targets, and(eq(targets.id, targetAccounts.targetId), eq(targets.id, credentialBindings.targetId)))
        .where(and(eq(credentials.type, 'target_password'), isNull(credentials.deletedAt), isNull(targets.deletedAt), isNull(targetAccounts.deletedAt),
          targetScopeFilter(targets.id, readScope), targetScopeFilter(targets.id, targetScope), targetScopeFilter(targets.id, writeScope), targetScopeFilter(targets.id, importScope),
          row.credentialId ? eq(credentials.id, row.credentialId) : undefined,
          row.targetAccountId ? eq(targetAccounts.id, row.targetAccountId) : undefined,
          row.targetId ? eq(targets.id, row.targetId) : undefined,
          row.targetCode ? eq(targets.code, row.targetCode) : undefined,
          row.username ? eq(targetAccounts.username, row.username) : undefined)).limit(1)
      if (found) item = await getCredential(db, found.id, actor)
    }
    rows.push({ row: row.row, item, error: item ? null : '未找到可维护对象或无权访问，请核对目标编码与登录名' })
  }
  const duplicates = new Set(rows.filter((row, index) => row.item && rows.some((other, i) => i !== index && other.item?.id === row.item!.id)).map((row) => row.item!.id))
  return { rows: rows.map((row) => row.item && duplicates.has(row.item.id) ? { ...row, error: '同一账号在文件中重复出现，请删除重复行' } : row) }
}

export async function credentialOwnerCandidates(db: Db, id: string, actor: AuditActor) {
  const binding = await assertCredentialAccess(db, id, actor.id)
  const { consoleAccounts } = schemaFor(db)
  const accounts = await db.select({ id: consoleAccounts.id, name: consoleAccounts.displayName }).from(consoleAccounts).where(eq(consoleAccounts.status, 'active'))
  const items = []
  for (const account of accounts) {
    try { await assertTargetPermission(db, account.id, binding.targetId, 'credential:read'); items.push(account) } catch { /* not a visible candidate */ }
  }
  return { items }
}
