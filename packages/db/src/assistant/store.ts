import { and, desc, eq, lt, sql } from 'drizzle-orm'
import {
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantTurnListSchema,
  assistantTurnSchema,
  assistantResultSchema,
  type AssistantConversation,
  type AssistantConversationList,
  type AssistantResult,
  type AssistantTurn,
  type AssistantTurnList,
  type AssistantTurnStatus,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { cursorFilter, encodeCursor, paginateResults } from '../cursor.js'
import { newId } from '../id.js'
import { atomic, schemaFor } from '../native.js'
import {
  DomainError,
  conflict,
  constraintName,
  forbidden,
  isUniqueViolation,
  notFound,
} from '../runs/errors.js'

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toConversation(row: {
  id: string
  title: string
  createdAt: Date | string
  updatedAt: Date | string
}): AssistantConversation {
  return assistantConversationSchema.parse({
    id: row.id,
    title: row.title,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function toTurn(row: {
  id: string
  conversationId: string
  clientTurnId: string
  parentTurnId: string | null
  question: string
  capabilityId: string | null
  status: string
  deadlineAt: Date | string
  result: unknown
  createdAt: Date | string
  updatedAt: Date | string
}): AssistantTurn {
  return assistantTurnSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    clientTurnId: row.clientTurnId,
    parentTurnId: row.parentTurnId,
    question: row.question,
    capabilityId: row.capabilityId,
    status: row.status,
    deadlineAt: iso(row.deadlineAt),
    result: row.result ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

export async function createAssistantConversation(
  db: Db,
  input: { ownerAccountId: string; title: string; idempotencyKey?: string },
): Promise<AssistantConversation> {
  const { assistantConversations } = schemaFor(db)
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.ownerAccountId, input.ownerAccountId),
          eq(assistantConversations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) return toConversation(existing)
  }
  const now = new Date()
  const id = newId()
  try {
    await db.insert(assistantConversations).values({
      id,
      ownerAccountId: input.ownerAccountId,
      title: input.title,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    })
  } catch (error) {
    if (input.idempotencyKey && isUniqueViolation(error)) {
      const [existing] = await db
        .select()
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.ownerAccountId, input.ownerAccountId),
            eq(assistantConversations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
      if (existing) return toConversation(existing)
    }
    throw error
  }
  return toConversation({ id, title: input.title, createdAt: now, updatedAt: now })
}

export async function listAssistantConversations(
  db: Db,
  ownerAccountId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<AssistantConversationList> {
  const { assistantConversations } = schemaFor(db)
  const limit = query.limit ?? 20
  const rows = await db
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.ownerAccountId, ownerAccountId),
        cursorFilter(assistantConversations.lastActiveAt, assistantConversations.id, query.cursor),
      ),
    )
    .orderBy(desc(assistantConversations.lastActiveAt), desc(assistantConversations.id))
    .limit(limit + 1)
  const page = paginateResults(
    rows.map((row) => ({ ...row, createdAt: asDate(row.lastActiveAt) })),
    limit,
  )
  return assistantConversationListSchema.parse({
    items: page.items.map(toConversation),
    nextCursor: page.nextCursor,
  })
}

export async function getAssistantConversation(
  db: Db,
  id: string,
  ownerAccountId: string,
) {
  const { assistantConversations } = schemaFor(db)
  const [row] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerAccountId, ownerAccountId)))
    .limit(1)
  if (!row) throw notFound('ASSISTANT_CONVERSATION_NOT_FOUND', '对话不存在')
  return row
}

export async function interruptExpiredAssistantTurns(db: Db, now = new Date()): Promise<number> {
  const { assistantTurns } = schemaFor(db)
  const updated = await db
    .update(assistantTurns)
    .set({ status: 'INTERRUPTED', updatedAt: now })
    .where(and(eq(assistantTurns.status, 'RUNNING'), lt(assistantTurns.deadlineAt, now)))
  return Array.isArray(updated) ? updated.length : 0
}

