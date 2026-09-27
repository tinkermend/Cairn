import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import {
  canonicalJson,
  mapMenuEntryArchiveBodySchema,
  mapMenuEntryCreateBodySchema,
  mapMenuEntryDtoSchema,
  mapMenuEntryReorderBodySchema,
  mapMenuEntryUpdateBodySchema,
  type ExecutionActor,
  type MapMenuEntry,
  type MapMenuEntryArchiveBody,
  type MapMenuEntryCreateBody,
  type MapMenuEntryDto,
  type MapMenuEntryReorderBody,
  type MapMenuEntryUpdateBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { mapCommandIdempotencyConflict, mapNotFound, mapRevisionConflict, conflict } from './errors.js'
import { requireLiveTarget } from './view.js'

type MenuRow = ReturnType<typeof schemaFor>['mapMenuEntries']['$inferSelect']

function entryFromRow(row: MenuRow): MapMenuEntry {
  return {
    entryId: row.id,
    version: row.entryVersion,
    name: row.entryName,
    ...(row.entryUrl ? { url: row.entryUrl } : {}),
    ...(row.menuAnchor ? { menuAnchor: row.menuAnchor } : {}),
    enabled: row.enabled === 1,
    orderIndex: row.orderIndex,
    arrivalName: row.arrivalName,
    arrivalTarget: row.arrivalTarget,
  }
}

function dtoFromRow(row: MenuRow, lastIngest: MapMenuEntryDto['lastIngest'] = null): MapMenuEntryDto {
  return mapMenuEntryDtoSchema.parse({
    ...entryFromRow(row),
    targetId: row.targetId,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    lastIngest,
  })
}

function labelKey(label: string | undefined): string | null {
  return label?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? null
}

async function commandReceipt(db: Db, targetId: string, commandKey: string, payload: unknown): Promise<unknown | null> {
  const { mapMenuEntryCommands } = schemaFor(db)
  const [receipt] = await db.select().from(mapMenuEntryCommands)
    .where(and(eq(mapMenuEntryCommands.targetId, targetId), eq(mapMenuEntryCommands.commandKey, commandKey))).limit(1)
  if (!receipt) return null
  if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
  return receipt.result
}

async function saveReceipt(db: Db, targetId: string, commandKey: string, payload: unknown, result: unknown): Promise<void> {
  const { mapMenuEntryCommands } = schemaFor(db)
  await insertRows(db, mapMenuEntryCommands, {
    id: newId(), targetId, commandKey,
    payload: payload as Record<string, unknown>,
    result: result as Record<string, unknown>,
  })
}

async function assertUnique(db: Db, targetId: string, entry: { url?: string; menuAnchor?: { label: string } }, omitId?: string) {
  const { mapMenuEntries } = schemaFor(db)
  const rows = await db.select({ id: mapMenuEntries.id, url: mapMenuEntries.entryUrl, label: mapMenuEntries.menuLabelKey })
    .from(mapMenuEntries).where(and(eq(mapMenuEntries.targetId, targetId), isNull(mapMenuEntries.archivedAt)))
  const duplicate = rows.find(row => row.id !== omitId && (
    (entry.url && row.url === entry.url)
    || (!entry.url && !row.url && entry.menuAnchor && row.label === labelKey(entry.menuAnchor.label))
  ))
  if (duplicate) throw conflict('MAP_MENU_ENTRY_DUPLICATE', '该目标已存在相同 URL 或无 URL 一级菜单名称')
}

export async function listMapMenuEntries(db: Db, targetId: string, includeArchived = false): Promise<{ items: MapMenuEntryDto[] }> {
  await requireLiveTarget(db, targetId)
  const { mapMenuEntries, mapJobs, mapIngestPages } = schemaFor(db)
  const rows = await db.select().from(mapMenuEntries)
    .where(includeArchived ? eq(mapMenuEntries.targetId, targetId) : and(eq(mapMenuEntries.targetId, targetId), isNull(mapMenuEntries.archivedAt)))
    .orderBy(mapMenuEntries.orderIndex, mapMenuEntries.createdAt)
  const items: MapMenuEntryDto[] = []
  for (const row of rows) {
    const [latest] = await db.select().from(mapJobs)
      .where(and(eq(mapJobs.targetId, targetId), inArray(mapJobs.jobStatus, ['completed', 'failed']), eq(mapJobs.jobKind, 'map_ingest')))
      .orderBy(desc(mapJobs.updatedAt)).limit(20)
      .then(jobs => jobs.filter(job => job.frozenEntriesJson.some(entry => entry.entryId === row.id)).slice(0, 1))
    const pages = latest ? await db.select().from(mapIngestPages)
      .where(and(eq(mapIngestPages.jobId, latest.id), eq(mapIngestPages.entryId, row.id))) : []
    items.push(dtoFromRow(row, latest ? {
      jobId: latest.id,
      finishedAt: latest.updatedAt.toISOString(),
      outcome: latest.ingestSummary?.outcome ?? (latest.jobStatus === 'failed' ? 'failed' : 'partial'),
      pageCount: new Set(pages.map(page => page.pageKey)).size,
      elementCount: pages.reduce((sum, page) => sum + page.elementsJson.length, 0),
    } : null))
  }
  return { items }
}

export async function createMapMenuEntry(db: Db, targetId: string, body: MapMenuEntryCreateBody, actor: ExecutionActor): Promise<MapMenuEntryDto> {
  const parsed = mapMenuEntryCreateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async tx => {
    const payload = { operation: 'create', body: parsed }
    const receipt = await commandReceipt(tx, targetId, parsed.idempotencyKey, payload)
    if (receipt) return mapMenuEntryDtoSchema.parse(receipt)
    await assertUnique(tx, targetId, parsed)
    const { mapMenuEntries, mapMenuEntryRevisions } = schemaFor(tx)
    const rows = await tx.select({ orderIndex: mapMenuEntries.orderIndex }).from(mapMenuEntries)
      .where(and(eq(mapMenuEntries.targetId, targetId), isNull(mapMenuEntries.archivedAt)))
    const now = await clockNow(tx)
    const id = newId()
    await insertRows(tx, mapMenuEntries, {
      id, targetId, entryVersion: 1, entryName: parsed.name, entryUrl: parsed.url ?? null,
      menuAnchor: parsed.menuAnchor ?? null, menuLabelKey: labelKey(parsed.menuAnchor?.label),
      arrivalName: parsed.arrivalName, arrivalTarget: parsed.arrivalTarget,
      enabled: parsed.enabled ? 1 : 0, orderIndex: Math.max(-1, ...rows.map(row => row.orderIndex)) + 1,
      activeGuard: 'Y', createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
    })
    const [row] = await tx.select().from(mapMenuEntries).where(eq(mapMenuEntries.id, id)).limit(1)
    const dto = dtoFromRow(row!)
    await insertRows(tx, mapMenuEntryRevisions, { id: newId(), entryId: id, entryVersion: 1, snapshotJson: entryFromRow(row!), updatedBy: actor.id, createdAt: now })
    await saveReceipt(tx, targetId, parsed.idempotencyKey, payload, dto)
    await recordAudit(tx, actor, 'map.menu_entry.create', 'target', targetId, parsed.name)
    return dto
  })
}

