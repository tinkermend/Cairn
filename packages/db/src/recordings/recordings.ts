import { locked, schemaFor } from '../native.js'
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import {
  closeOpenBindings,
  createdAtBounds,
  resourceDeletedConflict,
  snapshotDeletedBy,
  toDeleteResult,
} from '../lifecycle.js'
import {
  RecordingNormalizationError,
  assertRecordingPayloadSize,
  canonicalJson,
  normalizeRecording,
  recordingDraftDetailSchema,
  recordingDraftListQuerySchema,
  recordingDraftListResponseSchema,
  recordingDraftSchema,
  type CreateRecordingBody,
  type DeleteResourceResult,
  type RecordingDraftDetailDto,
  type RecordingDraftListQuery,
  type RecordingDraftListResponse,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, forbidden, mapRestriction, notFound } from '../runs/errors.js'
import { newId } from '../id.js'
import { consoleAccounts } from '../schema/console.js'
import { recordingDrafts } from '../schema/authoring.js'
import { targets } from '../schema/targets.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import { continueRecordingMapIngest, ensureRecordingMapIngestTx } from './map-ingest.js'

function iso(value: Date): string {
  return value.toISOString()
}

function recordingDigest(input: CreateRecordingBody, events: CreateRecordingBody['events']): string {
  return sha256Hex(
    canonicalJson({
      targetId: input.targetId,
      recordingId: input.recordingId,
      sourceVersion: input.sourceVersion,
      events,
    }),
  )
}

function defaultName(events: CreateRecordingBody['events']): string {
  const firstUrl = events.find((event) => typeof event.url === 'string' && event.url && event.url !== 'about:blank')
    ?.url
  if (firstUrl) {
    try {
      return `录制 ${new URL(firstUrl).host}`
    } catch {
      return '未命名录制'
    }
  }
  return '未命名录制'
}

export async function createRecordingDraft(
  db: Db,
  input: CreateRecordingBody,
  actor: AuditActor,
): Promise<{ created: boolean; detail: RecordingDraftDetailDto }> {
  const { recordingDrafts, targets } = schemaFor(db)
  assertRecordingPayloadSize(input)
  let normalized
  try {
    normalized = normalizeRecording(input.events, { sourceVersion: input.sourceVersion })
  } catch (error) {
    if (error instanceof RecordingNormalizationError) {
      throw badRequest(error.code, error.message)
    }
    throw error
  }

  const [target] = await db.select().from(targets).where(eq(targets.id, input.targetId)).limit(1)
  if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能上传录制')

  if (input.bindingId) {
    await assertBindingAcceptsUpload(db, input.bindingId, actor.id, input.targetId)
  }

  const digest = recordingDigest(input, normalized.events)
  const existing = await findIdempotent(db, actor.id, input.idempotencyKey)
  if (existing) {
    if (existing.deletedAt) resourceDeletedConflict()
    if (existing.payloadDigest !== digest) {
      throw conflict('RECORDING_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的录制内容')
    }
    if (input.bindingId) {
      await attachBindingDraft(db, input.bindingId, actor.id, existing.id)
    }
    if (input.mapIngest) {
      await continueRecordingMapIngest(db, { recordingDraftId: existing.id })
    }
    return { created: false, detail: await toDetail(db, existing.id, actor.id) }
  }

  const id = newId()
  const now = new Date()
  const name = input.name?.trim() || defaultName(input.events)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(recordingDrafts).values({
        id,
        targetId: input.targetId,
        createdByConsoleAccountId: actor.id,
        recordingId: input.recordingId,
        sourceVersion: input.sourceVersion,
        idempotencyKey: input.idempotencyKey,
        payloadDigest: digest,
        name,
        eventCount: normalized.eventCount,
        itemCount: normalized.items.length,
        unresolvedCount: normalized.unresolvedCount,
        events: normalized.events,
        items: normalized.items,
        diagnostics: normalized.diagnostics,
        createdAt: now,
        updatedAt: now,
      })
      await recordAudit(
        tx as unknown as Db,
        actor,
        'recording.create',
        'recording',
        id,
        `上传录制草稿「${name}」`,
      )
      if (input.bindingId) {
        await attachBindingDraft(tx as unknown as Db, input.bindingId, actor.id, id)
      }
      if (input.mapIngest) {
        await ensureRecordingMapIngestTx(tx as unknown as Db, id, now)
      }
    })
  } catch (error) {
    const mapped = mapRestriction(error)
    if (mapped?.code === 'RECORDING_IDEMPOTENCY_CONFLICT') {
      const raced = await findIdempotent(db, actor.id, input.idempotencyKey)
      if (raced) {
        if (raced.deletedAt) resourceDeletedConflict()
        if (raced.payloadDigest === digest) {
          if (input.mapIngest) {
            await continueRecordingMapIngest(db, { recordingDraftId: raced.id })
          }
          return { created: false, detail: await toDetail(db, raced.id, actor.id) }
        }
      }
    }
    if (mapped) throw mapped
    throw error
  }

  if (input.mapIngest) {
    await continueRecordingMapIngest(db, { recordingDraftId: id })
  }
  return { created: true, detail: await toDetail(db, id, actor.id) }
}