export async function beginAssistantTurn(
  db: Db,
  input: {
    conversationId: string
    ownerAccountId: string
    clientTurnId: string
    requestDigest: string
    question: string
    parentTurnId?: string
    deadlineAt: Date
    processingToken: string
    userLimit: number
    platformLimit: number
  },
): Promise<{ turn: AssistantTurn; replay: boolean }> {
  return atomic(db, async (tx) => {
    await interruptExpiredAssistantTurns(tx)
    const { assistantTurns, assistantConversations } = schemaFor(tx)
    const [conversation] = await tx
      .select()
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, input.conversationId),
          eq(assistantConversations.ownerAccountId, input.ownerAccountId),
        ),
      )
      .limit(1)
    if (!conversation) throw notFound('ASSISTANT_CONVERSATION_NOT_FOUND', '对话不存在')

    const [existing] = await tx
      .select()
      .from(assistantTurns)
      .where(
        and(
          eq(assistantTurns.conversationId, input.conversationId),
          eq(assistantTurns.clientTurnId, input.clientTurnId),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) {
        throw conflict('ASSISTANT_TURN_CONFLICT', '同一轮次标识对应了不同的问题')
      }
      return { turn: toTurn(existing), replay: true }
    }

    const [userRunning] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(assistantTurns)
      .where(and(eq(assistantTurns.ownerAccountId, input.ownerAccountId), eq(assistantTurns.status, 'RUNNING')))
    if (Number(userRunning?.n ?? 0) >= input.userLimit) {
      throw conflict('ASSISTANT_INFLIGHT', '你已有一轮助手任务在处理')
    }
    const [platformRunning] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(assistantTurns)
      .where(eq(assistantTurns.status, 'RUNNING'))
    if (Number(platformRunning?.n ?? 0) >= input.platformLimit) {
      throw new DomainError('rate_limited', 'ASSISTANT_CAPACITY', '平台助手繁忙，请稍后重试')
    }

    if (input.parentTurnId) {
      const [parent] = await tx
        .select()
        .from(assistantTurns)
        .where(
          and(eq(assistantTurns.id, input.parentTurnId), eq(assistantTurns.ownerAccountId, input.ownerAccountId)),
        )
        .limit(1)
      if (!parent || parent.conversationId !== input.conversationId) {
        throw forbidden('ASSISTANT_PARENT_FORBIDDEN', '不能引用其他对话的轮次')
      }
    }

    const now = new Date()
    const id = newId()
    try {
      await tx.insert(assistantTurns).values({
        id,
        conversationId: input.conversationId,
        ownerAccountId: input.ownerAccountId,
        clientTurnId: input.clientTurnId,
        parentTurnId: input.parentTurnId,
        requestDigest: input.requestDigest,
        question: input.question,
        status: 'RUNNING',
        deadlineAt: input.deadlineAt,
        processingToken: input.processingToken,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const name = constraintName(error) ?? ''
      if (name.includes('assistant_turns_owner_running')) {
        throw conflict('ASSISTANT_INFLIGHT', '你已有一轮助手任务在处理')
      }
      const [replay] = await tx
        .select()
        .from(assistantTurns)
        .where(
          and(
            eq(assistantTurns.conversationId, input.conversationId),
            eq(assistantTurns.clientTurnId, input.clientTurnId),
          ),
        )
        .limit(1)
      if (replay && replay.requestDigest === input.requestDigest) {
        return { turn: toTurn(replay), replay: true }
      }
      if (replay) throw conflict('ASSISTANT_TURN_CONFLICT', '同一轮次标识对应了不同的问题')
      throw error
    }
    await tx
      .update(assistantConversations)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(eq(assistantConversations.id, input.conversationId))
    const [row] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, id)).limit(1)
    return { turn: toTurn(row!), replay: false }
  })
}

export type AssistantTurnRecord = {
  turn: AssistantTurn
  slots: Record<string, unknown> | null
}

function toRecord(row: Parameters<typeof toTurn>[0] & { slots?: unknown }): AssistantTurnRecord {
  return {
    turn: toTurn(row),
    slots: row.slots && typeof row.slots === 'object' ? (row.slots as Record<string, unknown>) : null,
  }
}

export async function completeAssistantTurn(
  db: Db,
  input: {
    turnId: string
    ownerAccountId: string
    processingToken: string
    status: Exclude<AssistantTurnStatus, 'RUNNING'>
    capabilityId?: string | null
    slots?: Record<string, unknown> | null
    result?: AssistantResult | null
  },
): Promise<AssistantTurn> {
  return atomic(db, async (tx) => {
    const { assistantTurns } = schemaFor(tx)
    const [current] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, input.turnId)).limit(1)
    if (!current || current.ownerAccountId !== input.ownerAccountId) {
      throw notFound('ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }
    if (current.status !== 'RUNNING') return toTurn(current)
    if (current.processingToken !== input.processingToken) {
      throw conflict('ASSISTANT_TOKEN_MISMATCH', '处理令牌已失效')
    }
    const now = new Date()
    await tx
      .update(assistantTurns)
      .set({
        status: input.status,
        capabilityId: input.capabilityId ?? current.capabilityId,
        slots: input.slots ?? current.slots,
        result: input.result ? assistantResultSchema.parse(input.result) : current.result,
        updatedAt: now,
      })
      .where(and(eq(assistantTurns.id, input.turnId), eq(assistantTurns.status, 'RUNNING')))
    const [row] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, input.turnId)).limit(1)
    return toTurn(row!)
  })
}