export async function updateMapMenuEntry(db: Db, targetId: string, entryId: string, body: MapMenuEntryUpdateBody, actor: ExecutionActor): Promise<MapMenuEntryDto> {
  const parsed = mapMenuEntryUpdateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async tx => {
    const payload = { operation: 'update', entryId, body: parsed }
    const receipt = await commandReceipt(tx, targetId, parsed.idempotencyKey, payload)
    if (receipt) return mapMenuEntryDtoSchema.parse(receipt)
    const { mapMenuEntries, mapMenuEntryRevisions } = schemaFor(tx)
    const [row] = await locked(tx, tx.select().from(mapMenuEntries)
      .where(and(eq(mapMenuEntries.id, entryId), eq(mapMenuEntries.targetId, targetId))))
    if (!row || row.archivedAt) mapNotFound('一级菜单不存在或已归档')
    if (row.entryVersion !== parsed.expectedVersion) mapRevisionConflict('一级菜单版本已变更')
    await assertUnique(tx, targetId, parsed, entryId)
    const now = await clockNow(tx)
    await tx.update(mapMenuEntries).set({
      entryVersion: row.entryVersion + 1, entryName: parsed.name, entryUrl: parsed.url ?? null,
      menuAnchor: parsed.menuAnchor ?? null, menuLabelKey: labelKey(parsed.menuAnchor?.label),
      arrivalName: parsed.arrivalName, arrivalTarget: parsed.arrivalTarget, enabled: parsed.enabled ? 1 : 0,
      updatedBy: actor.id, updatedAt: now,
    }).where(eq(mapMenuEntries.id, entryId))
    const [updated] = await tx.select().from(mapMenuEntries).where(eq(mapMenuEntries.id, entryId)).limit(1)
    const dto = dtoFromRow(updated!)
    await insertRows(tx, mapMenuEntryRevisions, { id: newId(), entryId, entryVersion: updated!.entryVersion, snapshotJson: entryFromRow(updated!), updatedBy: actor.id, createdAt: now })
    await saveReceipt(tx, targetId, parsed.idempotencyKey, payload, dto)
    await recordAudit(tx, actor, 'map.menu_entry.update', 'target', targetId, parsed.name)
    return dto
  })
}

