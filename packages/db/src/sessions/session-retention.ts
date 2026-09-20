import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { retentionQuota, type SessionRetentionBody } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, databaseNow, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { conflict } from '../runs/errors.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { assertSessionAccountActive, assertSessionActorPermission } from './access.js'
import { appendSessionEvent } from './session-events.js'
import { lockConsoleAuthorization, assertTargetPermission } from '../console/target-authorization.js'
import { findLiveSession, getSessionById, type SessionKey } from './sessions.js'
import { readRetentionConfig } from './session-retention-intent.js'

export { applyPendingRetentionIntent, readRetentionConfig } from './session-retention-intent.js'

export async function setSessionRetention(
  db: Db,
  input: { key: SessionKey; body: SessionRetentionBody; actor: AuditActor },
) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, input.actor.id)
    await assertTargetPermission(tx, input.actor.id, input.key.targetId, 'session:control')
    await assertSessionAccountActive(tx, input.key)
    await assertSessionActorPermission(tx, input.actor.id, 'session:control')
    const { retention, revision } = await readRetentionConfig(tx)
    const { sessionRetentionIntents, browserSessions, workers, targetAccounts } = schemaFor(tx)
    const initial = await findLiveSession(tx, input.key)
    if (initial)
      await locked(
        tx,
        tx.select({ id: workers.id }).from(workers).where(eq(workers.id, initial.ownerWorkerId)),
      )
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, input.key.targetAccountId)),
    )
    const now = await clockNow(tx)
    const live = await findLiveSession(tx, input.key)
    if (live && (live.id !== initial?.id || live.ownerWorkerId !== initial.ownerWorkerId))
      throw conflict('SESSION_GENERATION_CHANGED', '会话已重建')
    const [existing] = await tx
      .select()
      .from(sessionRetentionIntents)
      .where(
        and(
          eq(sessionRetentionIntents.targetId, input.key.targetId),
          eq(sessionRetentionIntents.targetAccountId, input.key.targetAccountId),
        ),
      )
      .limit(1)

    if (input.body.action === 'clear') {
      if (existing) {
        await tx.delete(sessionRetentionIntents).where(eq(sessionRetentionIntents.id, existing.id))
      }
      if (live) {
        const keepProbe =
          live.reclaimMode === 'AUTH_DRIVEN' &&
          live.keepAliveUntil != null &&
          live.keepAliveUntil.getTime() > now.getTime()
        await updateRows(
          tx,
          browserSessions,
          {
            retainUntil: null,
            ...(keepProbe ? {} : { nextAuthCheckAt: null }),
            updatedAt: now,
          },
          eq(browserSessions.id, live.id),
        )
      }
      await appendSessionEvent(tx, {
        key: input.key,
        type: 'retention.cleared',
        sessionId: live?.id,
        generation: live?.generation,
        payload: { platformConfigRevision: revision },
      })
      await recordAudit(
        tx,
        input.actor,
        'session.retention',
        'session',
        input.key.targetAccountId,
        '取消会话保留',
      )
      return { retainUntil: null, revision }
    }

    if (!live || live.status !== 'OPEN') {
      throw conflict('SESSION_NOT_CLAIMABLE', '设置保留需要该账号已有打开的会话实例')
    }
    const seconds = input.body.retainSeconds
    if (seconds > retention.maxRetainSeconds) {
      throw conflict('SESSION_POLICY_INVALID', `单次保留不能超过 ${retention.maxRetainSeconds} 秒`)
    }
    const nextUntil = new Date(now.getTime() + seconds * 1000)
    if (existing && input.body.action === 'extend' && existing.retainUntil.getTime() >= nextUntil.getTime()) {
      return { retainUntil: existing.retainUntil.toISOString(), revision }
    }
    const [worker] = await locked(tx, tx.select().from(workers).where(eq(workers.id, live.ownerWorkerId)))
    const limit = retentionQuota(worker?.maxSessions ?? 0, retention.reservedFreeSlotsPerWorker)
    if (limit <= 0) throw conflict('RETENTION_QUOTA_EXCEEDED', '该执行节点不接受保留')
    const retained = await tx
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.ownerWorkerId, live.ownerWorkerId),
          inArray(browserSessions.status, ['CREATING', 'OPEN']),
          sql`${browserSessions.retainUntil} > ${databaseNow(tx)}`,
        ),
      )
    const already = retained.some((row) => row.id === live.id)
    if (retained.length - (already ? 1 : 0) >= limit) {
      throw conflict('RETENTION_QUOTA_EXCEEDED', '该执行节点保留配额已满', {
        quotaUsed: retained.length,
        quotaLimit: limit,
      })
    }
    if (existing) {
      await updateRows(
        tx,
        sessionRetentionIntents,
        {
          retainUntil: nextUntil,
          reason: input.body.reason ?? existing.reason,
          platformConfigRevision: revision,
          updatedAt: now,
        },
        eq(sessionRetentionIntents.id, existing.id),
      )
    } else {
      await insertRows(tx, sessionRetentionIntents, {
        id: newId(),
        targetId: input.key.targetId,
        targetAccountId: input.key.targetAccountId,
        retainUntil: nextUntil,
        reason: input.body.reason ?? null,
        createdBy: input.actor.id,
        platformConfigRevision: revision,
        createdAt: now,
        updatedAt: now,
      })
    }
    await updateRows(
      tx,
      browserSessions,
      {
        retainUntil: nextUntil,
        nextAuthCheckAt: new Date(now.getTime() + retention.maintenanceIntervalSeconds * 1000),
        updatedAt: now,
      },
      eq(browserSessions.id, live.id),
    )
    await appendSessionEvent(tx, {
      key: input.key,
      type: input.body.action === 'extend' ? 'retention.extended' : 'retention.set',
      sessionId: live.id,
      generation: live.generation,
      payload: { retainUntil: nextUntil.toISOString(), platformConfigRevision: revision },
    })
    await recordAudit(
      tx,
      input.actor,
      'session.retention',
      'session',
      live.id,
      input.body.action === 'extend' ? '延长会话保留' : '设置会话保留',
    )
    return { retainUntil: nextUntil.toISOString(), revision }
  })
}

