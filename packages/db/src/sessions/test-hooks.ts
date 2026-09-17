import { and, eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'

/** 仅测试 / 排障：把 last_used_at 拨到过去。 */
export async function forceLastUsedAt(db: Db, sessionId: string, at: Date): Promise<void> {
  const { browserSessions } = schemaFor(db)
  await db
    .update(browserSessions)
    .set({ lastUsedAt: at, updatedAt: new Date() })
    .where(eq(browserSessions.id, sessionId))
}

/** 仅测试：把租约 expires_at 拨到过去。 */
export async function forceLeaseExpiresAt(db: Db, leaseId: string, at: Date): Promise<void> {
  const { sessionLeases } = schemaFor(db)
  await db
    .update(sessionLeases)
    .set({ expiresAt: at })
    .where(and(eq(sessionLeases.id, leaseId), eq(sessionLeases.status, 'ACTIVE')))
}

/** 仅测试：强制改 generation（续租换代判定）。 */
export async function forceSessionGeneration(
  db: Db,
  sessionId: string,
  generation: number,
): Promise<void> {
  const { browserSessions } = schemaFor(db)
  await db
    .update(browserSessions)
    .set({ generation, updatedAt: new Date() })
    .where(eq(browserSessions.id, sessionId))
}
