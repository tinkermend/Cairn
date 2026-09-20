import { and, eq, isNotNull } from 'drizzle-orm'
import { deriveMaintenanceStatus } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { clockNow, schemaFor } from '../native.js'

export async function scanCredentialReminders(db: Db): Promise<{ opened: number; closed: number }> {
  const now = await clockNow(db)
  const { credentials, credentialMaintenancePolicies, credentialReminders } = schemaFor(db)
  const rows = await db
    .select({
      credential: credentials,
      policy: credentialMaintenancePolicies,
    })
    .from(credentials)
    .innerJoin(credentialMaintenancePolicies, eq(credentialMaintenancePolicies.credentialId, credentials.id))
    .where(and(eq(credentials.managementStatus, 'active'), isNotNull(credentialMaintenancePolicies.maintenanceDueAt)))
    .limit(500)

  let opened = 0
  let closed = 0
  for (const row of rows) {
    const status = deriveMaintenanceStatus({
      policy: { mode: row.policy.mode },
      dueAt: row.policy.maintenanceDueAt,
      now,
      reminderLeadDays: row.policy.expiryReminderLeadDays,
    })
    const stage = status === 'due' ? 'due' : status === 'approaching' ? 'approaching' : null
    if (!stage || !row.credential.currentVersionId) {
      const result = await db
        .update(credentialReminders)
        .set({ status: 'closed', updatedAt: now })
        .where(and(eq(credentialReminders.credentialId, row.credential.id), eq(credentialReminders.status, 'open')))
      closed += result.rowCount ?? 0
      continue
    }
    const [existing] = await db
      .select()
      .from(credentialReminders)
      .where(
        and(
          eq(credentialReminders.credentialId, row.credential.id),
          eq(credentialReminders.versionId, row.credential.currentVersionId),
          eq(credentialReminders.policyRevision, row.policy.revision),
          eq(credentialReminders.stage, stage),
        ),
      )
      .limit(1)
    if (existing) continue
    try {
      await db.insert(credentialReminders).values({
        id: newId(),
        credentialId: row.credential.id,
        versionId: row.credential.currentVersionId,
        policyRevision: row.policy.revision,
        stage,
        status: 'open',
        deliveryStatus: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      opened += 1
    } catch {
      // 并发扫描同一阶段时保持幂等
    }
  }
  return { opened, closed }
}

export async function listOpenCredentialReminders(db: Db) {
  const { credentialReminders, credentials, credentialMaintenancePolicies } = schemaFor(db)
  return db
    .select({
      reminder: credentialReminders,
      name: credentials.name,
      type: credentials.type,
      dueAt: credentialMaintenancePolicies.maintenanceDueAt,
    })
    .from(credentialReminders)
    .innerJoin(credentials, eq(credentials.id, credentialReminders.credentialId))
    .innerJoin(credentialMaintenancePolicies, eq(credentialMaintenancePolicies.credentialId, credentials.id))
    .where(eq(credentialReminders.status, 'open'))
    .limit(200)
}

export async function markReminderDelivered(
  db: Db,
  reminderId: string,
  input: { ok: boolean; error?: string },
): Promise<void> {
  const { credentialReminders } = schemaFor(db)
  await db
    .update(credentialReminders)
    .set({
      deliveryStatus: input.ok ? 'sent' : 'failed',
      lastError: input.error?.slice(0, 64) ?? null,
      updatedAt: new Date(),
    })
    .where(eq(credentialReminders.id, reminderId))
}