export async function archiveMapMenuEntry(db: Db, targetId: string, entryId: string, body: MapMenuEntryArchiveBody, actor: ExecutionActor): Promise<MapMenuEntryDto> {
  const parsed = mapMenuEntryArchiveBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async tx => {
    const payload = { operation: 'archive', entryId, body: parsed }
    const receipt = await commandReceipt(tx, targetId, parsed.idempotencyKey, payload)
    if (receipt) return mapMenuEntryDtoSchema.parse(receipt)
    const { mapMenuEntries, mapMenuEntryRevisions } = schemaFor(tx)
    const [row] = await locked(tx, tx.select().from(mapMenuEntries)
      .where(and(eq(mapMenuEntries.id, entryId), eq(mapMenuEntries.targetId, targetId))))
    if (!row || row.archivedAt) mapNotFound('一级菜单不存在或已归档')
    if (row.entryVersion !== parsed.expectedVersion) mapRevisionConflict('一级菜单版本已变更')
    const now = await clockNow(tx)
    await tx.update(mapMenuEntries).set({ entryVersion: row.entryVersion + 1, activeGuard: null, archivedAt: now, updatedBy: actor.id, updatedAt: now }).where(eq(mapMenuEntries.id, entryId))
    const [updated] = await tx.select().from(mapMenuEntries).where(eq(mapMenuEntries.id, entryId)).limit(1)
    const dto = dtoFromRow(updated!)
    await insertRows(tx, mapMenuEntryRevisions, { id: newId(), entryId, entryVersion: updated!.entryVersion, snapshotJson: entryFromRow(updated!), updatedBy: actor.id, createdAt: now })
    await saveReceipt(tx, targetId, parsed.idempotencyKey, payload, dto)
    await recordAudit(tx, actor, 'map.menu_entry.archive', 'target', targetId, parsed.reason ?? row.entryName)
    return dto
  })
}

export async function reorderMapMenuEntries(db: Db, targetId: string, body: MapMenuEntryReorderBody, actor: ExecutionActor): Promise<{ items: MapMenuEntryDto[] }> {
  const parsed = mapMenuEntryReorderBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  if (new Set(parsed.entries.map(entry => entry.entryId)).size !== parsed.entries.length) throw conflict('MAP_MENU_ENTRY_DUPLICATE', '排序列表含重复菜单')
  return atomic(db, async tx => {
    const payload = { operation: 'reorder', body: parsed }
    const receipt = await commandReceipt(tx, targetId, parsed.idempotencyKey, payload)
    if (receipt) return { items: (receipt as { items: unknown[] }).items.map(item => mapMenuEntryDtoSchema.parse(item)) }
    const { mapMenuEntries, mapMenuEntryRevisions } = schemaFor(tx)
    const rows = await locked(tx, tx.select().from(mapMenuEntries)
      .where(and(eq(mapMenuEntries.targetId, targetId), isNull(mapMenuEntries.archivedAt))))
    if (rows.length !== parsed.entries.length || rows.some(row => !parsed.entries.some(entry => entry.entryId === row.id))) {
      mapRevisionConflict('排序须包含所有未归档一级菜单')
    }
    const now = await clockNow(tx)
    const items: MapMenuEntryDto[] = []
    for (const [orderIndex, entry] of parsed.entries.entries()) {
      const row = rows.find(candidate => candidate.id === entry.entryId)!
      if (row.entryVersion !== entry.expectedVersion) mapRevisionConflict('一级菜单版本已变更')
      await tx.update(mapMenuEntries).set({ orderIndex, enabled: entry.enabled ? 1 : 0, entryVersion: row.entryVersion + 1, updatedBy: actor.id, updatedAt: now })
        .where(eq(mapMenuEntries.id, row.id))
      const [updated] = await tx.select().from(mapMenuEntries).where(eq(mapMenuEntries.id, row.id)).limit(1)
      const dto = dtoFromRow(updated!)
      items.push(dto)
      await insertRows(tx, mapMenuEntryRevisions, { id: newId(), entryId: row.id, entryVersion: updated!.entryVersion, snapshotJson: entryFromRow(updated!), updatedBy: actor.id, createdAt: now })
    }
    const result = { items }
    await saveReceipt(tx, targetId, parsed.idempotencyKey, payload, result)
    await recordAudit(tx, actor, 'map.menu_entry.reorder', 'target', targetId, '调整一级菜单顺序和启用状态')
    return result
  })
}
