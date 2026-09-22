import { and, eq, isNull, or } from 'drizzle-orm'
import { platformConfigDocumentSchema } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor, updateRows } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { findLiveSessions, getSessionById } from './sessions.js'

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
          or(
            eq(sessionRetentionIntents.sessionId, from.id),
            and(
              eq(sessionRetentionIntents.targetId, from.targetId),
              eq(sessionRetentionIntents.targetAccountId, from.targetAccountId),
              isNull(sessionRetentionIntents.sessionId),
            ),
          ),
        ),
    )
    if (!intent || intent.retainUntil.getTime() <= Date.now()) return
    await updateRows(
      tx,
      sessionRetentionIntents,
      { sessionId: input.toSessionId, updatedAt: new Date() },
      eq(sessionRetentionIntents.id, intent.id),
    )
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

export async function readRetentionConfig(db: Db) {
  const current = await getOrCreatePlatformConfig(db)
  const document = platformConfigDocumentSchema.parse(current.document)
  return { retention: document.sessionRetention, revision: current.revision }
}

/** 账号上未过期的人工保留意图落到当前实例，避免重建后只剩过期文案、实例却可被空闲回收。 */
export async function applyPendingRetentionIntent(db: Db, sessionId: string): Promise<boolean> {
  const session = await getSessionById(db, sessionId)
  if (!session) return false
  const now = await clockNow(db)
  if (session.retainUntil && session.retainUntil.getTime() > now.getTime()) return false
  const intent = await resolveRetentionIntent(db, session, now)
  if (!intent || intent.retainUntil.getTime() <= now.getTime()) return false
  const { sessionRetentionIntents, browserSessions } = schemaFor(db)
  const { retention } = await readRetentionConfig(db)
  if (intent.sessionId !== session.id) {
    await updateRows(
      db,
      sessionRetentionIntents,
      { sessionId: session.id, updatedAt: now },
      eq(sessionRetentionIntents.id, intent.id),
    )
  }
  await updateRows(
    db,
    browserSessions,
    {
      retainUntil: intent.retainUntil,
      nextAuthCheckAt:
        session.nextAuthCheckAt && session.nextAuthCheckAt.getTime() > now.getTime()
          ? session.nextAuthCheckAt
          : new Date(now.getTime() + retention.maintenanceIntervalSeconds * 1000),
      updatedAt: now,
    },
    eq(browserSessions.id, session.id),
  )
  return true
}

async function resolveRetentionIntent(
  db: Db,
  session: { id: string; targetId: string; targetAccountId: string; accountSlot: number },
  now: Date,
) {
  const { sessionRetentionIntents } = schemaFor(db)
  const rows = await db
    .select()
    .from(sessionRetentionIntents)
    .where(
      and(
        eq(sessionRetentionIntents.targetId, session.targetId),
        eq(sessionRetentionIntents.targetAccountId, session.targetAccountId),
      ),
    )
  if (rows.length === 0) return null
  const liveIds = new Set(
    (await findLiveSessions(db, { targetId: session.targetId, targetAccountId: session.targetAccountId })).map(
      (row) => row.id,
    ),
  )
  const eligible: { row: (typeof rows)[number]; rank: number }[] = []
  for (const row of rows) {
    if (row.retainUntil.getTime() <= now.getTime()) continue
    if (row.sessionId === session.id) {
      eligible.push({ row, rank: 0 })
      continue
    }
    if (!row.sessionId) {
      const others = [...liveIds].filter((id) => id !== session.id)
      if (others.length === 0) eligible.push({ row, rank: 2 })
      continue
    }
    if (liveIds.has(row.sessionId)) continue
    const bound = await getSessionById(db, row.sessionId)
    if (bound && bound.accountSlot !== session.accountSlot) continue
    eligible.push({ row, rank: 1 })
  }
  eligible.sort((left, right) => left.rank - right.rank)
  return eligible[0]?.row ?? null
}
