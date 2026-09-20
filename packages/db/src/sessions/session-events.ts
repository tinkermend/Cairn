import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { readableSessionTargets } from '../console/target-authorization.js'
import type { SessionEventDto, SessionEventType } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import type { SessionKey } from './sessions.js'

export async function appendSessionEvent(
  db: Db,
  input: {
    key: SessionKey
    type: SessionEventType
    sessionId?: string | null
    generation?: number | null
    operationId?: string | null
    runId?: string | null
    payload?: Record<string, unknown>
  },
): Promise<void> {
  await atomic(db, async (tx) => {
    const { sessionEvents, targetAccounts } = schemaFor(tx)
    await locked(
      tx,
      tx
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(eq(targetAccounts.id, input.key.targetAccountId)),
    )
    const now = await clockNow(tx)
    const [last] = await locked(
      tx,
      tx
        .select({ seq: sessionEvents.seq })
        .from(sessionEvents)
        .where(
          and(
            eq(sessionEvents.targetId, input.key.targetId),
            eq(sessionEvents.targetAccountId, input.key.targetAccountId),
          ),
        )
        .orderBy(desc(sessionEvents.seq))
        .limit(1),
    )
    await insertRows(tx, sessionEvents, {
      id: newId(),
      seq: (last?.seq ?? 0) + 1,
      targetId: input.key.targetId,
      targetAccountId: input.key.targetAccountId,
      sessionId: input.sessionId ?? null,
      generation: input.generation ?? null,
      operationId: input.operationId ?? null,
      runId: input.runId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: now,
    })
  })
}

export async function listSessionEvents(
  db: Db,
  input: { sessionId?: string; key?: SessionKey; cursor?: string; limit?: number },
): Promise<{ items: SessionEventDto[]; nextCursor?: string }> {
  const { sessionEvents } = schemaFor(db)
  const limit = input.limit ?? 50
  const conditions = []
  if (input.sessionId) conditions.push(eq(sessionEvents.sessionId, input.sessionId))
  if (input.key) {
    conditions.push(eq(sessionEvents.targetId, input.key.targetId))
    conditions.push(eq(sessionEvents.targetAccountId, input.key.targetAccountId))
  }
  if (input.cursor) {
    const seq = Number(input.cursor)
    if (Number.isFinite(seq)) conditions.push(sql`${sessionEvents.seq} < ${seq}`)
  }
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sessionEvents.seq))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      targetId: row.targetId,
      targetAccountId: row.targetAccountId,
      sessionId: row.sessionId,
      generation: row.generation,
      operationId: row.operationId,
      runId: row.runId,
      type: row.type as SessionEventType,
      payload: row.payload ?? {},
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]?.seq) : undefined,
  }
}

export async function listSessionEventsAfter(
  db: Db,
  input: { key?: SessionKey; afterSeq?: number; watermarks?: Record<string, number>; limit?: number },
  actorId?: string,
): Promise<SessionEventDto[]> {
  const { sessionEvents } = schemaFor(db)
  const watermarks = input.watermarks ?? {}
  const targetIds = actorId ? await readableSessionTargets(db, actorId) : undefined
  const conditions = [
    input.key
      ? sql`${sessionEvents.seq} > ${input.afterSeq ?? watermarks[input.key.targetAccountId] ?? 0}`
      : and(
          ...Object.entries(watermarks).map(([id, seq]) =>
            or(sql`${sessionEvents.targetAccountId} <> ${id}`, sql`${sessionEvents.seq} > ${seq}`),
          ),
        ),
  ]
  if (input.key) {
    conditions.push(eq(sessionEvents.targetId, input.key.targetId))
    conditions.push(eq(sessionEvents.targetAccountId, input.key.targetAccountId))
  }
  if (targetIds) conditions.push(targetIds.length ? inArray(sessionEvents.targetId, targetIds) : sql`1 = 0`)
  const rows = await db
    .select()
    .from(sessionEvents)
    .where(and(...conditions))
    // SSE cursors advance independently for each target account. Concurrent commits
    // can give a higher sequence an earlier createdAt, so timestamp order could make
    // a reconnecting client advance its watermark past an older event.
    .orderBy(asc(sessionEvents.targetAccountId), asc(sessionEvents.seq), asc(sessionEvents.createdAt))
    .limit(input.limit ?? 100)
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    sessionId: row.sessionId,
    generation: row.generation,
    operationId: row.operationId,
    runId: row.runId,
    type: row.type as SessionEventType,
    payload: row.payload ?? {},
    createdAt: row.createdAt.toISOString(),
  }))
}

export async function countSessionEventWatermark(db: Db, key?: SessionKey): Promise<number> {
  const { sessionEvents } = schemaFor(db)
  const [row] = await db
    .select({ seq: sql<number>`coalesce(max(${sessionEvents.seq}), 0)` })
    .from(sessionEvents)
    .where(
      key
        ? and(
            eq(sessionEvents.targetId, key.targetId),
            eq(sessionEvents.targetAccountId, key.targetAccountId),
          )
        : undefined,
    )
  return Number(row?.seq ?? 0)
}
