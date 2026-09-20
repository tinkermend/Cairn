import { and, asc, eq, inArray, isNull, lt, notExists, or, sql } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { enqueueAlertNotificationTx, lockNotificationDispatch, bindingSuppression } from './core.js'

/** Old senders must be stopped before migration. Existing new-format event means this alert is already owned. */
export async function importLegacyNotificationNotices(db: Db) {
  const { assertNotificationWriterRollout } = await import('./config.js')
  await assertNotificationWriterRollout(db)
  const { monitoringAlerts: a, notificationEvents: e, notificationDeliveries: d } = schemaFor(db)
  const rows = await db
    .select({ id: a.id })
    .from(a)
    .where(
      and(
        inArray(a.deliveryStatus, ['pending', 'sending', 'failed']),
        notExists(db.select({ id: e.id }).from(e).where(eq(e.alertId, a.id))),
      ),
    )
    .orderBy(asc(a.createdAt))
    .limit(50)
  for (const row of rows)
    await atomic(db, async (tx) => {
      const [alert] = await locked(tx, tx.select().from(a).where(eq(a.id, row.id)))
      if (!alert?.deliveryKind) return
      await lockNotificationDispatch(tx)
      if ((await tx.select({ id: e.id }).from(e).where(eq(e.alertId, row.id)).limit(1)).length)
        return
      const key = `legacy:${row.id}:${alert.deliveryKind}`
      await enqueueAlertNotificationTx(tx, row.id, alert.deliveryKind, key)
      if (alert.deliveryStatus !== 'pending' || alert.deliveryAttempts > 0) {
        const [event] = await tx.select().from(e).where(eq(e.sourceKey, key))
        if (event)
          await tx
            .update(d)
            .set({ status: 'unknown', reason: 'legacy_unknown', nextAttemptAt: null })
            .where(eq(d.eventId, event.id))
      }
    })
  return rows.length
}

/** Persist revocations promptly even for deliveries whose retry time has not arrived. */
export async function reconcileNotificationSuppressions(db: Db) {
  return atomic(db, async (tx) => {
    await lockNotificationDispatch(tx)
    const { notificationDeliveries: d, notificationEvents: e } = schemaFor(tx)
    const now = await clockNow(tx)
    const rows = await tx
      .select({ delivery: d, event: e })
      .from(d)
      .innerJoin(e, eq(e.id, d.eventId))
      .where(inArray(d.status, ['pending', 'retry_wait']))
      .orderBy(asc(d.updatedAt), asc(d.id))
      .limit(100)
    for (const { delivery, event } of rows) {
      const reason = await bindingSuppression(tx, delivery.binding, event)
      await tx
        .update(d)
        .set(
          reason
            ? { status: 'suppressed', reason, nextAttemptAt: null, updatedAt: now }
            : { updatedAt: now },
        )
        .where(eq(d.id, delivery.id))
    }
    return rows.length
  })
}

export async function purgeNotificationHistory(db: Db, options: { now?: Date } = {}) {
  return atomic(db, async (tx) => {
    await lockNotificationDispatch(tx)
    const {
      notificationEvents: e,
      notificationDeliveries: d,
      notificationDeliveryAttempts: a,
    } = schemaFor(tx)
    const now = options.now ?? (await clockNow(tx)),
      cutoff = new Date(now.getTime() - 30 * 86400_000)
    const events = await tx
      .select({ id: e.id })
      .from(e)
      .where(
        and(
          isNull(e.purgedAt),
          lt(e.occurredAt, cutoff),
          inArray(e.state, ['ready', 'filtered', 'suppressed']),
          notExists(
            tx
              .select({ id: d.id })
              .from(d)
              .where(
                and(
                  eq(d.eventId, e.id),
                  or(
                    inArray(d.status, ['pending', 'sending', 'retry_wait']),
                    and(eq(d.status, 'unknown'), isNull(d.closedAt)),
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(e.occurredAt))
      .limit(100)
    for (const event of events) {
      const ids = (await tx.select({ id: d.id }).from(d).where(eq(d.eventId, event.id))).map(
        (v) => v.id,
      )
      if (ids.length) await tx.delete(a).where(inArray(a.deliveryId, ids))
      await tx
        .update(e)
        .set({ payload: null, policy: null, bindings: [], consoleUrl: null, purgedAt: now })
        .where(eq(e.id, event.id))
    }
    return events.length
  })
}