export async function getRecordingDraft(
  db: Db,
  id: string,
  actorId?: string,
): Promise<RecordingDraftDetailDto> {
  return toDetail(db, id, actorId)
}

export async function listRecordingDrafts(
  db: Db,
  actorId: string,
  query: RecordingDraftListQuery = {},
): Promise<RecordingDraftListResponse> {
  const parsed = recordingDraftListQuerySchema.parse(query)
  const { consoleAccounts, recordingDrafts, targets } = schemaFor(db)
  const limit = parsed.limit
  const filters: (SQL | undefined)[] = [
    eq(recordingDrafts.createdByConsoleAccountId, actorId),
    isNull(recordingDrafts.deletedAt),
    parsed.targetId ? eq(recordingDrafts.targetId, parsed.targetId) : undefined,
    parsed.search
      ? sql`lower(${recordingDrafts.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`
      : undefined,
    parsed.hasPending === true
      ? sql`${recordingDrafts.unresolvedCount} > 0`
      : parsed.hasPending === false
        ? sql`${recordingDrafts.unresolvedCount} = 0`
        : undefined,
    parsed.imported === true
      ? sql`exists (select 1 from recording_import_receipts r where r.recording_draft_id = ${recordingDrafts.id})`
      : parsed.imported === false
        ? sql`not exists (select 1 from recording_import_receipts r where r.recording_draft_id = ${recordingDrafts.id})`
        : undefined,
    ...createdAtBounds(recordingDrafts.createdAt, parsed.from, parsed.to),
    cursorFilter(recordingDrafts.createdAt, recordingDrafts.id, parsed.cursor),
  ]
  const rows = await db
    .select({
      draft: recordingDrafts,
      targetName: targets.name,
      actorName: consoleAccounts.displayName,
    })
    .from(recordingDrafts)
    .innerJoin(targets, eq(recordingDrafts.targetId, targets.id))
    .innerJoin(consoleAccounts, eq(recordingDrafts.createdByConsoleAccountId, consoleAccounts.id))
    .where(and(...filters.filter((f): f is SQL => f !== undefined)))
    .orderBy(desc(recordingDrafts.createdAt), desc(recordingDrafts.id))
    .limit(limit + 1)

  const paginated = paginateResults(
    rows.map((r) => ({
      ...r,
      id: r.draft.id,
      createdAt: r.draft.createdAt,
    })),
    limit,
  )
  const importedByDraft = await importedScenarioIds(
    db,
    paginated.items.map((row) => row.draft.id),
  )

  return recordingDraftListResponseSchema.parse({
    items: paginated.items.map((row) =>
      recordingDraftSchema.parse({
        id: row.draft.id,
        targetId: row.draft.targetId,
        targetName: row.targetName,
        name: row.draft.name,
        recordingId: row.draft.recordingId,
        sourceVersion: row.draft.sourceVersion,
        sourceProtocol: row.draft.sourceProtocol,
        eventCount: row.draft.eventCount,
        itemCount: row.draft.itemCount,
        unresolvedCount: row.draft.unresolvedCount,
        createdBy: { id: row.draft.createdByConsoleAccountId, displayName: row.actorName },
        imported: importedByDraft.has(row.draft.id),
        importedScenarioId: importedByDraft.get(row.draft.id),
        createdAt: iso(row.draft.createdAt),
        updatedAt: iso(row.draft.updatedAt),
      }),
    ),
    nextCursor: paginated.nextCursor,
    hasMore: paginated.hasMore,
  })
}

