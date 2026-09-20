import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  computeMaintenanceDueAt,
  policyFromWrite,
  unknownValidityPolicy,
  type CredentialValidityPolicy,
  type CredentialValidityWrite,
} from '@cairn/shared'
import type { AuditActor } from '../audit/record.js'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, schemaFor } from '../native.js'
import { badRequest, conflict } from '../runs/errors.js'

export type SealedSecret = { id: string; provider: string; ciphertext?: Buffer }

export type TargetAccountSync = {
  id: string
  targetId: string
  displayName: string
  username: string
  configRevision: number
  secretId: string | null
  secretProvider: string | null
}

function consoleActor(actor: AuditActor) {
  return { kind: 'console' as const, id: actor.id }
}

function dueOf(policy: CredentialValidityPolicy, startedAt: Date | null): Date | null {
  return computeMaintenanceDueAt({ policy, startedAt })
}

export async function ensureTargetAccountCredential(
  db: Db,
  input: {
    account: TargetAccountSync
    sealed?: SealedSecret | null
    validity?: CredentialValidityWrite | null
    ownerConsoleAccountId?: string | null
    actor: AuditActor
    now?: Date
  },
): Promise<{ credentialId: string; revision: number }> {
  return atomic(db, async (tx) => {
    const now = input.now ?? (await clockNow(tx))
    const {
      credentials,
      credentialBindings,
      credentialVersions,
      credentialMaintenancePolicies,
    } = schemaFor(tx)
    const [existing] = await tx
      .select()
      .from(credentials)
      .where(eq(credentials.id, input.account.id))
      .limit(1)
    if (!existing) {
      await tx.insert(credentials).values({
        id: input.account.id,
        type: 'target_password',
        source: 'target_account',
        name: input.account.displayName,
        ownerConsoleAccountId: input.ownerConsoleAccountId ?? null,
        tags: [],
        managementStatus: 'active',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(credentialBindings).values({
        id: input.account.id,
        credentialId: input.account.id,
        kind: 'target_account',
        targetId: input.account.targetId,
        targetAccountId: input.account.id,
        identityUsername: input.account.username,
        identityRevision: input.account.configRevision,
        identityConfirmStatus: 'confirmed',
        createdAt: now,
        updatedAt: now,
      })
      const policy = input.validity ? policyFromWrite(input.validity) : unknownValidityPolicy()
      const startedAt = input.validity?.startedAt
        ? new Date(input.validity.startedAt)
        : input.sealed
          ? now
          : null
      if (input.validity?.startedAt && new Date(input.validity.startedAt).getTime() > now.getTime()) {
        throw badRequest('CREDENTIAL_VALIDITY_INVALID', '启用时间不能是未来时刻')
      }
      if ((policy.mode === 'days' || policy.mode === 'months') && !startedAt) {
        throw badRequest('CREDENTIAL_START_TIME_REQUIRED', '有限期限必须有启用时间')
      }
      await tx.insert(credentialMaintenancePolicies).values({
        credentialId: input.account.id,
        mode: policy.mode,
        amount: policy.amount,
        timeZone: policy.timeZone,
        validityStartedAt: startedAt,
        maintenanceDueAt: dueOf(policy, startedAt),
        issuerExpirySource: 'unknown',
        expiryReminderLeadDays: input.validity?.expiryReminderLeadDays ?? 14,
        revision: 1,
        updatedAt: now,
      })
      await recordAudit(tx, consoleActor(input.actor), 'credential.register', 'credential', input.account.id, input.account.username)
    }

    if (input.sealed && !existing?.deletedAt) {
      await attachCurrentVersion(tx, {
        credentialId: input.account.id,
        sealed: input.sealed,
        username: input.account.username,
        identityRevision: input.account.configRevision,
        now,
      })
    }
    const [row] = await tx.select().from(credentials).where(eq(credentials.id, input.account.id)).limit(1)
    return { credentialId: input.account.id, revision: row?.revision ?? 1 }
  })
}

async function attachCurrentVersion(
  tx: Db,
  input: {
    credentialId: string
    sealed: SealedSecret
    username: string
    identityRevision: number
    now: Date
  },
) {
  const { credentials, credentialVersions } = schemaFor(tx)
  const [existing] = await tx
    .select()
    .from(credentialVersions)
    .where(eq(credentialVersions.id, input.sealed.id))
    .limit(1)
  if (existing) return
  await tx
    .update(credentialVersions)
    .set({ materialStatus: 'superseded' })
    .where(
      and(eq(credentialVersions.credentialId, input.credentialId), eq(credentialVersions.materialStatus, 'current')),
    )
  await tx.insert(credentialVersions).values({
    id: input.sealed.id,
    credentialId: input.credentialId,
    secretProvider: input.sealed.provider,
    secretId: input.sealed.id,
    materialStatus: 'current',
    identityRevision: input.identityRevision,
    identityUsername: input.username,
    registeredAt: input.now,
    createdAt: input.now,
  })
  await tx
    .update(credentials)
    .set({ currentVersionId: input.sealed.id, updatedAt: input.now })
    .where(eq(credentials.id, input.credentialId))
}

export async function replaceTargetAccountSecret(
  db: Db,
  input: {
    account: TargetAccountSync
    sealed: SealedSecret
    validity?: CredentialValidityWrite | null
    expectedRevision?: number
    actor: AuditActor
  },
): Promise<{ credentialId: string; revision: number }> {
  return atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { targetAccounts, targets, secrets } = schemaFor(tx)
    const [account] = await tx.select().from(targetAccounts)
      .where(and(eq(targetAccounts.id, input.account.id), eq(targetAccounts.targetId, input.account.targetId), isNull(targetAccounts.deletedAt))).for('update')
    const [target] = await tx.select({ id: targets.id }).from(targets).where(and(eq(targets.id, input.account.targetId), isNull(targets.deletedAt)))
    if (!account || !target) throw conflict('CREDENTIAL_NOT_FOUND', '目标账号已删除或不存在')
    await ensureTargetAccountCredential(tx, {
      account: input.account,
      actor: input.actor,
      now,
    })
    const { credentials, credentialBindings, credentialMaintenancePolicies } = schemaFor(tx)
    const [current] = await tx.select().from(credentials).where(eq(credentials.id, input.account.id)).for('update')
    if (!current) throw conflict('CREDENTIAL_NOT_FOUND', '凭据不存在')
    if (input.expectedRevision != null && current.revision !== input.expectedRevision) {
      throw conflict('CREDENTIAL_REVISION_CONFLICT', '凭据已被他人更新', { currentRevision: current.revision })
    }
    if (input.sealed.ciphertext) await tx.insert(secrets).values({ id: input.sealed.id, provider: input.sealed.provider,
      ciphertext: input.sealed.ciphertext, createdAt: now, updatedAt: now })
    await attachCurrentVersion(tx, {
      credentialId: input.account.id,
      sealed: input.sealed,
      username: input.account.username,
      identityRevision: input.account.configRevision,
      now,
    })
    await tx
      .update(credentialBindings)
      .set({
        identityUsername: input.account.username,
        identityRevision: input.account.configRevision,
        identityConfirmStatus: 'confirmed',
        updatedAt: now,
      })
      .where(eq(credentialBindings.credentialId, input.account.id))

    const [policy] = await tx
      .select()
      .from(credentialMaintenancePolicies)
      .where(eq(credentialMaintenancePolicies.credentialId, input.account.id))
      .limit(1)
    const nextPolicy = input.validity
      ? policyFromWrite(input.validity)
      : policy
        ? { mode: policy.mode, amount: policy.amount, timeZone: policy.timeZone }
        : unknownValidityPolicy()
    const startedAt = input.validity?.startedAt ? new Date(input.validity.startedAt) : now
    if (startedAt.getTime() > now.getTime()) {
      throw badRequest('CREDENTIAL_VALIDITY_INVALID', '启用时间不能是未来时刻')
    }
    if ((nextPolicy.mode === 'days' || nextPolicy.mode === 'months') && !startedAt) {
      throw badRequest('CREDENTIAL_START_TIME_REQUIRED', '有限期限必须有启用时间')
    }
    await tx
      .update(credentialMaintenancePolicies)
      .set({
        mode: nextPolicy.mode,
        amount: nextPolicy.mode === 'permanent' || nextPolicy.mode === 'unknown' ? null : nextPolicy.amount,
        timeZone: nextPolicy.mode === 'unknown' ? null : nextPolicy.timeZone,
        validityStartedAt: startedAt,
        maintenanceDueAt: dueOf(nextPolicy, startedAt),
        expiryReminderLeadDays: input.validity?.expiryReminderLeadDays ?? policy?.expiryReminderLeadDays ?? 14,
        revision: (policy?.revision ?? 1) + (input.validity ? 1 : 0),
        updatedAt: now,
      })
      .where(eq(credentialMaintenancePolicies.credentialId, input.account.id))
    await invalidateReminders(tx, input.account.id)
    const revision = current.revision + 1
    await tx
      .update(targetAccounts)
      .set({
        secretId: input.sealed.id,
        secretProvider: input.sealed.provider,
        updatedAt: now,
      })
      .where(eq(targetAccounts.id, input.account.id))
    await tx
      .update(credentials)
      .set({ revision, updatedAt: now, name: input.account.displayName, deletedAt: null })
      .where(eq(credentials.id, input.account.id))
    await recordAudit(tx, consoleActor(input.actor), 'credential.replace', 'credential', input.account.id, input.account.username)
    return { credentialId: input.account.id, revision }
  })
}

