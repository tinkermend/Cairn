import { and, eq } from 'drizzle-orm'
import { platformConfigDocumentSchema } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor, updateRows } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { getSessionById } from './sessions.js'

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
  const { sessionRetentionIntents, browserSessions } = schemaFor(db)
  const [intent] = await db
    .select()
    .from(sessionRetentionIntents)
    .where(
      and(
        eq(sessionRetentionIntents.targetId, session.targetId),
        eq(sessionRetentionIntents.targetAccountId, session.targetAccountId),
      ),
    )
    .limit(1)
  if (!intent || intent.retainUntil.getTime() <= now.getTime()) return false
  const { retention } = await readRetentionConfig(db)
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
