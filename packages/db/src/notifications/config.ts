import { and, eq, isNull, gt, or } from 'drizzle-orm'
import {
  DEFAULT_NOTIFICATION_POLICY,
  canonicalJson,
  hasPermission,
  notificationPolicyWriteSchema,
  NOTIFICATION_WORKER_PROTOCOL,
  RUN_NOTIFICATION_PROTOCOL,
  MAP_SCHEDULER_PROTOCOL,
  SUITE_SCHEDULER_PROTOCOL,
  type NotificationChannel,
  type NotificationSmtp,
  type PlatformConfigDocument,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, insertIgnoreRows, locked, schemaFor } from '../native.js'
import {
  assertScopeAdministrator,
  assertTargetPermission,
  lockConsoleAuthorization,
  targetScopeFor,
} from '../console/target-authorization.js'
import { recordAudit } from '../audit/record.js'
import { badRequest, conflict, forbidden, notFound } from '../runs/errors.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { registerStandaloneSecret } from '../secrets/store.js'
import { bumpNotificationControl, lockNotificationDispatch } from './core.js'

export async function requireNotificationPermission(db: Db, actorId: string, permission: string) {
  const {
    consoleAccounts: accounts,
    consoleAccountRoles: grants,
    consoleRolePermissions: p,
  } = schemaFor(db)
  const rows = await db
    .select({ permission: p.permission })
    .from(grants)
    .innerJoin(
      accounts,
      and(eq(accounts.id, grants.consoleAccountId), eq(accounts.status, 'active')),
    )
    .innerJoin(p, eq(p.consoleRoleId, grants.consoleRoleId))
    .where(eq(grants.consoleAccountId, actorId))
  if (
    !hasPermission(
      rows.map((r) => r.permission),
      permission,
    )
  )
    throw forbidden('FORBIDDEN', '没有所需权限')
}

/** Every platform write, including restore and old API adapters, passes this guard. */
export async function validateNotificationConfigChangeTx(
  tx: Db,
  before: PlatformConfigDocument,
  after: PlatformConfigDocument,
  actorId: string,
  notificationMutation = false,
  restoring = false,
) {
  const a = before.notifications,
    b = after.notifications
  if (canonicalJson(a) === canonicalJson(b) && !restoring) return
  await requireNotificationPermission(tx, actorId, 'platform-config:write')
  // Purpose/endpoint changes are limited to scope administrators. Generic writes may only reuse exact bindings.
  if (!notificationMutation) await assertScopeAdministrator(tx, actorId)
  if (!notificationMutation && !restoring) {
    for (const c of b.channels) {
      const old = a.channels.find((v) => v.id === c.id)
      if (
        !old ||
        canonicalJson({
          ...old,
          enabled: c.enabled,
          name: c.name,
          targetIds: c.targetIds,
          allowAlerts: c.allowAlerts,
        }) !== canonicalJson(c)
      ) {
        throw badRequest('NOTIFICATION_USE_CHANNEL_API', '目的地变更须通过通知渠道接口登记')
      }
    }
    if (canonicalJson(a.smtp) !== canonicalJson(b.smtp))
      throw badRequest('NOTIFICATION_USE_SMTP_API', '邮件配置须通过通知接口登记')
  }
  await lockNotificationDispatch(tx)
  if (b.enabled) await assertNotificationWriterRollout(tx)
  const { notificationControls: controls } = schemaFor(tx)
  for (const c of b.channels) {
    const [revoked] = await tx
      .select()
      .from(controls)
      .where(eq(controls.key, `version:${c.id}:${c.version}`))
    const old = a.channels.find((v) => v.id === c.id)
    if (
      revoked?.revoked &&
      (restoring || old?.version !== c.version || (c.enabled && !old.enabled))
    )
      throw conflict('NOTIFICATION_VERSION_REVOKED', '渠道版本已撤销')
  }
  if (b.smtp) {
    const [revoked] = await tx
      .select()
      .from(controls)
      .where(eq(controls.key, `smtp-version:${b.smtp.version}`))
    if (
      revoked?.revoked &&
      (restoring || a.smtp?.version !== b.smtp.version || (b.smtp.enabled && !a.smtp.enabled))
    )
      throw conflict('NOTIFICATION_VERSION_REVOKED', '邮件版本已撤销')
  }
  if (a.enabled && !b.enabled) await bumpNotificationControl(tx, 'global')
  if (a.smtp?.enabled && !b.smtp?.enabled) await bumpNotificationControl(tx, 'smtp')
  for (const old of a.channels) {
    const next = b.channels.find((c) => c.id === old.id)
    if (!next || (old.enabled && !next.enabled) || (old.allowAlerts && !next.allowAlerts))
      await bumpNotificationControl(tx, `channel:${old.id}`)
    for (const target of old.targetIds)
      if (!next?.targetIds.includes(target))
        await bumpNotificationControl(tx, `grant:${old.id}:${target}`)
  }
}