export async function clearTargetAccountSecrets(
  db: Db,
  input: { accountId: string; actor: AuditActor },
): Promise<void> {
  await atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { credentials, credentialVersions, targetAccounts } = schemaFor(tx)
    const [current] = await tx.select().from(credentials).where(eq(credentials.id, input.accountId)).limit(1)
    if (!current) return
    await tx.update(targetAccounts).set({ secretId: null, secretProvider: null, updatedAt: now }).where(eq(targetAccounts.id, input.accountId))
    await tx
      .update(credentialVersions)
      .set({ materialStatus: 'cleared', revokedAt: now, revokeReason: 'cleared' })
      .where(
        and(
          eq(credentialVersions.credentialId, input.accountId),
          inArray(credentialVersions.materialStatus, ['current', 'superseded']),
        ),
      )
    await tx
      .update(credentials)
      .set({ currentVersionId: null, revision: current.revision + 1, updatedAt: now })
      .where(eq(credentials.id, input.accountId))
    await invalidateReminders(tx, input.accountId)
    await recordAudit(tx, consoleActor(input.actor), 'credential.version_revoke', 'credential', input.accountId, '清除密码并撤销既有版本取用')
  })
}

export async function markIdentityReconfirm(
  db: Db,
  input: { accountId: string; username: string; identityRevision: number },
): Promise<void> {
  await atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { credentialBindings, credentials } = schemaFor(tx)
    await tx
      .update(credentialBindings)
      .set({
        identityUsername: input.username,
        identityRevision: input.identityRevision,
        identityConfirmStatus: 'pending_reconfirm',
        updatedAt: now,
      })
      .where(eq(credentialBindings.targetAccountId, input.accountId))
    await tx.update(credentials).set({ updatedAt: now }).where(eq(credentials.id, input.accountId))
  })
}

