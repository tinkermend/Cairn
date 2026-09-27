import { and, asc, eq, inArray, lt, lte, or } from 'drizzle-orm'
import {
  OUTBOUND_WORKER_PROTOCOL,
  NOTIFICATION_WORKER_PROTOCOL,
  type OutboundStatus,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { bindingSuppression, lockOutboundDispatch } from './core.js'

export type OutboundClaim = {
  deliveryId: string
  workerId: string
  instanceId: string
  epoch: number
}
export type OutboundJob = OutboundClaim & {
  delivery: typeof import('../schema/outbound.js').outboundDeliveries.$inferSelect
  event: typeof import('../schema/outbound.js').outboundEvents.$inferSelect
  attemptId: string
}

export type NotificationClaim = OutboundClaim
export type NotificationJob = OutboundJob

async function liveWorker(db: Db, workerId: string, instanceId: string, now: Date) {
  const { workers } = schemaFor(db)
  const [w] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.instanceId, instanceId)))
  return Boolean(
    w &&
    w.status === 'READY' &&
    (!w.heartbeatExpiresAt || w.heartbeatExpiresAt > now) &&
    w.protocolCapabilities?.some(
      (p) => p === OUTBOUND_WORKER_PROTOCOL || p === NOTIFICATION_WORKER_PROTOCOL,
    ),
  )
}

