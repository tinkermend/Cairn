import crypto from 'node:crypto'
import { and, asc, desc, eq, gt, isNotNull, lt, or, sql } from 'drizzle-orm'
import {
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantTurnListSchema,
  assistantTurnSchema,
  assistantResultSchema,
  packAssistantResultEnvelope,
  unpackAssistantResultEnvelope,
  unpackAssistantResultEnvelopeDetailed,
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
import { atomic, locked, schemaFor, updateRowsCount } from '../native.js'
import {
  DomainError,
  conflict,
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
  stage?: string | null
  eventSeq?: number | null
  queuePosition?: number | null
  stopReason?: string | null
  createdAt: Date | string
  updatedAt: Date | string
}): AssistantTurn {
  const env = row.result ? unpackAssistantResultEnvelopeDetailed(row.result) : null
  return assistantTurnSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    clientTurnId: row.clientTurnId,
    parentTurnId: row.parentTurnId,
    question: row.question,
    capabilityId: row.capabilityId,
    status: row.status,
    deadlineAt: iso(row.deadlineAt),
    result: env ? env.result : (row.result ? unpackAssistantResultEnvelope(row.result) : null),
    stage: (row.stage as any) ?? undefined,
    eventSeq: row.eventSeq ?? undefined,
    queuePosition: row.queuePosition ?? undefined,
    stopReason: row.stopReason ?? undefined,
    thinkingText: env?.thinkingText ?? undefined,
    thinkingDurationMs: env?.thinkingDurationMs ?? undefined,
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

export async function deleteAssistantConversation(
  db: Db,
  id: string,
  ownerAccountId: string,
): Promise<{ id: string; deleted: true }> {
  return atomic(db, async (tx) => {
    const { assistantConversations, assistantTurns, assistantTurnEvents } = schemaFor(tx)
    const [row] = await tx
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerAccountId, ownerAccountId)))
      .limit(1)
    if (!row) throw notFound('ASSISTANT_CONVERSATION_NOT_FOUND', '对话不存在')

    const turns = await tx
      .select({ id: assistantTurns.id })
      .from(assistantTurns)
      .where(eq(assistantTurns.conversationId, id))
    for (const t of turns) {
      await tx.delete(assistantTurnEvents).where(eq(assistantTurnEvents.turnId, t.id))
    }
    await tx.delete(assistantTurns).where(eq(assistantTurns.conversationId, id))
    await tx.delete(assistantConversations).where(eq(assistantConversations.id, id))

    return { id, deleted: true as const }
  })
}

export async function interruptExpiredAssistantTurns(db: Db, now = new Date()): Promise<number> {
  const { assistantTurns } = schemaFor(db)
  const gracePeriodMs = 5000
  const leaseExpiredCutoff = new Date(now.getTime() - gracePeriodMs)
  const updated = await db
    .update(assistantTurns)
    .set({ status: 'INTERRUPTED', stopReason: 'guardrail_wall_clock', updatedAt: now })
    .where(
      and(
        eq(assistantTurns.status, 'RUNNING'),
        or(
          lt(assistantTurns.deadlineAt, now),
          and(isNotNull(assistantTurns.leaseUntil), lt(assistantTurns.leaseUntil, leaseExpiredCutoff)),
        ),
      ),
    )
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
    allowQueue?: boolean
    ownerInstanceId?: string
    leaseUntil?: Date
    requestPayload?: Record<string, unknown> | null
  },
): Promise<{ turn: AssistantTurn; replay: boolean; epoch: number }> {
  return atomic(db, async (tx) => {
    // Serialize submissions from the same account before reading the in-flight
    // count. A unique-index error inside a PostgreSQL transaction aborts that
    // transaction, so the old catch-and-insert-QUEUED fallback could return 500.
    const { consoleAccounts } = schemaFor(tx)
    await locked(tx, tx.select({ id: consoleAccounts.id }).from(consoleAccounts)
      .where(eq(consoleAccounts.id, input.ownerAccountId)))
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
      return { turn: toTurn(existing), replay: true, epoch: existing.epoch }
    }

    const [userRunning] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(assistantTurns)
      .where(and(eq(assistantTurns.ownerAccountId, input.ownerAccountId), eq(assistantTurns.status, 'RUNNING')))

    const [platformRunning] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(assistantTurns)
      .where(eq(assistantTurns.status, 'RUNNING'))

    const userLimitReached = Number(userRunning?.n ?? 0) >= input.userLimit
    const platformLimitReached = Number(platformRunning?.n ?? 0) >= input.platformLimit

    if (!input.allowQueue) {
      if (userLimitReached) {
        throw conflict('ASSISTANT_INFLIGHT', '你已有一轮助手任务在处理')
      }
      if (platformLimitReached) {
        throw new DomainError('rate_limited', 'ASSISTANT_CAPACITY', '平台助手繁忙，请稍后重试')
      }
    }

    const shouldQueue = Boolean(input.allowQueue && (userLimitReached || platformLimitReached))

    let queuePosition: number | null = null
    let status: 'QUEUED' | 'RUNNING' = 'RUNNING'
    let stage: 'queued' | 'accepted' = 'accepted'

    if (shouldQueue) {
      status = 'QUEUED'
      stage = 'queued'
      const [queuedCount] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(assistantTurns)
        .where(eq(assistantTurns.status, 'QUEUED'))
      queuePosition = Number(queuedCount?.n ?? 0) + 1
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
    await tx.insert(assistantTurns).values({
      id,
      conversationId: input.conversationId,
      ownerAccountId: input.ownerAccountId,
      clientTurnId: input.clientTurnId,
      parentTurnId: input.parentTurnId,
      requestDigest: input.requestDigest,
      question: input.question,
      requestPayload: input.requestPayload ?? null,
      status,
      stage,
      eventSeq: 0,
      queuePosition,
      deadlineAt: input.deadlineAt,
      processingToken: input.processingToken,
      ownerInstanceId: status === 'RUNNING' ? (input.ownerInstanceId ?? null) : null,
      leaseUntil: status === 'RUNNING' ? (input.leaseUntil ?? null) : null,
      epoch: status === 'RUNNING' ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    await tx
      .update(assistantConversations)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(eq(assistantConversations.id, input.conversationId))
    const [row] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, id)).limit(1)
    return { turn: toTurn(row!), replay: false, epoch: row!.epoch }
  })
}