export async function confirmIdentityMaterial(
  db: Db,
  input: { account: TargetAccountSync; actor: AuditActor },
): Promise<void> {
  await atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { credentials, credentialBindings, credentialVersions } = schemaFor(tx)
    const [current] = await tx.select().from(credentials).where(eq(credentials.id, input.account.id)).limit(1)
    if (!current?.currentVersionId) {
      throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '没有可确认的凭据材料')
    }
    const [version] = await tx
      .select()
      .from(credentialVersions)
      .where(eq(credentialVersions.id, current.currentVersionId))
      .limit(1)
    if (!version?.secretId) throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '没有可确认的凭据材料')
    const versionId = newId()
    await tx
      .update(credentialVersions)
      .set({ materialStatus: 'superseded' })
      .where(eq(credentialVersions.id, version.id))
    await tx.insert(credentialVersions).values({
      id: versionId,
      credentialId: current.id,
      secretProvider: version.secretProvider,
      secretId: version.secretId,
      materialStatus: 'current',
      identityRevision: input.account.configRevision,
      identityUsername: input.account.username,
      registeredAt: now,
      createdAt: now,
    })
    await tx
      .update(credentialBindings)
      .set({
        identityUsername: input.account.username,
        identityRevision: input.account.configRevision,
        identityConfirmStatus: 'confirmed',
        updatedAt: now,
      })
      .where(eq(credentialBindings.credentialId, current.id))
    await tx
      .update(credentials)
      .set({ currentVersionId: versionId, revision: current.revision + 1, updatedAt: now })
      .where(eq(credentials.id, current.id))
    await recordAudit(tx, consoleActor(input.actor), 'credential.replace', 'credential', current.id, '确认原凭据仍适用于新登录名')
  })
}