export async function claimOutboundDeliveries(
  db: Db,
  input: { workerId: string; instanceId: string; limit?: number; now?: Date },
): Promise<OutboundJob[]> {
  return atomic(db, async (tx) => {
    await lockOutboundDispatch(tx)
    const now = input.now ?? (await clockNow(tx))
    if (!(await liveWorker(tx, input.workerId, input.instanceId, now))) return []
    const { assertOutboundWriterRollout } = await import('./config.js')
    await assertOutboundWriterRollout(tx)
    const {
      outboundDeliveries: d,
      outboundEvents: e,
      outboundDeliveryAttempts: a,
    } = schemaFor(tx)
    const expired = await tx
      .select()
      .from(d)
      .where(and(eq(d.status, 'sending'), lte(d.claimExpiresAt, now)))
      .limit(100)
    for (const row of expired) {
      const [attempt] = await tx
        .select()
        .from(a)
        .where(and(eq(a.deliveryId, row.id), eq(a.attemptNo, row.attemptNo)))
      const uncertain = Boolean(attempt?.submittedAt)
      const replay =
        row.binding.channel.kind === 'webhook' &&
        row.binding.channel.replay === 'receiver_deduplicates'
      const retry =
        (!uncertain || replay) && row.automaticAttemptCount < 5 && attempt?.origin !== 'manual'
      const status = retry ? 'retry_wait' : uncertain ? 'unknown' : 'failed'
      await tx
        .update(d)
        .set({
          status,
          reason: uncertain ? 'owner_lost_after_submission' : 'owner_lost_before_submission',
          nextAttemptAt: retry ? now : null,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(d.id, row.id))
      if (attempt)
        await tx
          .update(a)
          .set({
            result: uncertain ? 'unknown' : 'failed',
            errorCode: 'owner_lost',
            finishedAt: now,
          })
          .where(eq(a.id, attempt.id))
    }
    const candidates = await tx
      .select()
      .from(d)
      .where(
        and(
          inArray(d.status, ['pending', 'retry_wait']),
          lte(d.nextAttemptAt, now),
          or(lt(d.automaticAttemptCount, 5), eq(d.manualPermit, true)),
        ),
      )
      .orderBy(asc(d.nextAttemptAt), asc(d.id))
      .limit(100)
    const jobs: OutboundJob[] = []
    for (const row of candidates) {
      if (jobs.length >= Math.min(input.limit ?? 4, 4)) break
      const [event] = await tx.select().from(e).where(eq(e.id, row.eventId))
      if (!event?.payload || event.purgedAt) continue
      const reason = await bindingSuppression(tx, row.binding, event)
      if (reason) {
        await tx
          .update(d)
          .set({ status: 'suppressed', reason, nextAttemptAt: null, updatedAt: now })
          .where(eq(d.id, row.id))
        continue
      }
      if (event.alertId) {
        const older = await tx
          .select({ id: d.id })
          .from(d)
          .innerJoin(e, eq(e.id, d.eventId))
          .where(
            and(
              eq(e.alertId, event.alertId),
              lt(e.sourceSequence, event.sourceSequence),
              eq(d.channelId, row.channelId),
              inArray(d.status, ['pending', 'sending', 'retry_wait']),
            ),
          )
          .limit(1)
        if (older.length) continue
      }
      const epoch = row.claimEpoch + 1,
        attemptNo = row.attemptNo + 1,
        attemptId = newId()
      const updates = {
        status: 'sending' as const,
        claimOwner: input.workerId,
        claimInstance: input.instanceId,
        claimEpoch: epoch,
        claimExpiresAt: new Date(now.getTime() + 120_000),
        attemptNo,
        automaticAttemptCount: row.automaticAttemptCount + (row.manualPermit ? 0 : 1),
        manualPermit: false,
        updatedAt: now,
      }
      await tx.update(d).set(updates).where(eq(d.id, row.id))
      await tx.insert(a).values({
        id: attemptId,
        deliveryId: row.id,
        attemptNo,
        claimEpoch: epoch,
        origin: row.manualPermit ? 'manual' : 'auto',
        actorId: row.manualPermit ? row.manualActorId : null,
        startedAt: now,
      })
      jobs.push({
        deliveryId: row.id,
        workerId: input.workerId,
        instanceId: input.instanceId,
        epoch,
        attemptId,
        delivery: { ...row, ...updates },
        event,
      })
    }
    return jobs
  })
}

async function claimRow(tx: Db, claim: OutboundClaim, now: Date) {
  const { outboundDeliveries: d } = schemaFor(tx)
  const [row] = await tx.select().from(d).where(eq(d.id, claim.deliveryId))
  if (
    !row ||
    row.status !== 'sending' ||
    row.claimOwner !== claim.workerId ||
    row.claimInstance !== claim.instanceId ||
    row.claimEpoch !== claim.epoch ||
    !row.claimExpiresAt ||
    row.claimExpiresAt <= now
  )
    return null
  return row
}

export async function beginOutboundSubmission(db: Db, claim: OutboundClaim) {
  return atomic(db, async (tx) => {
    const {
      outboundDeliveries: d,
      outboundEvents: e,
      outboundDeliveryAttempts: a,
      runs,
      scenarios,
      targets,
      monitoringAlerts,
    } = schemaFor(tx)
    const [initial] = await tx
      .select({ event: e })
      .from(d)
      .innerJoin(e, eq(e.id, d.eventId))
      .where(eq(d.id, claim.deliveryId))
    if (!initial) return false
    // Same source lock order as target/scenario deletion, then the dispatch gate.
    if (initial.event.targetId)
      await locked(
        tx,
        tx.select({ id: targets.id }).from(targets).where(eq(targets.id, initial.event.targetId)),
      )
    if (initial.event.scenarioId)
      await locked(
        tx,
        tx
          .select({ id: scenarios.id })
          .from(scenarios)
          .where(eq(scenarios.id, initial.event.scenarioId)),
      )
    if (initial.event.runId)
      await locked(
        tx,
        tx.select({ id: runs.id }).from(runs).where(eq(runs.id, initial.event.runId)),
      )
    if (initial.event.alertId)
      await locked(
        tx,
        tx
          .select({ id: monitoringAlerts.id })
          .from(monitoringAlerts)
          .where(eq(monitoringAlerts.id, initial.event.alertId)),
      )
    await lockOutboundDispatch(tx)
    const now = await clockNow(tx)
    const row = await claimRow(tx, claim, now)
    if (!row || !(await liveWorker(tx, claim.workerId, claim.instanceId, now))) return false
    const { assertOutboundWriterRollout } = await import('./config.js')
    await assertOutboundWriterRollout(tx)
    const reason = await bindingSuppression(tx, row.binding, initial.event)
    if (reason) {
      await tx
        .update(d)
        .set({ status: 'suppressed', reason, claimExpiresAt: null, updatedAt: now })
        .where(eq(d.id, row.id))
      await tx
        .update(a)
        .set({ result: 'suppressed', errorCode: reason, finishedAt: now })
        .where(and(eq(a.deliveryId, row.id), eq(a.attemptNo, row.attemptNo)))
      return false
    }
    const [attempt] = await tx
      .select()
      .from(a)
      .where(and(eq(a.deliveryId, row.id), eq(a.attemptNo, row.attemptNo)))
    if (!attempt || attempt.submittedAt) return false
    await tx.update(a).set({ submittedAt: now }).where(eq(a.id, attempt.id))
    return true
  })
}

export async function finishOutboundDelivery(
  db: Db,
  claim: OutboundClaim,
  result: {
    outcome: 'accepted' | 'retryable' | 'failed' | 'unknown'
    errorCode?: string
    responseCode?: number
  },
) {
  return atomic(db, async (tx) => {
    await lockOutboundDispatch(tx)
    const now = await clockNow(tx)
    const row = await claimRow(tx, claim, now)
    if (!row || !(await liveWorker(tx, claim.workerId, claim.instanceId, now))) return false
    const { outboundDeliveries: d, outboundDeliveryAttempts: a } = schemaFor(tx)
    const [attempt] = await tx
      .select()
      .from(a)
      .where(and(eq(a.deliveryId, row.id), eq(a.attemptNo, row.attemptNo)))
    if (!attempt) return false
    const safe =
      result.outcome === 'retryable' ||
      (result.outcome === 'unknown' &&
        row.binding.channel.kind === 'webhook' &&
        row.binding.channel.replay === 'receiver_deduplicates')
    const retry = safe && attempt.origin === 'auto' && row.automaticAttemptCount < 5
    const status: OutboundStatus = retry
      ? 'retry_wait'
      : result.outcome === 'retryable'
        ? 'failed'
        : result.outcome
    await tx
      .update(d)
      .set({
        status,
        reason: result.errorCode?.slice(0, 64) ?? null,
        nextAttemptAt: retry
          ? new Date(
              now.getTime() + Math.min(600_000, 30_000 * 2 ** (row.automaticAttemptCount - 1)),
            )
          : null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(d.id, row.id))
    await tx
      .update(a)
      .set({
        result: result.outcome === 'retryable' ? 'failed' : result.outcome,
        errorCode: result.errorCode?.slice(0, 64) ?? null,
        responseCode: result.responseCode ?? null,
        finishedAt: now,
      })
      .where(eq(a.id, attempt.id))
    return true
  })
}

// Backward-compatible aliases
export const claimNotificationDeliveries = claimOutboundDeliveries
export const beginNotificationSubmission = beginOutboundSubmission
export const finishNotificationDelivery = finishOutboundDelivery