export async function renameRecordingDraft(
  db: Db,
  id: string,
  name: string,
  actor: AuditActor,
): Promise<RecordingDraftDetailDto> {
  const { recordingDrafts } = schemaFor(db)
  const trimmed = name.trim()
  if (!trimmed) throw badRequest('INVALID_NAME', '录制名称不能为空')
  const now = new Date()
  await db.transaction(async (tx) => {
    const [current] = await locked(
      tx,
      tx
        .select()
        .from(recordingDrafts)
        .where(and(eq(recordingDrafts.id, id), isNull(recordingDrafts.deletedAt))),
    )
    if (!current) throw notFound('RECORDING_NOT_FOUND', '录制草稿不存在')
    if (current.createdByConsoleAccountId !== actor.id) {
      throw forbidden('RECORDING_FORBIDDEN', '无权修改其他用户的录制草稿')
    }
    await tx
      .update(recordingDrafts)
      .set({ name: trimmed, updatedAt: now })
      .where(eq(recordingDrafts.id, id))
    await recordAudit(
      tx as unknown as Db,
      actor,
      'recording.update',
      'recording',
      id,
      `改名为 ${trimmed}`,
    )
  })
  return toDetail(db, id, actor.id)
}

export async function deleteRecordingDraft(
  db: Db,
  id: string,
  actor: AuditActor,
): Promise<DeleteResourceResult> {
  const { recordingDrafts } = schemaFor(db)
  return db.transaction(async (tx) => {
    const [current] = await locked(
      tx,
      tx.select().from(recordingDrafts).where(eq(recordingDrafts.id, id)),
    )
    if (!current) throw notFound('RECORDING_NOT_FOUND', '录制草稿不存在')
    if (current.createdByConsoleAccountId !== actor.id) {
      throw forbidden('RECORDING_FORBIDDEN', '无权删除其他用户的录制草稿')
    }
    if (current.deletedAt && current.deletedBy) {
      return toDeleteResult({
        id,
        deletedAt: current.deletedAt,
        deletedBy: current.deletedBy,
      })
    }
    const now = new Date()
    const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)
    await tx
      .update(recordingDrafts)
      .set({ deletedAt: now, deletedBy, updatedAt: now })
      .where(eq(recordingDrafts.id, id))
    await closeOpenBindings(tx as unknown as Db, { recordingDraftId: id }, now)
    await recordAudit(
      tx as unknown as Db,
      actor,
      'recording.delete',
      'recording',
      id,
      current.name,
    )
    return toDeleteResult({ id, deletedAt: now, deletedBy })
  })
}

async function importedScenarioIds(db: Db, draftIds: string[]): Promise<Map<string, string>> {
  const imported = new Map<string, string>()
  if (draftIds.length === 0) return imported
  const { recordingImportReceipts } = schemaFor(db)
  const rows = await db
    .select({
      recordingDraftId: recordingImportReceipts.recordingDraftId,
      scenarioId: recordingImportReceipts.scenarioId,
    })
    .from(recordingImportReceipts)
    .where(inArray(recordingImportReceipts.recordingDraftId, draftIds))
  for (const row of rows) {
    if (!imported.has(row.recordingDraftId)) imported.set(row.recordingDraftId, row.scenarioId)
  }
  return imported
}