export async function adoptSessionRetention(
  db: Db,
  input: { fromSessionId: string; toSessionId: string },
): Promise<void> {
  await atomic(db, async (tx) => {
    const { browserSessions, sessionRetentionIntents, targetAccounts } = schemaFor(tx)
    const from = await getSessionById(tx, input.fromSessionId)
    if (!from?.retainUntil || from.retainUntil.getTime() <= Date.now()) return
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, from.targetAccountId)),
    )
    const [intent] = await locked(
      tx,
      tx
        .select()
        .from(sessionRetentionIntents)
        .where(
          and(
            eq(sessionRetentionIntents.targetId, from.targetId),
            eq(sessionRetentionIntents.targetAccountId, from.targetAccountId),
          ),
        ),
    )
    if (!intent || intent.retainUntil.getTime() <= Date.now()) return
    await updateRows(
      tx,
      browserSessions,
      {
        retainUntil: intent.retainUntil,
        predecessorSessionId: from.id,
        nextAuthCheckAt: new Date(),
        updatedAt: new Date(),
      },
      and(
        eq(browserSessions.id, input.toSessionId),
        eq(browserSessions.targetId, from.targetId),
        eq(browserSessions.targetAccountId, from.targetAccountId),
      ),
    )
  })
}

export async function scheduleNextAuthCheck(db: Db, sessionId: string): Promise<void> {
  const { retention } = await readRetentionConfig(db)
  const session = await getSessionById(db, sessionId)
  const intervalSeconds = session?.authProbeIntervalSeconds ?? retention.maintenanceIntervalSeconds
  const { browserSessions } = schemaFor(db)
  const now = await clockNow(db)
  await updateRows(
    db,
    browserSessions,
    {
      nextAuthCheckAt: new Date(now.getTime() + intervalSeconds * 1000),
      updatedAt: now,
    },
    eq(browserSessions.id, sessionId),
  )
}

export async function abandonSessionKeepAlive(db: Db, sessionId: string): Promise<void> {
  const { browserSessions } = schemaFor(db)
  const now = await clockNow(db)
  await updateRows(
    db,
    browserSessions,
    { nextAuthCheckAt: null, updatedAt: now },
    eq(browserSessions.id, sessionId),
  )
}

export async function listDueRetainedSessions(db: Db, workerId: string) {
  const { browserSessions, targetAccounts, targets, targetAccountAuthBudget } = schemaFor(db)
  return db
    .select({ session: browserSessions })
    .from(browserSessions)
    .innerJoin(targetAccounts, eq(targetAccounts.id, browserSessions.targetAccountId))
    .innerJoin(targets, eq(targets.id, browserSessions.targetId))
    .leftJoin(targetAccountAuthBudget, eq(targetAccountAuthBudget.targetAccountId, targetAccounts.id))
    .where(
      and(
        eq(browserSessions.ownerWorkerId, workerId),
        eq(browserSessions.status, 'OPEN'),
        sql`${browserSessions.nextAuthCheckAt} <= ${databaseNow(db)}`,
        or(
          and(
            sql`${browserSessions.retainUntil} > ${databaseNow(db)}`,
            isNull(targetAccountAuthBudget.pausedReason),
          ),
          sql`${browserSessions.keepAliveUntil} > ${databaseNow(db)}`,
        ),
        isNull(targetAccounts.deletedAt),
        isNull(targets.deletedAt),
        eq(targetAccounts.status, 'active'),
        eq(targets.status, 'active'),
      ),
    )
}
