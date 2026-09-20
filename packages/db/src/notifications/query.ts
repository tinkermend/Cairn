import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, gte, inArray, isNull, like, lt, lte, or, sql } from 'drizzle-orm'
import {
  canonicalJson,
  notificationActionSchema,
  notificationEventSchema,
  notificationListQuerySchema,
  type NotificationEventDto,
  type NotificationPayload,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  lockConsoleAuthorization,
  scopedTargetFilter,
  targetScopeFor,
} from '../console/target-authorization.js'
import { recordAudit } from '../audit/record.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { requireNotificationPermission } from './config.js'
import {
  bindingSuppression,
  freezeNotificationBindings,
  lockNotificationDispatch,
  materializeNotificationDeliveries,
} from './core.js'

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const has = async (db: Db, actor: string, permission: string) => {
  try {
    await requireNotificationPermission(db, actor, permission)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FORBIDDEN')
      return false
    throw error
  }
}
async function visible(db: Db, actorId: string) {
  await requireNotificationPermission(db, actorId, 'notification:read')
  const { notificationEvents: e } = schemaFor(db)
  return or(
    and(
      eq(e.type, 'run.finished'),
      await scopedTargetFilter(db, actorId, e.targetId, 'run:read'),
      await scopedTargetFilter(db, actorId, e.targetId, 'notification:read'),
    ),
    (await has(db, actorId, 'monitor:read')) ? like(e.type, 'alert.%') : sql`1 = 0`,
    (await has(db, actorId, 'platform-config:read')) ? eq(e.type, 'channel.test') : sql`1 = 0`,
  )
}
async function toEvent(
  db: Db,
  row: typeof import('../schema/notifications.js').notificationEvents.$inferSelect,
  detailed = false,
): Promise<NotificationEventDto> {
  const { notificationDeliveries: d, notificationDeliveryAttempts: a } = schemaFor(db)
  const rows = await db.select().from(d).where(eq(d.eventId, row.id)).orderBy(asc(d.id))
  const decisions = new Map<string, string | null>()
  const deliveries = []
  for (const delivery of rows) {
    let status = delivery.status,
      reason = delivery.reason
    if (['pending', 'retry_wait'].includes(status)) {
      if (!decisions.has(delivery.channelId))
        decisions.set(delivery.channelId, await bindingSuppression(db, delivery.binding, row))
      const suppressed = decisions.get(delivery.channelId)
      if (suppressed) {
        status = 'suppressed'
        reason = suppressed
      }
    }
    const attempts = detailed
      ? await db.select().from(a).where(eq(a.deliveryId, delivery.id)).orderBy(asc(a.attemptNo))
      : undefined
    deliveries.push({
      id: delivery.id,
      channelId: delivery.channelId,
      channelName: delivery.binding.channel.name,
      kind: delivery.binding.channel.kind,
      recipientLabel: delivery.recipientLabel,
      status,
      reason,
      automaticAttemptCount: delivery.automaticAttemptCount,
      nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
      closedAt: delivery.closedAt?.toISOString() ?? null,
      ...(attempts
        ? {
            attempts: attempts.map((v) => ({
              ...v,
              startedAt: v.startedAt.toISOString(),
              submittedAt: v.submittedAt?.toISOString() ?? null,
              finishedAt: v.finishedAt?.toISOString() ?? null,
            })),
          }
        : {}),
    })
  }
  let state = row.state,
    reason = row.reason
  if (state === 'waiting_result' && row.bindings.length) {
    const checks = await Promise.all(row.bindings.map((b) => bindingSuppression(db, b, row)))
    if (checks.every(Boolean)) {
      state = 'suppressed'
      reason = checks[0] ?? 'authorization_revoked'
    }
  }
  return notificationEventSchema.parse({
    ...row,
    state,
    reason,
    occurredAt: row.occurredAt.toISOString(),
    observedAt: row.observedAt?.toISOString() ?? null,
    deliveries,
  })
}
export async function listNotificationEvents(db: Db, actorId: string, raw: unknown = {}) {
  const input = notificationListQuerySchema.parse(raw)
  const { notificationEvents: e, notificationDeliveries: d } = schemaFor(db)
  const filter = await visible(db, actorId)
  const scopes = await Promise.all(
    ['target:read', 'run:read', 'notification:read', 'monitor:read', 'platform-config:read'].map(
      (p) => targetScopeFor(db, actorId, p),
    ),
  )
  const fingerprint = hash({ ...input, cursor: undefined, actorId, scopes })
  let before: { at: string; id: string } | undefined
  if (input.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
      if (
        parsed.hash !== fingerprint ||
        typeof parsed.id !== 'string' ||
        !Number.isFinite(Date.parse(parsed.at))
      )
        throw new Error('cursor')
      before = parsed
    } catch {
      throw badRequest('NOTIFICATION_CURSOR_INVALID', '筛选或权限已变化，请刷新列表')
    }
  }
  const rows = await db
    .select()
    .from(e)
    .where(
      and(
        filter,
        input.type
          ? input.type === 'alert'
            ? like(e.type, 'alert.%')
            : eq(e.type, input.type === 'run' ? 'run.finished' : 'channel.test')
          : undefined,
        input.targetId ? eq(e.targetId, input.targetId) : undefined,
        input.scenarioId ? eq(e.scenarioId, input.scenarioId) : undefined,
        input.runId ? eq(e.runId, input.runId) : undefined,
        input.alertId ? eq(e.alertId, input.alertId) : undefined,
        input.from ? gte(e.occurredAt, new Date(input.from)) : undefined,
        input.to ? lte(e.occurredAt, new Date(input.to)) : undefined,
        before
          ? or(
              lt(e.occurredAt, new Date(before.at)),
              and(eq(e.occurredAt, new Date(before.at)), lt(e.id, before.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(e.occurredAt), desc(e.id))
    .limit(input.status ? 100 : input.limit + 1)
  const projected = await Promise.all(rows.map((r) => toEvent(db, r)))
  const matches = input.status
    ? projected.filter((event) => event.deliveries.some((d) => d.status === input.status))
    : projected
  const items = matches.slice(0, input.limit)
  // Bounded scan with keyset continuation. A sparse page can be empty and still have a next cursor.
  const more = matches.length > input.limit || Boolean(input.status && rows.length === 100)
  const last = matches.length > input.limit ? items.at(-1) : projected.at(-1)
  return {
    items,
    nextCursor:
      more && last
        ? Buffer.from(
            JSON.stringify({ hash: fingerprint, at: last.occurredAt, id: last.id }),
          ).toString('base64url')
        : null,
  }
}
export async function getNotificationEvent(db: Db, actorId: string, eventId: string) {
  const { notificationEvents: e } = schemaFor(db)
  const [row] = await db
    .select()
    .from(e)
    .where(and(eq(e.id, eventId), await visible(db, actorId)))
  if (!row) throw notFound('NOTIFICATION_NOT_FOUND', '通知不存在或无权访问')
  return toEvent(db, row, true)
}
export async function getNotificationChannels(db: Db, actorId: string, targetId?: string) {
  const current = await getOrCreatePlatformConfig(db),
    n = current.document.notifications
  const manager = await has(db, actorId, 'platform-config:read')
  if (!manager) {
    if (!targetId) throw notFound('NOTIFICATION_CHANNEL_NOT_FOUND', '请先选择有权访问的目标')
    const { assertTargetPermission } = await import('../console/target-authorization.js')
    await assertTargetPermission(db, actorId, targetId, 'workflow:read')
  }
  const { notificationControls: control } = schemaFor(db)
  const versions = [
    ...n.channels.map((c) => `version:${c.id}:${c.version}`),
    ...(n.smtp ? [`smtp-version:${n.smtp.version}`] : []),
  ]
  const revoked = versions.length
    ? await db
        .select({ key: control.key })
        .from(control)
        .where(and(inArray(control.key, versions), eq(control.revoked, true)))
    : []
  const channels = n.channels
    .filter((c) => (targetId ? c.targetIds.includes(targetId) : manager))
    .map(({ secretRef: _s, recipients, ...c }) => ({
      ...c,
      targetIds: manager ? c.targetIds : [targetId!],
      recipientCount: recipients.length,
      revoked: revoked.some((v) => v.key === `version:${c.id}:${c.version}`),
    }))
  return {
    revision: current.revision,
    enabled: n.enabled,
    consoleBaseUrl: manager ? n.consoleBaseUrl : '',
    smtp:
      manager && n.smtp
        ? {
            enabled: n.smtp.enabled,
            version: n.smtp.version,
            host: n.smtp.host,
            revoked: revoked.some((v) => v.key === `smtp-version:${n.smtp!.version}`),
          }
        : null,
    channels,
  }
}

async function commandReceipt(
  tx: Db,
  actorId: string,
  resourceId: string,
  action: string,
  raw: unknown,
) {
  const input = notificationActionSchema.parse(raw),
    id = `${actorId}:${input.idempotencyKey}`
  const { notificationCommands: c } = schemaFor(tx)
  const digest = hash({ action, resourceId, input })
  const [existing] = await tx.select().from(c).where(eq(c.id, id))
  if (existing && existing.digest !== digest)
    throw conflict('NOTIFICATION_IDEMPOTENCY_CONFLICT', '幂等键已用于其他操作')
  return { input, id, digest, existing }
}
export async function createNotificationTest(
  db: Db,
  actorId: string,
  channelId: string,
  raw: unknown,
) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await requireNotificationPermission(tx, actorId, 'platform-config:write')
    await lockNotificationDispatch(tx)
    const cmd = await commandReceipt(tx, actorId, channelId, 'test', raw)
    if (cmd.existing) return { eventId: cmd.existing.resultId }
    const current = await getOrCreatePlatformConfig(tx),
      n = current.document.notifications
    const channel = n.channels.find((c) => c.id === channelId)
    if (!n.enabled || !channel?.enabled || (channel.kind === 'email' && !n.smtp?.enabled))
      throw badRequest('NOTIFICATION_CHANNEL_UNAVAILABLE', '请先保存并启用渠道及发送配置')
    const { notificationEvents: e, notificationCommands: c } = schemaFor(tx)
    const now = await clockNow(tx)
    const recent = await tx
      .select()
      .from(c)
      .where(and(eq(c.action, 'test'), gt(c.createdAt, new Date(now.getTime() - 3600_000))))
      .limit(61)
    if (
      recent.length >= 60 ||
      recent.some(
        (r) =>
          r.actorId === actorId &&
          r.resourceId === channelId &&
          r.createdAt.getTime() > now.getTime() - 60_000,
      )
    )
      throw conflict('NOTIFICATION_RATE_LIMITED', '测试发送过于频繁')
    const id = newId()
    const payload: NotificationPayload = { title: '识途通知渠道测试：这是一条合成测试消息' }
    if (channel.format === 'legacy_alert@1')
      payload.alert = {
        kind: 'firing',
        alertId: id,
        ruleId: 'notification-test',
        ruleName: '通知渠道测试（合成消息）',
        scope: 'platform',
        scopeId: 'platform',
        severity: 'warning',
        metricKey: null,
        source: null,
        value: null,
        threshold: null,
        comparator: null,
        occurredAt: now.toISOString(),
        consolePath: '/monitoring',
      }
    await tx.insert(e).values({
      id,
      sourceKey: `test:${cmd.id}`,
      type: 'channel.test',
      actorId,
      state: 'ready',
      payload,
      bindings: await freezeNotificationBindings(tx, current.document, [channelId]),
      occurredAt: now,
      observedAt: now,
      nextPrepareAt: now,
    })
    await materializeNotificationDeliveries(tx, id)
    await tx.insert(c).values({
      id: cmd.id,
      actorId,
      resourceId: channelId,
      action: 'test',
      digest: cmd.digest,
      resultId: id,
      createdAt: now,
    })
    await recordAudit(
      tx,
      { id: actorId },
      'notification.test',
      'notification_channel',
      channelId,
      cmd.input.reason,
    )
    return { eventId: id }
  })
}
export async function operateNotificationDelivery(
  db: Db,
  actorId: string,
  deliveryId: string,
  action: 'retry' | 'close',
  raw: unknown,
) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await requireNotificationPermission(tx, actorId, 'notification:operate')
    await lockNotificationDispatch(tx)
    const {
      notificationDeliveries: d,
      notificationEvents: e,
      notificationCommands: c,
    } = schemaFor(tx)
    const [delivery] = await tx.select().from(d).where(eq(d.id, deliveryId))
    if (!delivery) throw notFound('NOTIFICATION_NOT_FOUND', '通知不存在或无权访问')
    await getNotificationEvent(tx, actorId, delivery.eventId)
    const [event] = await tx.select().from(e).where(eq(e.id, delivery.eventId))
    if (event!.type.startsWith('alert.'))
      await requireNotificationPermission(tx, actorId, 'monitor:operate')
    if (event!.type === 'channel.test')
      await requireNotificationPermission(tx, actorId, 'platform-config:write')
    if (event!.targetId) {
      const { assertTargetPermission } = await import('../console/target-authorization.js')
      await assertTargetPermission(tx, actorId, event!.targetId, 'notification:operate')
    }
    const cmd = await commandReceipt(tx, actorId, deliveryId, action, raw)
    if (cmd.existing) return { eventId: cmd.existing.resultId }
    const now = await clockNow(tx)
    const recent = await tx
      .select()
      .from(c)
      .where(and(eq(c.resourceId, deliveryId), gt(c.createdAt, new Date(now.getTime() - 60_000))))
      .limit(1)
    if (recent.length) throw conflict('NOTIFICATION_RATE_LIMITED', '操作过于频繁')
    if (delivery.closedAt || event!.purgedAt)
      throw conflict('NOTIFICATION_CLOSED', '记录已结案或正文已清理')
    if (action === 'close') {
      if (delivery.status !== 'unknown')
        throw conflict('NOTIFICATION_STATE_CONFLICT', '仅结果不明可结案')
      await tx.update(d).set({ closedAt: now, updatedAt: now }).where(eq(d.id, deliveryId))
    } else {
      if (delivery.reason === 'legacy_unknown')
        throw conflict('NOTIFICATION_LEGACY_UNKNOWN', '旧发送事实不完整，不能从此记录重发')
      if (!['failed', 'unknown'].includes(delivery.status))
        throw conflict('NOTIFICATION_STATE_CONFLICT', '仅失败或结果不明可重试')
      if (delivery.status === 'unknown' && !cmd.input.confirmUnknown)
        throw badRequest('NOTIFICATION_UNKNOWN_CONFIRMATION', '请确认再次发送可能重复')
      if (await bindingSuppression(tx, delivery.binding, event!))
        throw conflict('NOTIFICATION_AUTHORIZATION_REVOKED', '原目的地授权已撤销，不能重试')
      await tx
        .update(d)
        .set({
          status: 'pending',
          manualPermit: true,
          manualActorId: actorId,
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(eq(d.id, deliveryId))
    }
    await tx.insert(c).values({
      id: cmd.id,
      actorId,
      resourceId: deliveryId,
      action,
      digest: cmd.digest,
      resultId: delivery.eventId,
      createdAt: now,
    })
    await recordAudit(
      tx,
      { id: actorId },
      action === 'retry' ? 'notification.retry' : 'notification.close',
      'notification_delivery',
      deliveryId,
      cmd.input.reason,
    )
    return { eventId: delivery.eventId }
  })
}