export async function writeNotificationConfig(
  db: Db,
  input: {
    actorId: string
    expectedRevision: number
    reason: string
    channel?: NotificationChannel
    smtp?: NotificationSmtp
    settings?: { enabled: boolean; consoleBaseUrl: string }
    state?: { id: string; enabled?: boolean; revokeVersion?: number }
    smtpState?: { enabled?: boolean; revokeVersion?: number }
    secrets?: { id: string; ciphertext: Buffer }[]
    /** Set only by the API after comparing decrypted destination identities. */
    destinationUnchanged?: boolean
  },
) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, input.actorId)
    await requireNotificationPermission(tx, input.actorId, 'platform-config:write')
    const { platformConfig } = schemaFor(tx)
    await locked(tx, tx.select().from(platformConfig))
    const current = await getOrCreatePlatformConfig(tx)
    if (current.revision !== input.expectedRevision)
      throw conflict('PLATFORM_CONFIG_CONFLICT', '配置已更新，请重新加载')
    const next = structuredClone(current.document.notifications)
    const oldChannel = next.channels.find((c) => c.id === input.channel?.id)
    const needsAdministrator =
      (input.channel &&
        (!oldChannel ||
          !input.destinationUnchanged ||
          canonicalJson(oldChannel.targetIds) !== canonicalJson(input.channel.targetIds) ||
          oldChannel.allowAlerts !== input.channel.allowAlerts)) ||
      (input.smtp && !input.destinationUnchanged) ||
      (input.settings && input.settings.consoleBaseUrl !== next.consoleBaseUrl)
    if (needsAdministrator) await assertScopeAdministrator(tx, input.actorId)
    await lockNotificationDispatch(tx)
    if (input.channel) {
      const old = next.channels.find((c) => c.id === input.channel!.id)
      if (input.channel.version !== (old?.version ?? 0) + 1)
        throw conflict('NOTIFICATION_VERSION_CONFLICT', '渠道版本冲突')
      const { targets } = schemaFor(tx)
      for (const id of input.channel.targetIds) {
        const [target] = await tx
          .select({ id: targets.id })
          .from(targets)
          .where(and(eq(targets.id, id), isNull(targets.deletedAt)))
        if (!target) throw badRequest('NOTIFICATION_TARGET_NOT_FOUND', '授权目标不存在')
      }
      const version = await allocateVersion(
        tx,
        `channel-revision:${input.channel.id}`,
        old?.version ?? 0,
      )
      next.channels = [
        ...next.channels.filter((c) => c.id !== input.channel!.id),
        { ...input.channel, version },
      ]
    }
    if (input.smtp)
      next.smtp = {
        ...input.smtp,
        version: await allocateVersion(tx, 'smtp-revision', next.smtp?.version ?? 0),
      }
    if (input.settings) Object.assign(next, input.settings)
    if (input.smtpState) {
      if (!next.smtp) throw notFound('NOTIFICATION_SMTP_NOT_FOUND', '邮件配置不存在')
      if (input.smtpState.revokeVersion && input.smtpState.revokeVersion > next.smtp.version)
        throw badRequest('NOTIFICATION_VERSION_NOT_FOUND', '邮件版本不存在')
      if (input.smtpState.enabled !== undefined) next.smtp.enabled = input.smtpState.enabled
    }
    if (input.state) {
      const c = next.channels.find((c) => c.id === input.state!.id)
      if (!c) throw notFound('NOTIFICATION_CHANNEL_NOT_FOUND', '渠道不存在')
      if (input.state.revokeVersion && input.state.revokeVersion > c.version)
        throw badRequest('NOTIFICATION_VERSION_NOT_FOUND', '渠道版本不存在')
      if (input.state.enabled !== undefined) c.enabled = input.state.enabled
    }
    const result = await updatePlatformConfig(tx, {
      expectedRevision: current.revision,
      reason: input.reason,
      actor: { id: input.actorId },
      notificationMutation: true,
      document: { ...current.document, notifications: next },
      afterWrite: async (lockedTx) => {
        for (const secret of input.secrets ?? []) await registerStandaloneSecret(lockedTx, secret)
        if (
          input.channel?.kind === 'webhook' &&
          input.secrets?.some((s) => s.id === input.channel!.secretRef.secretId)
        ) {
          const { replaceAlertWebhookSecret } = await import('../credentials/sync.js')
          await replaceAlertWebhookSecret(lockedTx, {
            channelId: input.channel.id,
            channelName: input.channel.name,
            previousSecretId: oldChannel?.secretRef.secretId,
            sealed: {
              id: input.channel.secretRef.secretId,
              provider: input.channel.secretRef.provider,
              ciphertext: input.secrets.find((s) => s.id === input.channel!.secretRef.secretId)!
                .ciphertext,
            },
            actor: { id: input.actorId },
          })
        }
        if (input.state?.revokeVersion) {
          await lockNotificationDispatch(lockedTx)
          await bumpNotificationControl(
            lockedTx,
            `version:${input.state.id}:${input.state.revokeVersion}`,
            true,
          )
          await recordAudit(
            lockedTx,
            { id: input.actorId },
            'platform_config.update',
            'notification_channel',
            input.state.id,
            `撤销版本 ${input.state.revokeVersion}：${input.reason}`,
          )
        }
        if (input.smtpState?.revokeVersion) {
          await bumpNotificationControl(
            lockedTx,
            `smtp-version:${input.smtpState.revokeVersion}`,
            true,
          )
          await recordAudit(
            lockedTx,
            { id: input.actorId },
            'platform_config.update',
            'notification_smtp',
            null,
            `撤销版本 ${input.smtpState.revokeVersion}：${input.reason}`,
          )
        }
      },
    })
    return result
  })
}