export type AssistantTurnRecord = {
  turn: AssistantTurn
  slots: Record<string, unknown> | null
  epoch: number
}

function toRecord(row: Parameters<typeof toTurn>[0] & { slots?: unknown; epoch: number }): AssistantTurnRecord {
  return {
    turn: toTurn(row),
    slots: row.slots && typeof row.slots === 'object' ? (row.slots as Record<string, unknown>) : null,
    epoch: row.epoch,
  }
}

export async function completeAssistantTurn(
  db: Db,
  input: {
    turnId: string
    ownerAccountId: string
    processingToken: string
    status: Exclude<AssistantTurnStatus, 'RUNNING' | 'QUEUED'>
    capabilityId?: string | null
    slots?: Record<string, unknown> | null
    result?: AssistantResult | null
    stopReason?: string | null
    thinkingText?: string | null
    thinkingDurationMs?: number | null
  },
): Promise<AssistantTurn> {
  return atomic(db, async (tx) => {
    const { assistantTurns } = schemaFor(tx)
    const [current] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, input.turnId)).limit(1)
    if (!current || current.ownerAccountId !== input.ownerAccountId) {
      throw notFound('ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }
    if (current.status !== 'RUNNING' && current.status !== 'QUEUED') return toTurn(current)
    if (current.processingToken !== input.processingToken) {
      throw conflict('ASSISTANT_TOKEN_MISMATCH', '处理令牌已失效')
    }
    let finalResult = current.result
    if (input.result !== undefined && input.result !== null) {
      const validated = assistantResultSchema.parse(input.result)
      finalResult = packAssistantResultEnvelope(
        validated,
        2,
        undefined,
        input.thinkingText ?? undefined,
        input.thinkingDurationMs != null ? input.thinkingDurationMs : undefined,
      )
    }
    const now = new Date()
    await tx
      .update(assistantTurns)
      .set({
        status: input.status,
        capabilityId: input.capabilityId ?? current.capabilityId,
        slots: input.slots ?? current.slots,
        result: finalResult,
        stopReason: input.stopReason ?? current.stopReason ?? (input.status === 'COMPLETED' ? 'completed' : null),
        updatedAt: now,
      })
      .where(eq(assistantTurns.id, input.turnId))
    const [row] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, input.turnId)).limit(1)
    return toTurn(row!)
  })
}

