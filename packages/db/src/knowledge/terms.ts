import { and, eq } from 'drizzle-orm'
import {
  canonicalJson,
  createTerminologyBodySchema,
  retireTerminologyBodySchema,
  terminologyEntrySchema,
  terminologyListQuerySchema,
  terminologyListResponseSchema,
  terminologyMatchQuerySchema,
  terminologyMatchResponseSchema,
  updateTerminologyBodySchema,
  type CreateTerminologyBody,
  type ExecutionActor,
  type RetireTerminologyBody,
  type TerminologyEntry,
  type TerminologyListQuery,
  type UpdateTerminologyBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { validateKnowledgeSources } from './sources.js'
import { decodeMapCursor, encodeMapCursor, requireLiveTarget } from '../map/view.js'
import { knowledgeIdempotencyConflict, knowledgeNotFound, knowledgeRevisionConflict } from './errors.js'

function iso(value: Date): string {
  return value.toISOString()
}

function toEntry(row: {
  id: string
  targetId: string
  canonicalName: string
  aliases: string[]
  meaning: string
  conditionSnapshot: TerminologyEntry['conditionSnapshot'] | null
  termStatus: TerminologyEntry['termStatus']
  revision: number
  sources: TerminologyEntry['sources']
  createdAt: Date
  updatedAt: Date
}): TerminologyEntry {
  return terminologyEntrySchema.parse({
    termId: row.id,
    targetId: row.targetId,
    canonicalName: row.canonicalName,
    aliases: row.aliases,
    meaning: row.meaning,
    conditionSnapshot: row.conditionSnapshot ?? undefined,
    termStatus: row.termStatus,
    revision: row.revision,
    sources: row.sources,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function assertTermSources(sources: CreateTerminologyBody['sources'] = []) {
  for (const source of sources ?? []) {
    if (source.kind !== 'map_asset' && source.kind !== 'map_observation' && source.kind !== 'map_verification') {
      knowledgeNotFound('术语来源只能引用地图资产或观察/评价')
    }
  }
}

async function writeRevision(
  tx: Db,
  termId: string,
  revision: number,
  actorId: string,
  payload: Record<string, unknown>,
) {
  const { mapTerminologyRevisions } = schemaFor(tx)
  await insertRows(tx, mapTerminologyRevisions, {
    id: newId(),
    termId,
    revision,
    payload,
    actorId,
    createdAt: await clockNow(tx),
  })
}

export async function listTerminology(db: Db, targetId: string, query: TerminologyListQuery) {
  await requireLiveTarget(db, targetId)
  const parsed = terminologyListQuerySchema.parse(query)
  const { mapTerminologyEntries } = schemaFor(db)
  const rows = await db.select().from(mapTerminologyEntries).where(eq(mapTerminologyEntries.targetId, targetId))
  const needle = parsed.q?.trim().toLowerCase()
  const filtered = rows
    .map(toEntry)
    .filter((item) => (parsed.status ? item.termStatus === parsed.status : true))
    .filter((item) => {
      if (!needle) return true
      return [item.canonicalName, ...item.aliases].some((value) => value.toLowerCase().includes(needle))
    })
    .sort((a, b) => { const x = `${a.canonicalName}|${a.termId}`; const y = `${b.canonicalName}|${b.termId}`; return x < y ? -1 : x > y ? 1 : 0 })
  const digest = sha256Hex(canonicalJson({ targetId, q: parsed.q ?? '', status: parsed.status ?? '', revisions: filtered.map(item => [item.termId, item.revision]) }))
  const after = parsed.cursor ? decodeMapCursor(parsed.cursor, digest) : undefined
  const remaining = after
    ? filtered.filter((item) => `${item.canonicalName}|${item.termId}` > after)
    : filtered
  const page = remaining.slice(0, parsed.limit + 1)
  const hasMore = page.length > parsed.limit
  const items = hasMore ? page.slice(0, parsed.limit) : page
  return terminologyListResponseSchema.parse({
    items,
    nextCursor: hasMore ? encodeMapCursor(digest, `${items.at(-1)!.canonicalName}|${items.at(-1)!.termId}`) : undefined,
  })
}

export async function getTerminology(db: Db, targetId: string, termId: string) {
  await requireLiveTarget(db, targetId)
  const { mapTerminologyEntries } = schemaFor(db)
  const [row] = await db
    .select()
    .from(mapTerminologyEntries)
    .where(and(eq(mapTerminologyEntries.id, termId), eq(mapTerminologyEntries.targetId, targetId)))
    .limit(1)
  if (!row) knowledgeNotFound('术语不存在')
  return toEntry(row)
}

export async function matchTerminology(db: Db, targetId: string, query: { alias: string }) {
  await requireLiveTarget(db, targetId)
  const parsed = terminologyMatchQuerySchema.parse(query)
  const { mapTerminologyEntries } = schemaFor(db)
  const rows = await db.select().from(mapTerminologyEntries).where(eq(mapTerminologyEntries.targetId, targetId))
  const alias = parsed.alias.trim().toLowerCase()
  return terminologyMatchResponseSchema.parse({
    items: rows.map(toEntry).filter(item => item.termStatus !== 'retired' && [item.canonicalName, ...item.aliases].some(value => value.toLowerCase() === alias || value.toLowerCase().includes(alias))).sort((a, b) => a.termId < b.termId ? -1 : 1).slice(0, 32),
  })
}

export async function createTerminology(
  db: Db,
  targetId: string,
  body: CreateTerminologyBody,
  actor: ExecutionActor,
) {
  await requireLiveTarget(db, targetId)
  const parsed = createTerminologyBodySchema.parse(body)
  assertTermSources(parsed.sources)
  return atomic(db, async (tx) => {
    const { mapTerminologyEntries, mapTerminologyRevisions, targets } = schemaFor(tx)
    await locked(tx, tx.select().from(targets).where(eq(targets.id, targetId)))
    const [existing] = await tx.select().from(mapTerminologyEntries).where(and(eq(mapTerminologyEntries.targetId, targetId), eq(mapTerminologyEntries.requestKey, parsed.idempotencyKey))).limit(1)
    const { idempotencyKey: _key, ...request } = parsed
    if (existing) {
      const [initial] = await tx.select().from(mapTerminologyRevisions).where(and(eq(mapTerminologyRevisions.termId, existing.id), eq(mapTerminologyRevisions.revision, 1))).limit(1)
      const saved = initial?.payload as { request?: unknown; result?: TerminologyEntry } | undefined
      if (!saved?.request || canonicalJson(saved.request) !== canonicalJson(request) || !saved.result) knowledgeIdempotencyConflict()
      return terminologyEntrySchema.parse(saved.result)
    }
    if (parsed.conditionSnapshot && parsed.conditionSnapshot.targetId !== targetId) knowledgeNotFound()
    await validateKnowledgeSources(tx, targetId, parsed.sources)
    const now = await clockNow(tx)
    const id = newId()
    await insertRows(tx, mapTerminologyEntries, {
      id, targetId, requestKey: parsed.idempotencyKey,
      ...request, conditionSnapshot: parsed.conditionSnapshot ?? null, revision: 1,
      createdByConsoleAccountId: actor.id, updatedByConsoleAccountId: actor.id,
      createdAt: now, updatedAt: now,
    })
    const result = await getTerminology(tx, targetId, id)
    await writeRevision(tx, id, 1, actor.id, { request, result, ...request, revision: 1 })
    await recordAudit(tx, actor, 'knowledge.term', 'map_term', id, `创建术语「${parsed.canonicalName}」`)
    return getTerminology(tx, targetId, id)
  })
}

export async function updateTerminology(
  db: Db,
  targetId: string,
  termId: string,
  body: UpdateTerminologyBody,
  actor: ExecutionActor,
) {
  await requireLiveTarget(db, targetId)
  const parsed = updateTerminologyBodySchema.parse(body)
  if (parsed.sources) assertTermSources(parsed.sources)
  if (parsed.conditionSnapshot && parsed.conditionSnapshot.targetId !== targetId) knowledgeNotFound()
  return atomic(db, async (tx) => {
    const { mapTerminologyEntries } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(mapTerminologyEntries).where(and(eq(mapTerminologyEntries.id, termId), eq(mapTerminologyEntries.targetId, targetId))),
    )
    if (!row) knowledgeNotFound('术语不存在')
    if (row.termStatus === 'retired') knowledgeRevisionConflict('已退役术语不能再更新')
    if (row.revision !== parsed.expectedRevision) knowledgeRevisionConflict()
    await validateKnowledgeSources(tx, targetId, parsed.sources ?? row.sources)
    const now = await clockNow(tx)
    const nextRevision = row.revision + 1
    const next = {
      canonicalName: parsed.canonicalName ?? row.canonicalName,
      aliases: parsed.aliases ?? row.aliases,
      meaning: parsed.meaning ?? row.meaning,
      conditionSnapshot:
        parsed.conditionSnapshot === undefined ? row.conditionSnapshot : parsed.conditionSnapshot,
      sources: parsed.sources ?? row.sources,
      termStatus: parsed.termStatus ?? row.termStatus,
    }
    await tx
      .update(mapTerminologyEntries)
      .set({
        ...next,
        revision: nextRevision,
        updatedByConsoleAccountId: actor.id,
        updatedAt: now,
      })
      .where(eq(mapTerminologyEntries.id, termId))
    await writeRevision(tx, termId, nextRevision, actor.id, { ...next, revision: nextRevision })
    await recordAudit(tx, actor, 'knowledge.term', 'map_term', termId, `更新术语 r${nextRevision}`)
    return getTerminology(tx, targetId, termId)
  })
}

export async function retireTerminology(
  db: Db,
  targetId: string,
  termId: string,
  body: RetireTerminologyBody,
  actor: ExecutionActor,
) {
  await requireLiveTarget(db, targetId)
  const parsed = retireTerminologyBodySchema.parse(body)
  return atomic(db, async (tx) => {
    const { mapTerminologyEntries } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(mapTerminologyEntries).where(and(eq(mapTerminologyEntries.id, termId), eq(mapTerminologyEntries.targetId, targetId))),
    )
    if (!row) knowledgeNotFound('术语不存在')
    if (row.revision !== parsed.expectedRevision) knowledgeRevisionConflict()
    if (row.termStatus === 'retired') return toEntry(row)
    const now = await clockNow(tx)
    const nextRevision = row.revision + 1
    await tx
      .update(mapTerminologyEntries)
      .set({
        termStatus: 'retired',
        revision: nextRevision,
        updatedByConsoleAccountId: actor.id,
        updatedAt: now,
      })
      .where(eq(mapTerminologyEntries.id, termId))
    await writeRevision(tx, termId, nextRevision, actor.id, { ...toEntry(row), termStatus: 'retired', revision: nextRevision, reason: parsed.reason })
    await recordAudit(tx, actor, 'knowledge.term', 'map_term', termId, `退役术语：${parsed.reason}`)
    return getTerminology(tx, targetId, termId)
  })
}

export async function listTerminologyForCompose(db: Db, targetId: string) {
  const result: TerminologyEntry[] = []
  let cursor: string | undefined
  do {
    const listed = await listTerminology(db, targetId, { limit: 100, cursor })
    result.push(...listed.items.filter(item => item.termStatus === 'confirmed'))
    cursor = listed.nextCursor
  } while (cursor)
  return result
}