async function allocateVersion(tx: Db, key: string, current: number) {
  const { notificationControls: c } = schemaFor(tx)
  await insertIgnoreRows(tx, c, { key, generation: current, revoked: false })
  const [row] = await locked(tx, tx.select().from(c).where(eq(c.key, key)))
  const generation = Math.max(row!.generation, current) + 1
  await tx.update(c).set({ generation }).where(eq(c.key, key))
  return generation
}

export async function assertNotificationWriterRollout(tx: Db) {
  const { workers } = schemaFor(tx)
  const now = await clockNow(tx)
  const live = await tx
    .select({ protocols: workers.protocolCapabilities })
    .from(workers)
    .where(
      and(
        inArrayReady(workers.status),
        or(isNull(workers.heartbeatExpiresAt), gt(workers.heartbeatExpiresAt, now)),
      ),
    )
  const schedulerOnly = (p: string[]) =>
    p.length > 0 &&
    p.every((v) =>
      [MAP_SCHEDULER_PROTOCOL, SUITE_SCHEDULER_PROTOCOL].includes(
        v as typeof MAP_SCHEDULER_PROTOCOL,
      ),
    )
  if (
    live.some(
      (w) =>
        !w.protocols.includes(NOTIFICATION_WORKER_PROTOCOL) &&
        !w.protocols.includes(RUN_NOTIFICATION_PROTOCOL) &&
        !schedulerOnly(w.protocols),
    )
  )
    throw conflict(
      'NOTIFICATION_ROLLOUT_REQUIRED',
      '仍有旧版 Worker 在线，请完成停写升级后启用通知',
    )
}
function inArrayReady(column: typeof import('../schema/worker.js').workers.status) {
  return or(eq(column, 'READY'), eq(column, 'DRAINING'))
}

