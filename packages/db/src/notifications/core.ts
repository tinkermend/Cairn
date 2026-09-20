import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm'
import {
  DEFAULT_NOTIFICATION_POLICY,
  FINISHED_RUN_STATUSES,
  RUN_NOTIFICATION_PROTOCOL,
  FACTORY_PLATFORM_CONFIG,
  frozenNotificationPolicySchema,
  notificationPayloadSchema,
  notificationReasons,
  type FrozenNotificationBinding,
  type FrozenNotificationPolicy,
  type NotificationPayload,
  type PlatformConfigDocument,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, insertIgnoreRows, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { getOrCreatePlatformConfig, getPlatformConfig } from '../platform-config/store.js'
import { recalculateRunOutcomeTx } from '../runs/outcome-results.js'

export async function lockNotificationDispatch(tx: Db) {
  const { notificationControls: c } = schemaFor(tx)
  await locked(tx, tx.select().from(c).where(eq(c.key, 'dispatch')))
}
export async function notificationControlValues(db: Db, keys: string[]) {
  const { notificationControls: c } = schemaFor(db)
  const rows = keys.length ? await db.select().from(c).where(inArray(c.key, keys)) : []
  return Object.fromEntries(
    keys.map((key) => [key, rows.find((r) => r.key === key)?.generation ?? 0]),
  )
}
export async function bumpNotificationControl(tx: Db, key: string, revoked = false) {
  const { notificationControls: c } = schemaFor(tx)
  await insertIgnoreRows(tx, c, { key, generation: 0, revoked: false })
  const [row] = await locked(tx, tx.select().from(c).where(eq(c.key, key)))
  await tx
    .update(c)
    .set({ generation: row!.generation + 1, revoked: revoked || row!.revoked })
    .where(eq(c.key, key))
}
export async function freezeNotificationBindings(
  db: Db,
  document: PlatformConfigDocument,
  ids: string[],
  targetId?: string,
  scenarioId?: string,
) {
  const n = document.notifications
  const out: FrozenNotificationBinding[] = []
  for (const id of ids) {
    const channel = n.channels.find((c) => c.id === id)
    if (!channel) continue
    const keys = [
      'global',
      `channel:${id}`,
      `version:${id}:${channel.version}`,
      ...(targetId ? [`grant:${id}:${targetId}`] : []),
      ...(scenarioId ? [`scenario:${scenarioId}`] : []),
      ...(channel.kind === 'email' ? ['smtp', `smtp-version:${n.smtp?.version ?? 0}`] : []),
    ]
    out.push({
      channel: targetId ? { ...channel, targetIds: [targetId] } : channel,
      smtp:
        channel.kind === 'email' && n.smtp
          ? { enabled: n.smtp.enabled, version: n.smtp.version, secretRef: n.smtp.secretRef }
          : null,
      controls: await notificationControlValues(db, keys),
    })
  }
  return out
}
export async function freezeRunNotificationPolicy(
  tx: Db,
  input: {
    scenarioId: string
    targetId: string
    scenarioName: string
    targetName: string
    source: 'console' | 'service'
    eligible: boolean
  },
): Promise<FrozenNotificationPolicy> {
  await lockNotificationDispatch(tx)
  const { scenarioNotificationPolicies: p } = schemaFor(tx)
  const current = (await getPlatformConfig(tx)) ?? {
    revision: 0,
    document: FACTORY_PLATFORM_CONFIG,
  }
  const [row] = await tx.select().from(p).where(eq(p.scenarioId, input.scenarioId))
  const policy = row?.policy ?? DEFAULT_NOTIFICATION_POLICY
  const enabled =
    input.eligible &&
    policy.enabled &&
    current.document.notifications.enabled &&
    policy.sourceKinds.includes(input.source)
  if (enabled) {
    const { assertNotificationWriterRollout } = await import('./config.js')
    await assertNotificationWriterRollout(tx)
  }
  return frozenNotificationPolicySchema.parse({
    protocol: RUN_NOTIFICATION_PROTOCOL,
    enabled,
    reason: !input.eligible ? 'ineligible_source' : !enabled ? 'disabled' : 'enabled',
    policyRevision: row?.revision ?? 0,
    configRevision: current.revision,
    policy,
    source: input.source,
    scenarioName: input.scenarioName,
    targetName: input.targetName,
    consoleBaseUrl: current.document.notifications.consoleBaseUrl,
    templateVersion: 1,
    bindings: enabled
      ? await freezeNotificationBindings(
          tx,
          current.document,
          policy.channelIds,
          input.targetId,
          input.scenarioId,
        )
      : [],
  })
}
export async function enqueueRunNotificationIntentTx(tx: Db, runId: string) {
  const { runs, notificationEvents: e } = schemaFor(tx)
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId))
  if (!run?.finishedAt || !(FINISHED_RUN_STATUSES as readonly string[]).includes(run.status)) return
  const policy = run.snapshot.notificationPolicy
  if (!policy?.enabled) return
  await insertIgnoreRows(tx, e, {
    id: newId(),
    sourceKey: `run:${run.id}:finished`,
    type: 'run.finished',
    runId: run.id,
    targetId: run.targetId,
    scenarioId: run.scenarioId,
    state: 'waiting_result',
    policy,
    bindings: policy.bindings,
    occurredAt: run.finishedAt,
    nextPrepareAt: run.finishedAt,
    consoleUrl: policy.consoleBaseUrl
      ? `${policy.consoleBaseUrl.replace(/\/$/, '')}/runs/${run.id}`
      : null,
  })
}