export async function cancelAssistantTurn(
  db: Db,
  input: {
    turnId: string
    ownerAccountId: string
    stopReason?: string
  },
): Promise<AssistantTurn> {
  return atomic(db, async (tx) => {
    const { assistantTurns } = schemaFor(tx)
    const [current] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, input.turnId)).limit(1)
    if (!current || current.ownerAccountId !== input.ownerAccountId) {
      throw notFound('ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }
    if (current.status === 'COMPLETED' || current.status === 'FAILED' || current.status === 'CANCELLED') {
      return toTurn(current)
    }
    const now = new Date()
    await tx
      .update(assistantTurns)
      .set({
        status: 'CANCELLED',
        stopReason: input.stopReason ?? 'cancelled',
        updatedAt: now,
      })
      .where(eq(assistantTurns.id, input.turnId))
    const [row] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, input.turnId)).limit(1)
    return toTurn(row!)
  })
}

export async function updateAssistantTurnStage(
  db: Db,
  input: {
    turnId: string
    stage: string
    eventSeq: number
  },
) {
  const { assistantTurns } = schemaFor(db)
  await db
    .update(assistantTurns)
    .set({
      stage: input.stage,
      eventSeq: input.eventSeq,
      updatedAt: new Date(),
    })
    .where(eq(assistantTurns.id, input.turnId))
}

export async function recordAssistantTurnEvent(
  db: Db,
  input: {
    turnId: string
    seq: number
    channel: string
    payload: Record<string, unknown>
    retainUntil?: Date | string | null
  },
) {
  const { assistantTurnEvents, assistantTurns } = schemaFor(db)
  return atomic(db, async (tx) => {
    await tx.insert(assistantTurnEvents).values({
      id: newId(),
      turnId: input.turnId,
      seq: input.seq,
      channel: input.channel,
      payload: input.payload,
      retainUntil: input.retainUntil ? asDate(input.retainUntil) : null,
      createdAt: new Date(),
    })
    await tx
      .update(assistantTurns)
      .set({
        eventSeq: input.seq,
        stage: input.channel === 'stage' && typeof input.payload.stage === 'string' ? input.payload.stage : undefined,
        updatedAt: new Date(),
      })
      .where(eq(assistantTurns.id, input.turnId))
  })
}

export async function listAssistantTurnEvents(
  db: Db,
  turnId: string,
  after = 0,
): Promise<Array<{ seq: number; channel: string; payload: Record<string, unknown>; createdAt: string }>> {
  const { assistantTurnEvents } = schemaFor(db)
  const rows = await db
    .select()
    .from(assistantTurnEvents)
    .where(and(eq(assistantTurnEvents.turnId, turnId), gt(assistantTurnEvents.seq, after)))
    .orderBy(asc(assistantTurnEvents.seq))
    .limit(100)
  return rows.map((r) => ({
    seq: r.seq,
    channel: r.channel,
    payload: r.payload as Record<string, unknown>,
    createdAt: iso(r.createdAt),
  }))
}

export interface PromotedAssistantTurn {
  turn: AssistantTurn
  processingToken: string
  ownerAccountId: string
  epoch: number
  requestPayload: Record<string, unknown> | null
}

export async function nextQueuedAssistantTurn(
  db: Db,
  limits: { userLimit: number; platformLimit: number },
  timeoutMs = 60_000,
  options?: { ownerInstanceId?: string; leaseDurationMs?: number },
): Promise<PromotedAssistantTurn | null> {
  return atomic(db, async (tx) => {
    const { assistantTurns } = schemaFor(tx)
    const [platformRunning] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(assistantTurns)
      .where(eq(assistantTurns.status, 'RUNNING'))
    if (Number(platformRunning?.n ?? 0) >= limits.platformLimit) return null

    const queuedRows = await tx
      .select()
      .from(assistantTurns)
      .where(eq(assistantTurns.status, 'QUEUED'))
      .orderBy(asc(assistantTurns.createdAt))
      .limit(10)

    for (const candidate of queuedRows) {
      const [userRunning] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(assistantTurns)
        .where(and(eq(assistantTurns.ownerAccountId, candidate.ownerAccountId), eq(assistantTurns.status, 'RUNNING')))
      if (Number(userRunning?.n ?? 0) < limits.userLimit) {
        const now = new Date()
        const deadlineAt = new Date(now.getTime() + timeoutMs)
        const newProcessingToken = crypto.randomUUID()
        const leaseUntil = new Date(now.getTime() + (options?.leaseDurationMs ?? 15_000))
        await tx
          .update(assistantTurns)
          .set({
            status: 'RUNNING',
            stage: 'accepted',
            queuePosition: null,
            deadlineAt,
            processingToken: newProcessingToken,
            ownerInstanceId: options?.ownerInstanceId ?? null,
            leaseUntil,
            epoch: sql`${assistantTurns.epoch} + 1`,
            updatedAt: now,
          })
          .where(and(eq(assistantTurns.id, candidate.id), eq(assistantTurns.status, 'QUEUED')))
        const [promoted] = await tx.select().from(assistantTurns).where(eq(assistantTurns.id, candidate.id)).limit(1)
        return promoted
          ? {
              turn: toTurn(promoted),
              processingToken: promoted.processingToken,
              ownerAccountId: promoted.ownerAccountId,
              epoch: promoted.epoch,
              requestPayload: (promoted.requestPayload as Record<string, unknown>) ?? null,
            }
          : null
      }
    }
    return null
  })
}

