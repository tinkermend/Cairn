import { and, eq, sql } from 'drizzle-orm'
import type { SessionLostDisposition } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor, updateRows } from '../native.js'
import { expireAuthWaitHolderLost } from './occupancy-reap.js'
import { appendSessionEvent } from './session-events.js'
import { loadResolvedSessionPolicyForTarget } from './session-policy.js'

const AUTO_CLOSE_REASON = 'owner_lost_auto_disposed'
const AUTH_WAIT_MAX_RECOVERIES = 3

export type IsolatedLostRow = {
  id: string
  targetId: string
  targetAccountId: string
  generation: number
  closeReason: string | null
}

export async function recordIsolatedSessionLoss(db: Db, rows: IsolatedLostRow[]): Promise<void> {
  for (const row of rows) {
    await appendSessionEvent(db, {
      key: { targetId: row.targetId, targetAccountId: row.targetAccountId },
      type: 'session.lost',
      sessionId: row.id,
      generation: row.generation,
      payload: { closeReason: row.closeReason ?? 'owner_instance_replaced' },
    })
  }
}

export async function applyAutoLostDisposition(db: Db, rows: IsolatedLostRow[]): Promise<void> {
  const autoRows: IsolatedLostRow[] = []
  const dispositionByTarget = new Map<string, SessionLostDisposition>()
  for (const row of rows) {
    if (row.closeReason !== 'owner_instance_replaced') continue
    let disposition = dispositionByTarget.get(row.targetId)
    if (!disposition) {
      const policy = await loadResolvedSessionPolicyForTarget(db, row.targetId)
      disposition = policy.lostDisposition
      dispositionByTarget.set(row.targetId, disposition)
    }
    if (disposition === 'AUTO') autoRows.push(row)
  }
  const now = await clockNow(db)
  for (const row of autoRows) {
    await settleAuthWaitThenClose(db, row, now)
  }
}

async function settleAuthWaitThenClose(db: Db, row: IsolatedLostRow, now: Date): Promise<void> {
  const { sessionLeases } = schemaFor(db)
  const waits = await db
    .select()
    .from(sessionLeases)
    .where(
      and(
        eq(sessionLeases.sessionId, row.id),
        eq(sessionLeases.status, 'ACTIVE'),
        eq(sessionLeases.purpose, 'AUTH_WAIT'),
      ),
    )
  for (const lease of waits) {
    await expireAuthWaitHolderLost(db, lease, now, AUTH_WAIT_MAX_RECOVERIES)
  }
  await closeOrphanedLostSession(db, row, now)
}

async function closeOrphanedLostSession(db: Db, row: IsolatedLostRow, now: Date): Promise<void> {
  const { browserSessions, sessionLeases } = schemaFor(db)
  await updateRows(
    db,
    sessionLeases,
    { status: 'REVOKED', releasedAt: now, releaseReason: AUTO_CLOSE_REASON },
    and(
      eq(sessionLeases.sessionId, row.id),
      eq(sessionLeases.status, 'ACTIVE'),
    ),
  )
  const [closed] = await updateRows(
    db,
    browserSessions,
    {
      status: 'CLOSED',
      closedAt: now,
      closeReason: AUTO_CLOSE_REASON,
      authControlActorId: null,
      authControlTokenHash: null,
      authControlExpiresAt: null,
      authControlPageId: null,
      version: sql`${browserSessions.version} + 1`,
      updatedAt: now,
    },
    and(eq(browserSessions.id, row.id), eq(browserSessions.status, 'LOST')),
  )
  if (!closed) return
  await appendSessionEvent(db, {
    key: { targetId: row.targetId, targetAccountId: row.targetAccountId },
    type: 'session.closed',
    sessionId: row.id,
    generation: row.generation,
    payload: { disposition: 'AUTO', closeReason: AUTO_CLOSE_REASON },
  })
}
