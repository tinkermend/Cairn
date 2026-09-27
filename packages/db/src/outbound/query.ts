import { createHash } from 'node:crypto'
import { and, asc, desc, eq, exists, gt, gte, inArray, isNull, like, lt, lte, or, sql } from 'drizzle-orm'
import {
  canonicalJson,
  outboundActionSchema,
  outboundEventSchema,
  outboundListQuerySchema,
  type OutboundEventDto,
  type OutboundPayload,
  type PlatformConfigDocument,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  hasPermissionFromGrants,
  loadAccountGrants,
  lockConsoleAuthorization,
  scopeFromGrants,
  targetScopeFilter,
  type ScopeGrantRow,
} from '../console/target-authorization.js'
import { recordAudit } from '../audit/record.js'
import { badRequest, conflict, forbidden, notFound } from '../runs/errors.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { requireOutboundPermission } from './config.js'
import {
  bindingSuppression,
  freezeOutboundBindings,
  lockOutboundDispatch,
  materializeOutboundDeliveries,
} from './core.js'

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const has = async (db: Db, actor: string, permission: string) => {
  try {
    await requireOutboundPermission(db, actor, permission)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FORBIDDEN')
      return false
    throw error
  }
}
async function visible(db: Db, actorId: string) {
  return visibleFromGrants(db, await loadAccountGrants(db, actorId))
}

/**
 * 可见性过滤器。授予行只取一次，五项权限判定全在内存里派生——
 * `loadAccountGrants` 的查询与 permission 无关，按权限逐次查库是纯浪费。
 */