export async function readNotificationPolicy(db: Db, scenarioId: string, actorId: string) {
  const { scenarios: s, scenarioNotificationPolicies: p } = schemaFor(db)
  const [scenario] = await db
    .select()
    .from(s)
    .where(and(eq(s.id, scenarioId), isNull(s.deletedAt)))
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  await assertTargetPermission(db, actorId, scenario.targetId, 'workflow:read')
  const [row] = await db.select().from(p).where(eq(p.scenarioId, scenarioId))
  return { revision: row?.revision ?? 0, policy: row?.policy ?? DEFAULT_NOTIFICATION_POLICY }
}
export async function writeNotificationPolicy(
  db: Db,
  scenarioId: string,
  actorId: string,
  raw: unknown,
) {
  const input = notificationPolicyWriteSchema.parse(raw)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    const { scenarios: s, scenarioNotificationPolicies: p } = schemaFor(tx)
    const [scenario] = await locked(
      tx,
      tx
        .select()
        .from(s)
        .where(and(eq(s.id, scenarioId), isNull(s.deletedAt))),
    )
    if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
    await assertTargetPermission(tx, actorId, scenario.targetId, 'workflow:write')
    await assertTargetPermission(tx, actorId, scenario.targetId, 'run:read')
    await lockNotificationDispatch(tx)
    const [existing] = await tx.select().from(p).where(eq(p.scenarioId, scenarioId))
    if ((existing?.revision ?? 0) !== input.expectedRevision)
      throw conflict('NOTIFICATION_POLICY_CONFLICT', '通知设置已更新')
    const current = await getOrCreatePlatformConfig(tx)
    const n = current.document.notifications
    if (input.policy.enabled && scenario.purpose !== 'user')
      throw badRequest('NOTIFICATION_SCENARIO_INELIGIBLE', '仅正式用户场景可订阅结果通知')
    if (input.policy.enabled && (!n.enabled || !n.consoleBaseUrl))
      throw badRequest('NOTIFICATIONS_NOT_READY', '请先启用通知并设置控制台地址')
    for (const id of input.policy.enabled ? input.policy.channelIds : []) {
      const channel = n.channels.find((c) => c.id === id && c.targetIds.includes(scenario.targetId))
      if (!channel || !channel.enabled || channel.format !== 'cairn.notification@1')
        throw badRequest('NOTIFICATION_CHANNEL_UNAVAILABLE', '所选渠道不可用于当前目标')
      const { notificationControls: controls } = schemaFor(tx)
      const [revoked] = await tx
        .select()
        .from(controls)
        .where(eq(controls.key, `version:${channel.id}:${channel.version}`))
      if (revoked?.revoked)
        throw badRequest('NOTIFICATION_CHANNEL_UNAVAILABLE', '所选渠道版本已撤销')
      if (channel.kind === 'email' && !n.smtp?.enabled)
        throw badRequest('NOTIFICATION_SMTP_UNAVAILABLE', '邮件发送配置未启用')
      if (channel.kind === 'email' && n.smtp) {
        const [smtpRevoked] = await tx
          .select()
          .from(controls)
          .where(eq(controls.key, `smtp-version:${n.smtp.version}`))
        if (smtpRevoked?.revoked)
          throw badRequest('NOTIFICATION_SMTP_UNAVAILABLE', '邮件发送版本已撤销')
      }
    }
    const values = {
      revision: input.expectedRevision + 1,
      policy: input.policy,
      updatedBy: actorId,
      updatedAt: await clockNow(tx),
    }
    if (existing) await tx.update(p).set(values).where(eq(p.scenarioId, scenarioId))
    else await tx.insert(p).values({ scenarioId, ...values })
    if (input.cancelPrevious) await bumpNotificationControl(tx, `scenario:${scenarioId}`)
    await recordAudit(
      tx,
      { id: actorId },
      'notification.policy',
      'scenario',
      scenarioId,
      input.reason,
    )
    return { revision: values.revision, policy: values.policy }
  })
}