async function findIdempotent(db: Db, actorId: string, key: string) {
  const { recordingDrafts } = schemaFor(db)
  const [row] = await db
    .select()
    .from(recordingDrafts)
    .where(and(eq(recordingDrafts.createdByConsoleAccountId, actorId), eq(recordingDrafts.idempotencyKey, key)))
    .limit(1)
  return row
}

async function toDetail(db: Db, id: string, actorId?: string): Promise<RecordingDraftDetailDto> {
  const { consoleAccounts, recordingDrafts, targets } = schemaFor(db)
  const [row] = await db
    .select({
      draft: recordingDrafts,
      targetName: targets.name,
      actorName: consoleAccounts.displayName,
    })
    .from(recordingDrafts)
    .innerJoin(targets, eq(recordingDrafts.targetId, targets.id))
    .innerJoin(consoleAccounts, eq(recordingDrafts.createdByConsoleAccountId, consoleAccounts.id))
    .where(and(eq(recordingDrafts.id, id), isNull(recordingDrafts.deletedAt)))
    .limit(1)
  if (!row || (actorId && row.draft.createdByConsoleAccountId !== actorId)) {
    throw notFound('RECORDING_NOT_FOUND', '录制草稿不存在')
  }
  const importedByDraft = await importedScenarioIds(db, [row.draft.id])
  return recordingDraftDetailSchema.parse({
    id: row.draft.id,
    targetId: row.draft.targetId,
    targetName: row.targetName,
    name: row.draft.name,
    recordingId: row.draft.recordingId,
    sourceVersion: row.draft.sourceVersion,
    sourceProtocol: row.draft.sourceProtocol,
    eventCount: row.draft.eventCount,
    itemCount: row.draft.itemCount,
    unresolvedCount: row.draft.unresolvedCount,
    createdBy: { id: row.draft.createdByConsoleAccountId, displayName: row.actorName },
    imported: importedByDraft.has(row.draft.id),
    importedScenarioId: importedByDraft.get(row.draft.id),
    createdAt: iso(row.draft.createdAt),
    updatedAt: iso(row.draft.updatedAt),
    items: row.draft.items,
    diagnostics: row.draft.diagnostics,
    events: row.draft.events,
  })
}

export async function assertBindingAcceptsUpload(db: Db, bindingId: string, actorId: string, targetId: string) {
  const { recordingBindings, scenarios } = schemaFor(db)
  const [row] = await db
    .select({ binding: recordingBindings, scenarioTargetId: scenarios.targetId })
    .from(recordingBindings)
    .innerJoin(scenarios, eq(recordingBindings.scenarioId, scenarios.id))
    .where(and(eq(recordingBindings.id, bindingId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!row || row.binding.createdByConsoleAccountId !== actorId) {
    throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  }
  if (row.binding.status === 'closed') throw conflict('RECORDING_BINDING_CLOSED', '录制绑定已关闭')
  if (row.binding.status === 'issued') throw conflict('RECORDING_BINDING_EXPIRED', '录制绑定尚未领取')
  if (row.binding.uploadExpiresAt.getTime() <= Date.now()) {
    throw conflict('RECORDING_BINDING_EXPIRED', '录制绑定已过期，不能继续上传')
  }
  if (row.binding.targetId !== targetId || row.scenarioTargetId !== targetId) {
    throw forbidden('RECORDING_BINDING_FORBIDDEN', '录制绑定的目标系统与上传不一致')
  }
}

export async function attachBindingDraft(db: Db, bindingId: string, actorId: string, draftId: string) {
  const { recordingBindings } = schemaFor(db)
  const [row] = await db.select().from(recordingBindings).where(eq(recordingBindings.id, bindingId)).limit(1)
  if (!row || row.createdByConsoleAccountId !== actorId) {
    throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  }
  if (row.recordingDraftId && row.recordingDraftId !== draftId) {
    throw conflict('RECORDING_IMPORT_CONFLICT', '该绑定已经关联过录制批次')
  }
  if (row.recordingDraftId === draftId) return
  await db
    .update(recordingBindings)
    .set({ recordingDraftId: draftId, updatedAt: new Date() })
    .where(eq(recordingBindings.id, bindingId))
}