function visibleFromGrants(db: Db, rows: ScopeGrantRow[]) {
  if (!hasPermissionFromGrants(rows, 'outbound:read')) {
    throw forbidden('FORBIDDEN', '没有所需权限')
  }
  const { outboundEvents: e } = schemaFor(db)
  const scoped = (permission: string) =>
    and(
      targetScopeFilter(e.targetId, scopeFromGrants(rows, 'target:read')),
      targetScopeFilter(e.targetId, scopeFromGrants(rows, permission)),
    )
  return or(
    and(eq(e.type, 'run.finished'), scoped('run:read'), scoped('outbound:read')),
    hasPermissionFromGrants(rows, 'monitor:read') ? like(e.type, 'alert.%') : sql`1 = 0`,
    hasPermissionFromGrants(rows, 'platform-config:read') ? eq(e.type, 'channel.test') : sql`1 = 0`,
  )
}
async function toEvent(
  db: Db,
  row: typeof import('../schema/outbound.js').outboundEvents.$inferSelect,
  options: {
    detailed?: boolean
    deliveries?: (typeof import('../schema/outbound.js').outboundDeliveries.$inferSelect)[]
    document?: PlatformConfigDocument
    controlsMap?: Map<string, typeof import('../schema/outbound.js').outboundControls.$inferSelect>
  } = {},
): Promise<OutboundEventDto> {
  const { detailed = false, deliveries: preloadedDeliveries, document, controlsMap } = options
  const { outboundDeliveries: d, outboundDeliveryAttempts: a } = schemaFor(db)
  const rows =
    preloadedDeliveries ?? (await db.select().from(d).where(eq(d.eventId, row.id)).orderBy(asc(d.id)))
  const decisions = new Map<string, string | null>()
  const deliveries = []
  for (const delivery of rows) {
    let status = delivery.status,
      reason = delivery.reason
    if (['pending', 'retry_wait'].includes(status)) {
      if (!decisions.has(delivery.channelId))
        decisions.set(
          delivery.channelId,
          await bindingSuppression(db, delivery.binding, row, document, controlsMap),
        )
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
    const checks = await Promise.all(
      row.bindings.map((b) => bindingSuppression(db, b, row, document, controlsMap)),
    )
    if (checks.every(Boolean)) {
      state = 'suppressed'
      reason = checks[0] ?? 'authorization_revoked'
    }
  }
  return outboundEventSchema.parse({
    ...row,
    state,
    reason,
    occurredAt: row.occurredAt.toISOString(),
    observedAt: row.observedAt?.toISOString() ?? null,
    deliveries,
  })
}
export async function listOutboundEvents(db: Db, actorId: string, raw: unknown = {}) {
  const input = outboundListQuerySchema.parse(raw)
  const { outboundEvents: e, outboundDeliveries: d, outboundControls: c } = schemaFor(db)
  // 整页只取一次授予行；可见性过滤与游标指纹的五项范围都从它内存派生。
  const grants = await loadAccountGrants(db, actorId)
  const filter = visibleFromGrants(db, grants)
  const scopes = [
    'target:read',
    'run:read',
    'outbound:read',
    'monitor:read',
    'platform-config:read',
  ].map((p) => scopeFromGrants(grants, p))
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
      throw badRequest('OUTBOUND_CURSOR_INVALID', '筛选或权限已变化，请刷新列表')
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
        input.search
          ? or(
              sql`cast(${e.id} as text) like ${'%' + input.search.toLowerCase() + '%'}`,
              sql`cast(${e.runId} as text) like ${'%' + input.search.toLowerCase() + '%'}`,
              sql`cast(${e.alertId} as text) like ${'%' + input.search.toLowerCase() + '%'}`,
              sql`cast(${e.targetId} as text) like ${'%' + input.search.toLowerCase() + '%'}`,
              sql`lower(${e.sourceKey}) like ${'%' + input.search.toLowerCase() + '%'}`,
              sql`cast(${e.payload} as text) like ${'%' + input.search.toLowerCase() + '%'}`,
              exists(
                db
                  .select({ one: sql`1` })
                  .from(d)
                  .where(
                    and(
                      eq(d.eventId, e.id),
                      or(
                        sql`cast(${d.id} as text) like ${'%' + input.search.toLowerCase() + '%'}`,
                        sql`lower(${d.recipientLabel}) like ${'%' + input.search.toLowerCase() + '%'}`,
                      ),
                    ),
                  ),
              ),
            )
          : undefined,
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
  const eventIds = rows.map((r) => r.id)
  const allDeliveries = eventIds.length
    ? await db
        .select()
        .from(d)
        .where(inArray(d.eventId, eventIds))
        .orderBy(asc(d.id))
    : []
  const deliveriesByEvent = new Map<string, typeof allDeliveries>()
  for (const delivery of allDeliveries) {
    let list = deliveriesByEvent.get(delivery.eventId)
    if (!list) {
      list = []
      deliveriesByEvent.set(delivery.eventId, list)
    }
    list.push(delivery)
  }

  const platformConfig = rows.length ? await getOrCreatePlatformConfig(db) : null
  const controlKeySet = new Set<string>()
  for (const delivery of allDeliveries) {
    if (['pending', 'retry_wait'].includes(delivery.status)) {
      for (const k of Object.keys(delivery.binding.controls ?? {})) {
        controlKeySet.add(k)
      }
    }
  }
  for (const row of rows) {
    if (row.state === 'waiting_result') {
      for (const b of row.bindings ?? []) {
        for (const k of Object.keys(b.controls ?? {})) {
          controlKeySet.add(k)
        }
      }
    }
  }
  const controlRows = controlKeySet.size
    ? await db
        .select()
        .from(c)
        .where(inArray(c.key, [...controlKeySet]))
    : []
  const controlsMap = new Map<string, (typeof controlRows)[number]>()
  for (const row of controlRows) {
    controlsMap.set(row.key, row)
  }

  const projected = await Promise.all(
    rows.map((r) =>
      toEvent(db, r, {
        deliveries: deliveriesByEvent.get(r.id) ?? [],
        document: platformConfig?.document,
        controlsMap,
      }),
    ),
  )
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
export async function getOutboundEvent(db: Db, actorId: string, eventId: string) {
  const { outboundEvents: e } = schemaFor(db)
  const [row] = await db
    .select()
    .from(e)
    .where(and(eq(e.id, eventId), await visible(db, actorId)))
  if (!row) throw notFound('OUTBOUND_NOT_FOUND', '推送不存在或无权访问')
  return toEvent(db, row, { detailed: true })
}
export async function getOutboundChannels(db: Db, actorId: string, targetId?: string) {
  const current = await getOrCreatePlatformConfig(db),
    n = current.document.outbound
  const manager = await has(db, actorId, 'platform-config:read')
  if (!manager) {
    if (!targetId) throw notFound('OUTBOUND_CHANNEL_NOT_FOUND', '请先选择有权访问的目标')
    const { assertTargetPermission } = await import('../console/target-authorization.js')
    await assertTargetPermission(db, actorId, targetId, 'workflow:read')
  }
  const { outboundControls: control } = schemaFor(db)
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
  const input = outboundActionSchema.parse(raw),
    id = `${actorId}:${input.idempotencyKey}`
  const { outboundCommands: c } = schemaFor(tx)
  const digest = hash({ action, resourceId, input })
  const [existing] = await tx.select().from(c).where(eq(c.id, id))
  if (existing && existing.digest !== digest)
    throw conflict('OUTBOUND_IDEMPOTENCY_CONFLICT', '幂等键已用于其他操作')
  return { input, id, digest, existing }
}
export async function createOutboundTest(
  db: Db,
  actorId: string,
  channelId: string,
  raw: unknown,
) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await requireOutboundPermission(tx, actorId, 'platform-config:write')
    await lockOutboundDispatch(tx)
    const cmd = await commandReceipt(tx, actorId, channelId, 'test', raw)
    if (cmd.existing) return { eventId: cmd.existing.resultId }
    const current = await getOrCreatePlatformConfig(tx),
      n = current.document.outbound
    const channel = n.channels.find((c) => c.id === channelId)
    if (!n.enabled || !channel?.enabled || (channel.kind === 'email' && !n.smtp?.enabled))
      throw badRequest('OUTBOUND_CHANNEL_UNAVAILABLE', '请先保存并启用渠道及发送配置')
    const { outboundEvents: e, outboundCommands: c } = schemaFor(tx)
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
      throw conflict('OUTBOUND_RATE_LIMITED', '测试发送过于频繁')
    const id = newId()
    const payload: OutboundPayload = { title: '识途消息推送渠道测试：这是一条合成测试消息' }
    if (channel.format === 'legacy_alert@1')
      payload.alert = {
        kind: 'firing',
        alertId: id,
        ruleId: 'outbound-test',
        ruleName: '推送渠道测试（合成消息）',
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
      bindings: await freezeOutboundBindings(tx, current.document, [channelId]),
      occurredAt: now,
      observedAt: now,
      nextPrepareAt: now,
    })
    await materializeOutboundDeliveries(tx, id)
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
      'outbound.test',
      'outbound_channel',
      channelId,
      cmd.input.reason,
    )
    return { eventId: id }
  })
}
export async function operateOutboundDelivery(
  db: Db,
  actorId: string,
  deliveryId: string,
  action: 'retry' | 'close',
  raw: unknown,
) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await requireOutboundPermission(tx, actorId, 'outbound:operate')
    await lockOutboundDispatch(tx)
    const {
      outboundDeliveries: d,
      outboundEvents: e,
      outboundCommands: c,
    } = schemaFor(tx)
    const [delivery] = await tx.select().from(d).where(eq(d.id, deliveryId))
    if (!delivery) throw notFound('OUTBOUND_NOT_FOUND', '推送不存在或无权访问')
    await getOutboundEvent(tx, actorId, delivery.eventId)
    const [event] = await tx.select().from(e).where(eq(e.id, delivery.eventId))
    if (event!.type.startsWith('alert.'))
      await requireOutboundPermission(tx, actorId, 'monitor:operate')
    if (event!.type === 'channel.test')
      await requireOutboundPermission(tx, actorId, 'platform-config:write')
    if (event!.targetId) {
      const { assertTargetPermission } = await import('../console/target-authorization.js')
      await assertTargetPermission(tx, actorId, event!.targetId, 'outbound:operate')
    }
    const cmd = await commandReceipt(tx, actorId, deliveryId, action, raw)
    if (cmd.existing) return { eventId: cmd.existing.resultId }
    const now = await clockNow(tx)
    const recent = await tx
      .select()
      .from(c)
      .where(and(eq(c.resourceId, deliveryId), gt(c.createdAt, new Date(now.getTime() - 60_000))))
      .limit(1)
    if (recent.length) throw conflict('OUTBOUND_RATE_LIMITED', '操作过于频繁')
    if (delivery.closedAt || event!.purgedAt)
      throw conflict('OUTBOUND_CLOSED', '记录已结案或正文已清理')
    if (action === 'close') {
      if (delivery.status !== 'unknown')
        throw conflict('OUTBOUND_STATE_CONFLICT', '仅结果不明可结案')
      await tx.update(d).set({ closedAt: now, updatedAt: now }).where(eq(d.id, deliveryId))
    } else {
      if (delivery.reason === 'legacy_unknown')
        throw conflict('OUTBOUND_LEGACY_UNKNOWN', '旧发送事实不完整，不能从此记录重发')
      if (!['failed', 'unknown'].includes(delivery.status))
        throw conflict('OUTBOUND_STATE_CONFLICT', '仅失败或结果不明可重试')
      if (delivery.status === 'unknown' && !cmd.input.confirmUnknown)
        throw badRequest('OUTBOUND_UNKNOWN_CONFIRMATION', '请确认再次发送可能重复')
      if (await bindingSuppression(tx, delivery.binding, event!))
        throw conflict('OUTBOUND_AUTHORIZATION_REVOKED', '原目的地授权已撤销，不能重试')
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
      action === 'retry' ? 'outbound.retry' : 'outbound.close',
      'outbound_delivery',
      deliveryId,
      cmd.input.reason,
    )
    return { eventId: delivery.eventId }
  })
}

// Backward-compatible aliases
export const listNotificationEvents = listOutboundEvents
export const getNotificationEvent = getOutboundEvent
export const getNotificationChannels = getOutboundChannels
export const createNotificationTest = createOutboundTest
export const operateNotificationDelivery = operateOutboundDelivery