export async function getAssistantTurn(db: Db, turnId: string, ownerAccountId: string): Promise<AssistantTurn> {
  return (await getAssistantTurnRecord(db, turnId, ownerAccountId)).turn
}

export async function getAssistantTurnRecord(
  db: Db,
  turnId: string,
  ownerAccountId: string,
): Promise<AssistantTurnRecord> {
  const { assistantTurns } = schemaFor(db)
  const [row] = await db.select().from(assistantTurns).where(eq(assistantTurns.id, turnId)).limit(1)
  if (!row || row.ownerAccountId !== ownerAccountId) throw notFound('ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
  return toRecord(row)
}

export async function listAssistantTurns(
  db: Db,
  conversationId: string,
  ownerAccountId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<AssistantTurnList> {
  await getAssistantConversation(db, conversationId, ownerAccountId)
  const { assistantTurns } = schemaFor(db)
  const limit = query.limit ?? 50
  const rows = await db
    .select()
    .from(assistantTurns)
    .where(
      and(
        eq(assistantTurns.conversationId, conversationId),
        eq(assistantTurns.ownerAccountId, ownerAccountId),
        cursorFilter(assistantTurns.createdAt, assistantTurns.id, query.cursor),
      ),
    )
    .orderBy(desc(assistantTurns.createdAt), desc(assistantTurns.id))
    .limit(limit + 1)
  const page = paginateResults(
    rows.map((row) => ({ ...row, createdAt: asDate(row.createdAt) })),
    limit,
  )
  return assistantTurnListSchema.parse({
    items: page.items.map(toTurn),
    nextCursor: page.nextCursor,
  })
}

export async function listAssistantTurnRecords(
  db: Db,
  conversationId: string,
  ownerAccountId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<{ items: AssistantTurnRecord[]; nextCursor?: string }> {
  const list = await listAssistantTurns(db, conversationId, ownerAccountId, query)
  const { assistantTurns } = schemaFor(db)
  const rows = list.items.length
    ? await db
        .select()
        .from(assistantTurns)
        .where(
          and(
            eq(assistantTurns.conversationId, conversationId),
            eq(assistantTurns.ownerAccountId, ownerAccountId),
          ),
        )
    : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  return {
    items: list.items.map((turn) => {
      const row = byId.get(turn.id)
      return row ? toRecord(row) : { turn, slots: null }
    }),
    nextCursor: list.nextCursor,
  }
}

export async function recordPlatformAiCall(
  db: Db,
  input: {
    turnId: string
    seq: number
    purpose: string
    configRevision?: number
    model?: string
    promptVersion?: string
    reservedTokens?: number
    usage?: Record<string, unknown> | null
    error?: string | null
    durationMs?: number
  },
) {
  const { platformAiCalls } = schemaFor(db)
  await db.insert(platformAiCalls).values({
    id: newId(),
    turnId: input.turnId,
    seq: input.seq,
    purpose: input.purpose,
    configRevision: input.configRevision,
    model: input.model,
    promptVersion: input.promptVersion,
    reservedTokens: input.reservedTokens,
    usage: input.usage ?? null,
    error: input.error ?? null,
    durationMs: input.durationMs,
    createdAt: new Date(),
  })
}

export async function purgeExpiredAssistantBodies(db: Db, now = new Date()) {
  const turnCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const callCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const { assistantTurns, assistantConversations, platformAiCalls } = schemaFor(db)
  await db.delete(platformAiCalls).where(lt(platformAiCalls.createdAt, callCutoff))
  await db
    .update(assistantTurns)
    .set({ question: '（已按保留期清理）', result: null, slots: null, updatedAt: now })
    .where(and(lt(assistantTurns.createdAt, turnCutoff), sql`${assistantTurns.status} <> 'RUNNING'`))
  const stale = await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(lt(assistantConversations.lastActiveAt, turnCutoff))
  for (const row of stale) {
    const [active] = await db
      .select({ id: assistantTurns.id })
      .from(assistantTurns)
      .where(eq(assistantTurns.conversationId, row.id))
      .limit(1)
    if (!active) {
      await db.delete(assistantConversations).where(eq(assistantConversations.id, row.id))
    }
  }
}
