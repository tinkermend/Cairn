import { and, eq, sql } from 'drizzle-orm'
import {
  mapIdentityCommandSchema,
  type MapIdentityAlias,
  type MapIdentityCommand,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { isUniqueViolation } from '../runs/errors.js'
import {
  mapIdentityConflict,
  mapIdentityCycle,
  mapIdentityStale,
  mapTargetMismatch,
} from './errors.js'

function refKey(ref: { pageId?: string; objectId?: string }): string {
  return `${ref.pageId ?? 'x'}:${ref.objectId ?? 'x'}`
}

function detectCycle(aliases: MapIdentityAlias[]): boolean {
  const edges = new Map<string, string>()
  for (const alias of aliases) {
    const from = `${alias.oldPageId ?? 'x'}:${alias.oldObjectId ?? 'x'}`
    const to = `${alias.newPageId ?? 'x'}:${alias.newObjectId ?? 'x'}`
    if (from !== 'x:x' && to !== 'x:x' && from !== to) edges.set(from, to)
  }
  for (const start of edges.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = start
    while (current) {
      if (seen.has(current)) return true
      seen.add(current)
      current = edges.get(current)
    }
  }
  return false
}

export async function applyMapIdentityCommand(db: Db, input: MapIdentityCommand) {
  const command = mapIdentityCommandSchema.parse(input)
  return atomic(db, async (tx) => {
    const { mapIdentityRevisions, mapObjects, mapPages, mapProjectionHeads } = schemaFor(tx)
    const [head] = await locked(
      tx,
      tx.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, command.targetId)),
    )
    const currentRevision = head?.identityRevision ?? 0
    const [existing] = await tx
      .select()
      .from(mapIdentityRevisions)
      .where(
        and(
          eq(mapIdentityRevisions.targetId, command.targetId),
          eq(mapIdentityRevisions.commandKey, command.commandKey),
        ),
      )
      .limit(1)
    if (existing) {
      return {
        outcome: 'duplicate' as const,
        revision: existing.revision,
        commandKey: existing.commandKey,
      }
    }
    if (currentRevision !== command.expectedIdentityRevision) mapIdentityStale()
    if (command.action === 'split' && command.newRefs.length < 2) {
      mapIdentityConflict('拆分必须保留旧身份并给出至少一个新身份')
    }
    if (command.action === 'merge' && command.oldRefs.length < 2) {
      mapIdentityConflict('合并至少需要两个旧引用')
    }
    if (command.action === 'alias' && (command.oldRefs.length !== 1 || command.newRefs.length !== 1)) {
      mapIdentityConflict('别名必须是一对一映射')
    }

    const resolveAlloc = async (ref: { pageId?: string; objectId?: string; targetId: string }) => {
      if (ref.targetId !== command.targetId) mapTargetMismatch()
      if (ref.objectId) {
        const [object] = await tx.select().from(mapObjects).where(eq(mapObjects.id, ref.objectId)).limit(1)
        if (object && object.targetId !== command.targetId) mapTargetMismatch()
        return object?.allocationKey
      }
      if (ref.pageId) {
        const [page] = await tx.select().from(mapPages).where(eq(mapPages.id, ref.pageId)).limit(1)
        if (page && page.targetId !== command.targetId) mapTargetMismatch()
        return page?.allocationKey
      }
      return undefined
    }

    const oldRefs = []
    for (const ref of command.oldRefs) {
      oldRefs.push({ ...ref, allocationKey: await resolveAlloc(ref) })
    }
    const newRefs = []
    for (const ref of command.newRefs) {
      newRefs.push({ ...ref, allocationKey: await resolveAlloc(ref) })
    }

    const prior = await tx
      .select()
      .from(mapIdentityRevisions)
      .where(eq(mapIdentityRevisions.targetId, command.targetId))
    const aliases: MapIdentityAlias[] = prior.flatMap((row) => {
      const old = row.oldRefs as Array<Record<string, unknown>>
      const next = row.newRefs as Array<Record<string, unknown>>
      return old.map((item, index) => ({
        revision: row.revision,
        action: row.action as MapIdentityAlias['action'],
        oldPageId: typeof item.pageId === 'string' ? item.pageId : undefined,
        oldObjectId: typeof item.objectId === 'string' ? item.objectId : undefined,
        oldAllocationKey: typeof item.allocationKey === 'string' ? item.allocationKey : undefined,
        newPageId: typeof next[index]?.pageId === 'string' ? next[index]?.pageId : typeof next[0]?.pageId === 'string' ? next[0]?.pageId : undefined,
        newObjectId: typeof next[index]?.objectId === 'string' ? next[index]?.objectId : typeof next[0]?.objectId === 'string' ? next[0]?.objectId : undefined,
        newAllocationKey:
          typeof next[index]?.allocationKey === 'string'
            ? next[index]?.allocationKey
            : typeof next[0]?.allocationKey === 'string'
              ? next[0]?.allocationKey
              : undefined,
      }))
    })
    for (const ref of oldRefs) {
      aliases.push({
        revision: currentRevision + 1,
        action: command.action,
        oldPageId: ref.pageId,
        oldObjectId: ref.objectId,
        oldAllocationKey: ref.allocationKey,
        newPageId: newRefs[0]?.pageId,
        newObjectId: newRefs[0]?.objectId,
        newAllocationKey: newRefs[0]?.allocationKey,
      })
    }
    if (detectCycle(aliases)) mapIdentityCycle()
    void refKey

    const now = await clockNow(tx)
    const revision = currentRevision + 1
    try {
      await insertRows(tx, mapIdentityRevisions, {
        id: newId(),
        targetId: command.targetId,
        revision,
        commandKey: command.commandKey,
        action: command.action,
        oldRefs,
        newRefs,
        reason: command.reason,
        evidence: command.evidenceRefs,
        actorId: command.actorId,
        createdAt: now,
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        const [dup] = await tx
          .select()
          .from(mapIdentityRevisions)
          .where(
            and(
              eq(mapIdentityRevisions.targetId, command.targetId),
              eq(mapIdentityRevisions.commandKey, command.commandKey),
            ),
          )
          .limit(1)
        if (dup) return { outcome: 'duplicate' as const, revision: dup.revision, commandKey: dup.commandKey }
      }
      throw error
    }
    if (head) {
      await tx
        .update(mapProjectionHeads)
        .set({ identityRevision: revision, updatedAt: now })
        .where(eq(mapProjectionHeads.targetId, command.targetId))
    }
    return { outcome: 'created' as const, revision, commandKey: command.commandKey }
  })
}