export async function syncModelKeyCredential(
  db: Db,
  input: { secretId: string; modelOrigin: string; actor: AuditActor },
): Promise<void> {
  await atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { credentials, credentialBindings, credentialVersions, credentialMaintenancePolicies } = schemaFor(tx)
    const [existing] = await tx.select().from(credentials).where(eq(credentials.id, input.secretId)).limit(1)
    if (existing) return
    await tx.insert(credentials).values({
      id: input.secretId,
      type: 'model_key',
      source: 'platform_ai',
      name: '模型服务 Key',
      tags: [],
      managementStatus: 'active',
      currentVersionId: input.secretId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(credentialBindings).values({
      id: input.secretId,
      credentialId: input.secretId,
      kind: 'model_config',
      modelOrigin: input.modelOrigin,
      identityConfirmStatus: 'confirmed',
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(credentialVersions).values({
      id: input.secretId,
      credentialId: input.secretId,
      secretProvider: 'local',
      secretId: input.secretId,
      materialStatus: 'current',
      registeredAt: now,
      createdAt: now,
    })
    await tx.insert(credentialMaintenancePolicies).values({
      credentialId: input.secretId,
      mode: 'unknown',
      issuerExpirySource: 'unknown',
      expiryReminderLeadDays: 14,
      revision: 1,
      updatedAt: now,
    })
    await recordAudit(tx, consoleActor(input.actor), 'credential.register', 'credential', input.secretId, input.modelOrigin)
  })
}

export async function replaceAlertWebhookSecret(
  db: Db,
  input: {
    channelId: string
    channelName: string
    previousSecretId?: string | null
    sealed: SealedSecret
    actor: AuditActor
  },
): Promise<void> {
  await atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { credentials, credentialBindings, credentialVersions, credentialMaintenancePolicies } =
      schemaFor(tx)
    const [existing] = await tx.select().from(credentials).where(eq(credentials.id, input.channelId)).limit(1)
    if (!existing) {
      await tx.insert(credentials).values({
        id: input.channelId,
        type: 'alert_webhook',
        source: 'alert_channel',
        name: input.channelName,
        tags: [],
        managementStatus: 'active',
        currentVersionId: input.sealed.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(credentialBindings).values({
        id: input.channelId,
        credentialId: input.channelId,
        kind: 'alert_channel',
        alertChannelId: input.channelId,
        identityConfirmStatus: 'confirmed',
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(credentialMaintenancePolicies).values({
        credentialId: input.channelId,
        mode: 'unknown',
        issuerExpirySource: 'unknown',
        expiryReminderLeadDays: 14,
        revision: 1,
        updatedAt: now,
      })
    } else {
      await tx
        .update(credentialVersions)
        .set({ materialStatus: 'superseded' })
        .where(
          and(eq(credentialVersions.credentialId, input.channelId), eq(credentialVersions.materialStatus, 'current')),
        )
      await tx
        .update(credentials)
        .set({
          currentVersionId: input.sealed.id,
          name: input.channelName,
          revision: existing.revision + 1,
          updatedAt: now,
        })
        .where(eq(credentials.id, input.channelId))
    }
    await tx.insert(credentialVersions).values({
      id: input.sealed.id,
      credentialId: input.channelId,
      secretProvider: input.sealed.provider,
      secretId: input.sealed.id,
      materialStatus: 'current',
      registeredAt: now,
      createdAt: now,
    })
    await recordAudit(tx, consoleActor(input.actor), 'credential.replace', 'credential', input.channelId, input.channelName)
  })
}

export async function syncServiceKeyProjection(
  db: Db,
  input: {
    credentialId: string
    name: string
    notes?: string | null
    /** 服务 Key 的展示元数据有独立并发版本，不能冒充授权版本。 */
    updateMetadata?: boolean
    expiresAt: Date
    actor: AuditActor
  },
): Promise<void> {
  await atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { credentials, credentialBindings, credentialMaintenancePolicies } = schemaFor(tx)
    const [existing] = await tx.select().from(credentials).where(eq(credentials.id, input.credentialId)).limit(1)
    if (existing) {
      await tx
        .update(credentialMaintenancePolicies)
        .set({ issuerExpiresAt: input.expiresAt, issuerExpirySource: 'issued_by_cairn', updatedAt: now })
        .where(eq(credentialMaintenancePolicies.credentialId, input.credentialId))
      if (input.updateMetadata)
        await tx
          .update(credentials)
          .set({
            name: input.name,
            notes: input.notes ?? null,
            revision: existing.revision + 1,
            updatedAt: now,
          })
          .where(eq(credentials.id, input.credentialId))
      return
    }
    await tx.insert(credentials).values({
      id: input.credentialId,
      type: 'service_key',
      source: 'service_credential',
      name: input.name,
      notes: input.notes ?? null,
      tags: [],
      managementStatus: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(credentialBindings).values({
      id: input.credentialId,
      credentialId: input.credentialId,
      kind: 'service_credential',
      serviceCredentialId: input.credentialId,
      identityConfirmStatus: 'confirmed',
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(credentialMaintenancePolicies).values({
      credentialId: input.credentialId,
      mode: 'unknown',
      issuerExpiresAt: input.expiresAt,
      issuerExpirySource: 'issued_by_cairn',
      expiryReminderLeadDays: 14,
      revision: 1,
      updatedAt: now,
    })
    await recordAudit(tx, consoleActor(input.actor), 'credential.register', 'credential', input.credentialId, input.name)
  })
}

export async function invalidateReminders(db: Db, credentialId: string): Promise<void> {
  const { credentialReminders } = schemaFor(db)
  const now = new Date()
  await db
    .update(credentialReminders)
    .set({ status: 'closed', updatedAt: now })
    .where(and(eq(credentialReminders.credentialId, credentialId), eq(credentialReminders.status, 'open')))
}
