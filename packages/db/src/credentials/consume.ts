import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { ACTIVE_RUN_STATUSES, type FrozenCredentialBinding, type RunSnapshot } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DomainError } from '../runs/errors.js'

export type CredentialConsumeGrant = {
  username: string
  secretId: string
  provider: string
  credentialId: string
  versionId: string
  identityRevision: number | null
}

export class CredentialConsumeDenied extends DomainError {
  constructor(code: string, message: string) {
    super('forbidden', code, message)
  }
}

export async function authorizeSecretConsume(
  db: Db,
  input: { secretId: string; expectedUsername?: string },
): Promise<CredentialConsumeGrant> {
  const { credentials, credentialBindings, credentialVersions } = schemaFor(db)
  const versions = await db
    .select()
    .from(credentialVersions)
    .where(eq(credentialVersions.secretId, input.secretId))
  const version =
    versions.find((row) => input.expectedUsername && row.identityUsername === input.expectedUsername) ??
    versions.find((row) => row.materialStatus === 'current') ??
    versions[0]
  if (!version) {
    throw new CredentialConsumeDenied('CREDENTIAL_MATERIAL_UNAVAILABLE', '历史凭据材料不可用')
  }
  if (version.materialStatus === 'revoked' || version.materialStatus === 'cleared') {
    throw new CredentialConsumeDenied(
      'CREDENTIAL_VERSION_REVOKED',
      '该凭据版本已撤销或已清除，不能再取用',
    )
  }
  if (version.materialStatus === 'unavailable') {
    throw new CredentialConsumeDenied('CREDENTIAL_MATERIAL_UNAVAILABLE', '历史凭据材料不可用')
  }
  const [catalog] = await db.select().from(credentials).where(eq(credentials.id, version.credentialId)).limit(1)
  if (!catalog || catalog.deletedAt || catalog.managementStatus === 'disabled') {
    throw new CredentialConsumeDenied('CREDENTIAL_DISABLED', '凭据目录已暂停取用')
  }
  const [binding] = await db
    .select()
    .from(credentialBindings)
    .where(eq(credentialBindings.credentialId, version.credentialId))
    .limit(1)
  const username = version.identityUsername ?? input.expectedUsername ?? binding?.identityUsername
  if (!username) {
    throw new CredentialConsumeDenied('CREDENTIAL_MATERIAL_UNAVAILABLE', '无法证明身份与凭据配对')
  }
  if (input.expectedUsername && version.identityUsername && input.expectedUsername !== version.identityUsername) {
    throw new CredentialConsumeDenied('CREDENTIAL_BINDING_MISMATCH', '冻结的登录名与凭据版本不配对')
  }
  if (!version.secretId || !version.secretProvider) {
    throw new CredentialConsumeDenied('CREDENTIAL_MATERIAL_UNAVAILABLE', '该类型凭据不能解密取用')
  }
  return {
    username,
    secretId: version.secretId,
    provider: version.secretProvider,
    credentialId: version.credentialId,
    versionId: version.id,
    identityRevision: version.identityRevision,
  }
}

export async function resolveSnapshotCredential(
  db: Db,
  snapshot: Pick<RunSnapshot, 'secretRef' | 'credentialBinding' | 'targetAccountId'>,
): Promise<CredentialConsumeGrant | null> {
  if (!snapshot.secretRef) return null
  const binding = snapshot.credentialBinding as FrozenCredentialBinding | undefined
  try {
    return await authorizeSecretConsume(db, {
      secretId: snapshot.secretRef.secretId,
      expectedUsername: binding?.identityUsername,
    })
  } catch (error) {
    if (error instanceof CredentialConsumeDenied) return null
    throw error
  }
}

export async function resolveAccountCurrentCredential(
  db: Db,
  accountId: string,
): Promise<CredentialConsumeGrant | null> {
  const { credentialBindings, targetAccounts } = schemaFor(db)
  const [account] = await db.select().from(targetAccounts).where(eq(targetAccounts.id, accountId)).limit(1)
  if (!account?.secretId) return null
  const [binding] = await db
    .select()
    .from(credentialBindings)
    .where(eq(credentialBindings.targetAccountId, accountId))
    .limit(1)
  if (binding?.identityConfirmStatus === 'pending_reconfirm') {
    return null
  }
  try {
    return await authorizeSecretConsume(db, { secretId: account.secretId, expectedUsername: account.username })
  } catch (error) {
    if (error instanceof CredentialConsumeDenied) return null
    throw error
  }
}

export async function secretIdsStillReferenced(
  db: Db,
  secretIds: string[],
  excludeVersionIds: string[] = [],
): Promise<Set<string>> {
  if (secretIds.length === 0) return new Set()
  const { credentialVersions, targetAccounts, platformAiSecretBindings, runs } = schemaFor(db)
  const used = new Set<string>()
  const versions = await db
    .select({ secretId: credentialVersions.secretId, id: credentialVersions.id, status: credentialVersions.materialStatus })
    .from(credentialVersions)
    .where(inArray(credentialVersions.secretId, secretIds))
  for (const row of versions) {
    if (!row.secretId) continue
    if (excludeVersionIds.includes(row.id)) continue
    if (row.status === 'cleared' || row.status === 'revoked' || row.status === 'unavailable') continue
    used.add(row.secretId)
  }
  const accounts = await db
    .select({ secretId: targetAccounts.secretId })
    .from(targetAccounts)
    .where(and(inArray(targetAccounts.secretId, secretIds), isNull(targetAccounts.deletedAt)))
  for (const row of accounts) if (row.secretId) used.add(row.secretId)
  const bindings = await db
    .select({ secretId: platformAiSecretBindings.secretId })
    .from(platformAiSecretBindings)
    .where(inArray(platformAiSecretBindings.secretId, secretIds))
  for (const row of bindings) used.add(row.secretId)

  const snapshots = await db
    .select({ snapshot: runs.snapshot })
    .from(runs)
    .where(
      and(
        isNull(runs.deletedAt),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
  for (const row of snapshots) {
    const ref = (row.snapshot as { secretRef?: { secretId?: string } } | null)?.secretRef?.secretId
    if (ref && secretIds.includes(ref)) used.add(ref)
  }
  return used
}

export async function recordCredentialVerification(
  db: Db,
  input: {
    secretId: string
    identityRevision?: number | null
    sessionId?: string | null
    sessionGeneration?: number | null
    source: 'run' | 'maintenance'
    sourceId?: string | null
    outcome: 'verified' | 'failed' | 'inconclusive'
    submittedPassword: boolean
  },
): Promise<void> {
  if (!input.submittedPassword) return
  const { credentialVersions, credentialVerifications } = schemaFor(db)
  const [version] = await db
    .select()
    .from(credentialVersions)
    .where(eq(credentialVersions.secretId, input.secretId))
    .limit(1)
  if (!version) return
  const now = new Date()
  await db.insert(credentialVerifications).values({
    id: newId(),
    credentialId: version.credentialId,
    versionId: version.id,
    identityRevision: input.identityRevision ?? version.identityRevision,
    sessionId: input.sessionId ?? null,
    sessionGeneration: input.sessionGeneration ?? null,
    source: input.source,
    sourceId: input.sourceId ?? null,
    outcome: input.outcome,
    verifiedAt: now,
    createdAt: now,
  })
}