export async function loadIdentityAliases(db: Db, targetId: string, throughRevision: number): Promise<MapIdentityAlias[]> {
  const { mapIdentityRevisions } = schemaFor(db)
  const rows = await db
    .select()
    .from(mapIdentityRevisions)
    .where(and(eq(mapIdentityRevisions.targetId, targetId), sql`${mapIdentityRevisions.revision} <= ${throughRevision}`))
  return rows.flatMap((row) => {
    const old = row.oldRefs as Array<Record<string, unknown>>
    const next = row.newRefs as Array<Record<string, unknown>>
    return old.map((item, index) => ({
      revision: row.revision,
      action: row.action as MapIdentityAlias['action'],
      oldPageId: typeof item.pageId === 'string' ? item.pageId : undefined,
      oldObjectId: typeof item.objectId === 'string' ? item.objectId : undefined,
      oldAllocationKey: typeof item.allocationKey === 'string' ? item.allocationKey : undefined,
      newPageId:
        typeof next[index]?.pageId === 'string' ? next[index]?.pageId : typeof next[0]?.pageId === 'string' ? next[0]?.pageId : undefined,
      newObjectId:
        typeof next[index]?.objectId === 'string'
          ? next[index]?.objectId
          : typeof next[0]?.objectId === 'string'
            ? next[0]?.objectId
            : undefined,
      newAllocationKey:
        typeof next[index]?.allocationKey === 'string'
          ? next[index]?.allocationKey
          : typeof next[0]?.allocationKey === 'string'
            ? next[0]?.allocationKey
            : undefined,
    }))
  })
}