export async function bindingSuppression(
  db: Db,
  binding: FrozenNotificationBinding,
  event: {
    type: string
    targetId: string | null
    scenarioId: string | null
    runId: string | null
    alertId: string | null
  },
  document?: PlatformConfigDocument,
): Promise<string | null> {
  const { notificationControls: c, runs, targets, scenarios, monitoringAlerts } = schemaFor(db)
  const controls = await db
    .select()
    .from(c)
    .where(inArray(c.key, Object.keys(binding.controls)))
  if (controls.some((row) => row.revoked || row.generation !== binding.controls[row.key]))
    return 'authorization_revoked'
  const doc = document ?? (await getOrCreatePlatformConfig(db)).document
  const channel = doc.notifications.channels.find((v) => v.id === binding.channel.id)
  if (!doc.notifications.enabled) return 'notifications_paused'
  if (!binding.channel.enabled) return 'channel_disabled_at_capture'
  if (!channel?.enabled) return 'channel_disabled'
  if (
    binding.channel.kind === 'email' &&
    (!binding.smtp?.enabled || !doc.notifications.smtp?.enabled)
  )
    return 'smtp_disabled'
  if (event.type.startsWith('alert.')) {
    if (!channel.allowAlerts || !binding.channel.allowAlerts) return 'alert_use_revoked'
    if (event.alertId) {
      const [alert] = await db
        .select()
        .from(monitoringAlerts)
        .where(eq(monitoringAlerts.id, event.alertId))
      if (!alert) return 'source_deleted'
      if (alert.silencedUntil && alert.silencedUntil > (await clockNow(db))) return 'alert_silenced'
    }
  }
  if (event.type === 'run.finished') {
    if (
      !event.targetId ||
      !channel.targetIds.includes(event.targetId) ||
      !binding.channel.targetIds.includes(event.targetId)
    )
      return 'target_use_revoked'
    const [target] = await db.select().from(targets).where(eq(targets.id, event.targetId))
    const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, event.scenarioId!))
    const [run] = await db.select().from(runs).where(eq(runs.id, event.runId!))
    if (!target || target.deletedAt || !scenario || scenario.deletedAt || !run || run.deletedAt)
      return 'source_deleted'
    if (binding.channel.format !== 'cairn.notification@1') return 'channel_protocol_unsupported'
  }
  return null
}

export async function materializeNotificationDeliveries(tx: Db, eventId: string) {
  const { notificationEvents: e, notificationDeliveries: d } = schemaFor(tx)
  const [event] = await tx.select().from(e).where(eq(e.id, eventId))
  if (!event || event.state !== 'ready') return
  const now = await clockNow(tx)
  const document = (await getOrCreatePlatformConfig(tx)).document
  for (const binding of event.bindings) {
    const suppressed = await bindingSuppression(tx, binding, event, document)
    const recipients =
      binding.channel.kind === 'webhook'
        ? [{ id: 'webhook', masked: binding.channel.host }]
        : binding.channel.recipients
    for (const recipient of recipients)
      await insertIgnoreRows(tx, d, {
        id: newId(),
        eventId,
        channelId: binding.channel.id,
        binding,
        recipientKey: recipient.id,
        recipientLabel: recipient.masked,
        status: suppressed ? 'suppressed' : 'pending',
        reason: suppressed,
        nextAttemptAt: suppressed ? null : now,
        updatedAt: now,
      })
  }
  if (!event.bindings.length)
    await tx
      .update(e)
      .set({ state: 'suppressed', reason: 'no_destination' })
      .where(eq(e.id, eventId))
}