export async function renewAssistantTurnLease(
  db: Db,
  input: {
    turnId: string
    ownerInstanceId: string
    epoch: number
    leaseDurationMs?: number
  },
): Promise<boolean> {
  const { assistantTurns } = schemaFor(db)
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + (input.leaseDurationMs ?? 15_000))
  const count = await updateRowsCount(
    db,
    assistantTurns,
    {
      leaseUntil,
      updatedAt: now,
    },
    and(
      eq(assistantTurns.id, input.turnId),
      eq(assistantTurns.ownerInstanceId, input.ownerInstanceId),
      eq(assistantTurns.epoch, input.epoch),
      eq(assistantTurns.status, 'RUNNING'),
    ),
  )
  return count > 0
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
      return row ? toRecord(row) : { turn, slots: null, epoch: 0 }
    }),
    nextCursor: list.nextCursor,
  }
}

export async function recordPlatformAiCall(
  db: Db,
  input: {
    turnId: string
    ownerAccountId?: string | null
    seq: number
    purpose: string
    configRevision?: number
    model?: string
    promptVersion?: string
    reservedTokens?: number
    usage?: Record<string, unknown> | null
    error?: string | null
    durationMs?: number
    capabilityVersion?: string | null
    contextManifestId?: string | null
    requestedModel?: string | null
    route?: string | null
    cost?: Record<string, unknown> | null
    errorClass?: string | null
    validation?: Record<string, unknown> | null
  },
) {
  const { platformAiCalls } = schemaFor(db)
  await db.insert(platformAiCalls).values({
    id: newId(),
    turnId: input.turnId,
    ownerAccountId: input.ownerAccountId ?? null,
    seq: input.seq,
    purpose: input.purpose,
    configRevision: input.configRevision,
    model: input.model,
    promptVersion: input.promptVersion,
    reservedTokens: input.reservedTokens,
    usage: input.usage ?? null,
    error: input.error ?? null,
    durationMs: input.durationMs,
    capabilityVersion: input.capabilityVersion ?? null,
    contextManifestId: input.contextManifestId ?? null,
    requestedModel: input.requestedModel ?? null,
    route: input.route ?? null,
    cost: input.cost ?? null,
    errorClass: input.errorClass ?? null,
    validation: input.validation ?? null,
    createdAt: new Date(),
  })
}

export async function listPlatformAiCalls(
  db: Db,
  filter?: { turnId?: string; ownerAccountId?: string; limit?: number },
) {
  const { platformAiCalls } = schemaFor(db)
  const conditions = []
  if (filter?.turnId) conditions.push(eq(platformAiCalls.turnId, filter.turnId))
  if (filter?.ownerAccountId) conditions.push(eq(platformAiCalls.ownerAccountId, filter.ownerAccountId))
  const where = conditions.length ? and(...conditions) : undefined
  const rows = await db
    .select()
    .from(platformAiCalls)
    .where(where)
    .orderBy(desc(platformAiCalls.createdAt))
    .limit(filter?.limit ?? 50)

  return rows.map((r) => ({
    id: r.id,
    turnId: r.turnId,
    seq: r.seq,
    purpose: r.purpose,
    configRevision: r.configRevision,
    model: r.model,
    promptVersion: r.promptVersion,
    reservedTokens: r.reservedTokens,
    usage: r.usage,
    error: r.error,
    durationMs: r.durationMs,
    capabilityVersion: r.capabilityVersion,
    contextManifestId: r.contextManifestId,
    requestedModel: r.requestedModel,
    route: r.route,
    cost: r.cost,
    errorClass: r.errorClass,
    validation: r.validation,
    createdAt: iso(r.createdAt),
  }))
}

export async function purgeExpiredAssistantBodies(db: Db, now = new Date()) {
  const turnCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const callCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const { assistantTurns, assistantConversations, platformAiCalls, assistantTurnEvents } = schemaFor(db)
  await db.delete(assistantTurnEvents).where(lt(assistantTurnEvents.retainUntil, now))
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