export async function prepareNotificationEvents(
  db: Db,
  options: { now?: Date; limit?: number } = {},
) {
  const { notificationEvents: e, runs } = schemaFor(db)
  const now = options.now ?? (await clockNow(db))
  const rows = await db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.state, 'waiting_result'), lte(e.nextPrepareAt, now)))
    .orderBy(asc(e.nextPrepareAt), asc(e.id))
    .limit(options.limit ?? 50)
  for (const row of rows)
    await atomic(db, async (tx) => {
      // The source row precedes the dispatch lock everywhere that also mutates a Run.
      const [initial] = await tx.select().from(e).where(eq(e.id, row.id))
      if (!initial?.runId) return
      const [run] = await locked(tx, tx.select().from(runs).where(eq(runs.id, initial.runId)))
      await lockNotificationDispatch(tx)
      const [event] = await locked(tx, tx.select().from(e).where(eq(e.id, row.id)))
      if (!event || event.state !== 'waiting_result') return
      const eligible = await Promise.all(
        event.bindings.map((b) => bindingSuppression(tx, b, event)),
      )
      if (!run || run.deletedAt || !eligible.some((v) => v === null)) {
        await tx
          .update(e)
          .set({
            state: 'suppressed',
            reason: !run || run.deletedAt ? 'source_deleted' : (eligible[0] ?? 'no_destination'),
          })
          .where(eq(e.id, row.id))
        return
      }
      if (!run.finishedAt || !(FINISHED_RUN_STATUSES as readonly string[]).includes(run.status))
        return
      if (run.evidenceStatus === 'PENDING' && now.getTime() < run.finishedAt.getTime() + 60_000) {
        await tx
          .update(e)
          .set({
            nextPrepareAt: new Date(
              Math.min(now.getTime() + 5000, run.finishedAt.getTime() + 60_000),
            ),
          })
          .where(eq(e.id, row.id))
        return
      }
      const outcomeStatus = await recalculateRunOutcomeTx(tx, run.id, run.snapshot, now)
      const policy = event.policy!
      const reasons = notificationReasons(policy.policy, { ...run, outcomeStatus })
      if (!reasons.length) {
        await tx
          .update(e)
          .set({ state: 'filtered', reason: 'conditions_not_matched', observedAt: now })
          .where(eq(e.id, row.id))
        return
      }
      const payload = notificationPayloadSchema.parse({
        title: `运行结果：${policy.scenarioName}`,
        scenarioName: policy.scenarioName,
        targetName: policy.targetName,
        source: policy.source,
        scenarioVersionId: run.scenarioVersionId,
        status: run.status,
        outcomeStatus,
        evidenceStatus: run.evidenceStatus,
        summaryStage: run.evidenceStatus === 'PENDING' ? 'evidence_pending' : 'settled',
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt.toISOString(),
        durationMs: run.startedAt
          ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime())
          : null,
        reasons,
      })
      await tx.update(e).set({ state: 'ready', payload, observedAt: now }).where(eq(e.id, row.id))
      await materializeNotificationDeliveries(tx, row.id)
    })
  return rows.length
}

export async function enqueueAlertNotificationTx(
  tx: Db,
  alertId: string,
  kind: 'firing' | 'resolved' | 'interrupted',
  legacyKey?: string,
) {
  const { monitoringAlerts: a, notificationEvents: e } = schemaFor(tx)
  const [alert] = await tx.select().from(a).where(eq(a.id, alertId))
  if (!alert) return
  await lockNotificationDispatch(tx)
  const current = await getOrCreatePlatformConfig(tx)
  if (current.document.notifications.enabled) {
    const { assertNotificationWriterRollout } = await import('./config.js')
    await assertNotificationWriterRollout(tx)
  }
  const bindings = await freezeNotificationBindings(tx, current.document, alert.channelIds)
  const previous = await tx
    .select({ sequence: e.sourceSequence })
    .from(e)
    .where(eq(e.alertId, alertId))
    .orderBy(asc(e.sourceSequence))
  const sequence = (previous.at(-1)?.sequence ?? 0) + 1
  const now = await clockNow(tx)
  const occurredAt =
    (kind === 'firing'
      ? alert.firedAt
      : kind === 'resolved'
        ? alert.resolvedAt
        : alert.interruptedAt) ?? now
  const payload: NotificationPayload = {
    title: `${kind === 'resolved' ? '告警恢复' : kind === 'interrupted' ? '判断依据中断' : '告警触发'}：${alert.ruleName}`,
    alert: {
      kind,
      alertId,
      ruleId: alert.ruleId,
      ruleName: alert.ruleName,
      scope: alert.scope,
      scopeId: alert.scopeId,
      severity: alert.severity,
      metricKey: alert.metricKey,
      source: alert.staleSource,
      value: alert.triggerValue,
      threshold: alert.threshold,
      comparator: alert.comparator,
      occurredAt: occurredAt.toISOString(),
      consolePath: '/monitoring',
    },
  }
  const id = newId()
  await insertIgnoreRows(tx, e, {
    id,
    sourceKey: legacyKey ?? `alert:${alertId}:${sequence}`,
    type: `alert.${kind}`,
    alertId,
    sourceSequence: sequence,
    state: 'ready',
    payload: notificationPayloadSchema.parse(payload),
    bindings,
    occurredAt,
    observedAt: now,
    nextPrepareAt: now,
    consoleUrl: current.document.notifications.consoleBaseUrl
      ? `${current.document.notifications.consoleBaseUrl.replace(/\/$/, '')}/monitoring`
      : null,
  })
  await materializeNotificationDeliveries(tx, id)
}

export async function repairNotificationIntents(db: Db) {
  const { runs, notificationEvents: e } = schemaFor(db)
  const candidates = await db
    .select({ id: runs.id })
    .from(runs)
    .leftJoin(e, eq(e.runId, runs.id))
    .where(
      and(
        eq(runs.notificationExpected, true),
        inArray(runs.status, [...FINISHED_RUN_STATUSES]),
        isNull(e.id),
        isNull(runs.deletedAt),
      ),
    )
    .orderBy(asc(runs.finishedAt), asc(runs.id))
    .limit(100)
  for (const run of candidates) await atomic(db, (tx) => enqueueRunNotificationIntentTx(tx, run.id))
}
