import { and, eq, inArray, or, sql } from 'drizzle-orm'
import {
  MAP_IDENTITY_RULE_VERSION,
  canonicalJson,
  mapAssetRefKey,
  mapConditionSnapshotSchema,
  mapDescriptorFeaturesSchema,
  mapDimensionStatSchema,
  mapProjectionPlanSchema,
  mapProjectionStateSchema,
  type MapProjectionPlan,
  type MapProjectionState,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { isUniqueViolation } from '../runs/errors.js'
import { captureMapWatermark } from './facts.js'
import { loadIdentityAliases } from './identities.js'
import { mapProjectionNotFound, mapProjectionStale, mapTargetGone } from './errors.js'
import { ensureGovernanceHead, ensurePublicationHead } from './view.js'

export const MAP_ASSETS_POLICY_VERSION = 'map-assets@1' as const

export const mapProjectionTestHooks = {
  beforeAdvanceCursor: null as null | (() => void | Promise<void>),
  beforeInsertReleaseItems: null as null | (() => void | Promise<void>),
}

export type MapProjectionWorkItem = {
  targetId: string
  projectionId: string
  status: string
  cursor: number
  revision: number
  committedSeq: number
  sourceWatermark?: number
}

async function maxIdentityRevision(tx: Db, targetId: string): Promise<number> {
  const { mapIdentityRevisions, mapProjectionHeads } = schemaFor(tx)
  const [head] = await tx.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)).limit(1)
  if (head) return head.identityRevision
  const [row] = await tx
    .select({ revision: sql<number>`coalesce(max(${mapIdentityRevisions.revision}), 0)` })
    .from(mapIdentityRevisions)
    .where(eq(mapIdentityRevisions.targetId, targetId))
  return Number(row?.revision ?? 0)
}

export async function ensureMapProjection(db: Db, targetId: string) {
  return atomic(db, async (tx) => {
    const { mapProjectionHeads, mapProjections, targets } = schemaFor(tx)
    const [target] = await tx.select({ id: targets.id }).from(targets).where(eq(targets.id, targetId)).limit(1)
    if (!target) mapTargetGone()
    const [head] = await locked(
      tx,
      tx.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)),
    )
    if (head) {
      const [current] = await tx
        .select()
        .from(mapProjections)
        .where(eq(mapProjections.id, head.currentProjectionId))
        .limit(1)
      if (current) return current
    }
    const now = await clockNow(tx)
    const identityRevision = await maxIdentityRevision(tx, targetId)
    const projectionId = newId()
    const [created] = await insertRows(tx, mapProjections, {
      id: projectionId,
      targetId,
      generation: 1,
      status: 'active',
      algorithmVersion: MAP_IDENTITY_RULE_VERSION,
      policyVersion: MAP_ASSETS_POLICY_VERSION,
      identityRevision,
      revision: 0,
      cursor: 0,
      createdAt: now,
      updatedAt: now,
    })
    if (head) {
      await tx
        .update(mapProjectionHeads)
        .set({ currentProjectionId: projectionId, identityRevision, updatedAt: now })
        .where(eq(mapProjectionHeads.targetId, targetId))
    } else {
      await tx.insert(mapProjectionHeads).values({
        targetId,
        currentProjectionId: projectionId,
        identityRevision,
        updatedAt: now,
      })
    }
    await ensureGovernanceHead(tx, targetId)
    await ensurePublicationHead(tx, targetId)
    return created!
  })
}

export async function startMapProjectionRebuild(db: Db, input: { targetId: string }) {
  return atomic(db, async (tx) => {
    await ensureMapProjection(tx, input.targetId)
    const { mapProjectionHeads, mapProjections } = schemaFor(tx)
    await locked(tx, tx.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, input.targetId)))
    const watermark = await captureMapWatermark(tx, input.targetId)
    const identityRevision = await maxIdentityRevision(tx, input.targetId)
    const [latest] = await tx
      .select({ generation: sql<number>`coalesce(max(${mapProjections.generation}), 0)` })
      .from(mapProjections)
      .where(eq(mapProjections.targetId, input.targetId))
    const now = await clockNow(tx)
    const [created] = await insertRows(tx, mapProjections, {
      id: newId(),
      targetId: input.targetId,
      generation: Number(latest?.generation ?? 0) + 1,
      status: 'shadow',
      algorithmVersion: MAP_IDENTITY_RULE_VERSION,
      policyVersion: MAP_ASSETS_POLICY_VERSION,
      identityRevision,
      revision: 0,
      cursor: 0,
      sourceWatermark: watermark.committedSeq,
      rebuildCompleteness: 'complete',
      createdAt: now,
      updatedAt: now,
    })
    return created!
  })
}

export async function listMapProjectionWork(db: Db, input: { limit?: number } = {}): Promise<MapProjectionWorkItem[]> {
  const { mapIngestHeads, mapProjectionHeads, mapProjections } = schemaFor(db)
  const limit = Math.min(input.limit ?? 8, 32)
  const rows = await db
    .select({
      targetId: mapProjections.targetId,
      projectionId: mapProjections.id,
      status: mapProjections.status,
      cursor: mapProjections.cursor,
      revision: mapProjections.revision,
      sourceWatermark: mapProjections.sourceWatermark,
      committedSeq: mapIngestHeads.committedSeq,
      currentProjectionId: mapProjectionHeads.currentProjectionId,
    })
    .from(mapProjections)
    .leftJoin(mapProjectionHeads, eq(mapProjectionHeads.targetId, mapProjections.targetId))
    .leftJoin(mapIngestHeads, eq(mapIngestHeads.targetId, mapProjections.targetId))
    .where(
      or(
        and(
          eq(mapProjections.status, 'shadow'),
          or(sql`${mapProjections.cursor} < coalesce(${mapProjections.sourceWatermark}, 0)`, eq(mapProjections.cursor, 0)),
        ),
        and(
          eq(mapProjections.status, 'active'),
          sql`${mapProjections.id} = ${mapProjectionHeads.currentProjectionId}`,
          sql`${mapProjections.cursor} < coalesce(${mapIngestHeads.committedSeq}, 0)`,
        ),
      ),
    )
    .limit(limit)
  return rows.map((row) => ({
    targetId: row.targetId,
    projectionId: row.projectionId,
    status: row.status,
    cursor: row.cursor,
    revision: row.revision,
    committedSeq: Number(row.committedSeq ?? 0),
    sourceWatermark: row.sourceWatermark ?? undefined,
  }))
}

function hydrateProjectionState(input: {
  projection: {
    id: string
    targetId: string
    generation: number
    status: MapProjectionState['status']
    cursor: number
    revision: number
    identityRevision: number
    sourceWatermark: number | null
    rebuildCompleteness: MapProjectionState['rebuildCompleteness'] | null
  }
  pages: Array<{ id: string; allocationKey: string; kind: MapProjectionState['pages'][number]['kind']; routeTemplate: string }>
  objects: Array<{ id: string; allocationKey: string; pageId: string }>
  implementations: Array<{
    objectId: string
    implementationKey: string
    conditionSnapshot: unknown
    currentDescriptorVersion: number | null
  }>
  descriptors: Array<{
    objectId: string
    implementationKey: string
    descriptorVersion: number
    features: unknown
    conditionSnapshot: unknown
    contentDigest: string
  }>
  assignments: Array<{
    observationId: string
    pageId: string | null
    objectId: string | null
    assignmentRevision: number
  }>
  assets: Array<{
    assetRefKey: string
    pageId: string | null
    objectId: string | null
    implementationKey: string | null
    descriptorVersion: number | null
    lifecycle: MapProjectionState['assets'][number]['lifecycle']
    importance: number
    executable: number
    rejectReasons: string[]
    dimensions: unknown[]
    sampleCount: number
    changeCount: number
    lastVerifiedAt: Date | null
  }>
  aliases: MapProjectionState['aliases']
}): MapProjectionState {
  const pageById = new Map(input.pages.map((page) => [page.id, page]))
  const objectById = new Map(input.objects.map((object) => [object.id, object]))
  const latestAssignments = new Map<string, (typeof input.assignments)[number]>()
  for (const row of input.assignments) {
    const current = latestAssignments.get(row.observationId)
    if (!current || current.assignmentRevision < row.assignmentRevision) latestAssignments.set(row.observationId, row)
  }
  return mapProjectionStateSchema.parse({
    targetId: input.projection.targetId,
    projectionId: input.projection.id,
    generation: input.projection.generation,
    status: input.projection.status,
    cursor: input.projection.cursor,
    revision: input.projection.revision,
    identityRevision: input.projection.identityRevision,
    sourceWatermark: input.projection.sourceWatermark ?? undefined,
    rebuildCompleteness: input.projection.rebuildCompleteness ?? undefined,
    pages: input.pages.map((page) => ({
      id: page.id,
      allocationKey: page.allocationKey,
      kind: page.kind,
      routeTemplate: page.routeTemplate,
    })),
    objects: input.objects.map((object) => ({
      id: object.id,
      allocationKey: object.allocationKey,
      pageId: object.pageId,
      pageAllocationKey: pageById.get(object.pageId)?.allocationKey ?? object.allocationKey,
      regionKey: object.allocationKey.split(':')[3],
      stableToken: object.allocationKey.split(':')[4],
    })),
    implementations: input.implementations.map((item) => ({
      objectId: item.objectId,
      objectAllocationKey: objectById.get(item.objectId)?.allocationKey ?? item.implementationKey,
      implementationKey: item.implementationKey,
      condition: mapConditionSnapshotSchema.parse(item.conditionSnapshot),
      currentDescriptorVersion: item.currentDescriptorVersion ?? undefined,
      changeCount: 0,
    })),
    descriptors: input.descriptors.map((item) => ({
      objectId: item.objectId,
      implementationKey: item.implementationKey,
      version: item.descriptorVersion,
      features: mapDescriptorFeaturesSchema.parse(item.features),
      condition: mapConditionSnapshotSchema.parse(item.conditionSnapshot),
      digest: item.contentDigest,
    })),
    assignments: [...latestAssignments.values()].map((item) => ({
      observationId: item.observationId,
      pageId: item.pageId ?? undefined,
      objectId: item.objectId ?? undefined,
      assignmentRevision: item.assignmentRevision,
    })),
    assets: input.assets.map((item) => ({
      assetRefKey: item.assetRefKey,
      pageId: item.pageId ?? undefined,
      objectId: item.objectId ?? undefined,
      implementationKey: item.implementationKey ?? undefined,
      descriptorVersion: item.descriptorVersion ?? undefined,
      lifecycle: item.lifecycle,
      importance: item.importance,
      executable: item.executable === 1,
      rejectReasons: item.rejectReasons,
      dimensions: item.dimensions.map((dimension) => mapDimensionStatSchema.parse(dimension)),
      sampleCount: item.sampleCount,
      changeCount: item.changeCount,
      lastVerifiedAt: item.lastVerifiedAt ? item.lastVerifiedAt.toISOString() : undefined,
    })),
    aliases: input.aliases,
  })
}

export async function loadMapProjectionState(db: Db, projectionId: string): Promise<MapProjectionState> {
  const {
    mapIdentityAssignments,
    mapImplementations,
    mapObjectDescriptors,
    mapObjects,
    mapPages,
    mapProjectionAssets,
    mapProjections,
  } = schemaFor(db)
  const [projection] = await db.select().from(mapProjections).where(eq(mapProjections.id, projectionId)).limit(1)
  if (!projection) mapProjectionNotFound()
  const [pages, objects, implementations, descriptors, assignments, assets] = await Promise.all([
    db.select().from(mapPages).where(eq(mapPages.targetId, projection.targetId)),
    db.select().from(mapObjects).where(eq(mapObjects.targetId, projection.targetId)),
    db.select().from(mapImplementations).where(eq(mapImplementations.targetId, projection.targetId)),
    db.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.targetId, projection.targetId)),
    db.select().from(mapIdentityAssignments).where(eq(mapIdentityAssignments.projectionId, projectionId)),
    db.select().from(mapProjectionAssets).where(eq(mapProjectionAssets.projectionId, projectionId)),
  ])
  return hydrateProjectionState({
    projection,
    pages,
    objects,
    implementations,
    descriptors,
    assignments,
    assets,
    aliases: await loadIdentityAliases(db, projection.targetId, projection.identityRevision),
  })
}

export async function loadMapProjectionWorkingSet(
  db: Db,
  input: {
    projectionId: string
    pageAllocationKeys?: readonly string[]
    objectAllocationKeys?: readonly string[]
    observationIds?: readonly string[]
  },
): Promise<MapProjectionState> {
  const { mapIdentityAssignments, mapObjects, mapPages, mapProjectionAssets, mapProjections } = schemaFor(db)
  const [projection] = await db.select().from(mapProjections).where(eq(mapProjections.id, input.projectionId)).limit(1)
  if (!projection) mapProjectionNotFound()
  const aliases = await loadIdentityAliases(db, projection.targetId, projection.identityRevision)
  const pageKeys = [...new Set(input.pageAllocationKeys ?? [])]
  const objectKeys = new Set(input.objectAllocationKeys ?? [])
  for (const alias of aliases) {
    if (alias.oldAllocationKey && objectKeys.has(alias.oldAllocationKey) && alias.newAllocationKey) {
      objectKeys.add(alias.newAllocationKey)
    }
    if (alias.newAllocationKey && objectKeys.has(alias.newAllocationKey) && alias.oldAllocationKey) {
      objectKeys.add(alias.oldAllocationKey)
    }
  }
  const pages = pageKeys.length
    ? await db
        .select()
        .from(mapPages)
        .where(and(eq(mapPages.targetId, projection.targetId), inArray(mapPages.allocationKey, pageKeys)))
    : []
  const pageIds = pages.map((page) => page.id)
  const objectKeyList = [...objectKeys]
  const objectScope = [
    ...(objectKeyList.length ? [inArray(mapObjects.allocationKey, objectKeyList)] : []),
    ...(pageIds.length ? [inArray(mapObjects.pageId, pageIds)] : []),
  ]
  const objects = objectScope.length
    ? await db.select().from(mapObjects).where(and(eq(mapObjects.targetId, projection.targetId), or(...objectScope)))
    : []
  const objectIds = objects.map((object) => object.id)
  const assetScope = [
    ...(pageIds.length ? [inArray(mapProjectionAssets.pageId, pageIds)] : []),
    ...(objectIds.length ? [inArray(mapProjectionAssets.objectId, objectIds)] : []),
  ]
  const assets = assetScope.length
    ? await db
        .select()
        .from(mapProjectionAssets)
        .where(and(eq(mapProjectionAssets.projectionId, projection.id), or(...assetScope)))
    : []
  const observationIds = [...new Set(input.observationIds ?? [])]
  const assignments = observationIds.length
    ? await db
        .select()
        .from(mapIdentityAssignments)
        .where(
          and(
            eq(mapIdentityAssignments.projectionId, projection.id),
            inArray(mapIdentityAssignments.observationId, observationIds),
          ),
        )
    : []
  return hydrateProjectionState({
    projection,
    pages,
    objects,
    implementations: [],
    descriptors: [],
    assignments,
    assets,
    aliases,
  })
}

async function allocatePage(
  tx: Db,
  targetId: string,
  allocation: MapProjectionPlan['pages'][number],
  now: Date,
): Promise<string> {
  const { mapPages } = schemaFor(tx)
  const [existing] = await tx
    .select()
    .from(mapPages)
    .where(and(eq(mapPages.targetId, targetId), eq(mapPages.allocationKey, allocation.allocationKey)))
    .limit(1)
  if (existing) return existing.id
  const id = newId()
  try {
    await insertRows(tx, mapPages, {
      id,
      targetId,
      allocationKey: allocation.allocationKey,
      kind: allocation.kind,
      routeTemplate: allocation.routeTemplate,
      status: 'discovered',
      createdAt: now,
      updatedAt: now,
    })
    return id
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const [again] = await tx
      .select()
      .from(mapPages)
      .where(and(eq(mapPages.targetId, targetId), eq(mapPages.allocationKey, allocation.allocationKey)))
      .limit(1)
    return again!.id
  }
}

async function allocateObject(
  tx: Db,
  targetId: string,
  pageId: string,
  allocation: MapProjectionPlan['objects'][number],
  now: Date,
): Promise<string> {
  const { mapObjects } = schemaFor(tx)
  const [existing] = await tx
    .select()
    .from(mapObjects)
    .where(and(eq(mapObjects.targetId, targetId), eq(mapObjects.allocationKey, allocation.allocationKey)))
    .limit(1)
  if (existing) return existing.id
  const id = newId()
  try {
    await insertRows(tx, mapObjects, {
      id,
      targetId,
      pageId,
      allocationKey: allocation.allocationKey,
      status: 'discovered',
      createdAt: now,
      updatedAt: now,
    })
    return id
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const [again] = await tx
      .select()
      .from(mapObjects)
      .where(and(eq(mapObjects.targetId, targetId), eq(mapObjects.allocationKey, allocation.allocationKey)))
      .limit(1)
    return again!.id
  }
}

export async function commitMapProjectionBatch(
  db: Db,
  input: {
    projectionId: string
    expectedCursor: number
    expectedRevision: number
    plan: MapProjectionPlan
  },
) {
  const plan = mapProjectionPlanSchema.parse(input.plan)
  return atomic(db, async (tx) => {
    const {
      mapConflicts,
      mapIdentityAssignments,
      mapImplementations,
      mapObjectDescriptors,
      mapProjectionAssets,
      mapProjections,
    } = schemaFor(tx)
    const [projection] = await locked(
      tx,
      tx.select().from(mapProjections).where(eq(mapProjections.id, input.projectionId)),
    )
    if (!projection) mapProjectionNotFound()
    if (projection.cursor !== input.expectedCursor || projection.revision !== input.expectedRevision) {
      mapProjectionStale()
    }
    const now = await clockNow(tx)
    const pages = new Map<string, string>()
    for (const page of plan.pages) {
      pages.set(page.allocationKey, await allocatePage(tx, projection.targetId, page, now))
    }
    const objects = new Map<string, string>()
    for (const object of plan.objects) {
      const pageId = pages.get(object.pageAllocationKey) ?? (await lookupPageId(tx, projection.targetId, object.pageAllocationKey))
      if (!pageId) continue
      pages.set(object.pageAllocationKey, pageId)
      objects.set(object.allocationKey, await allocateObject(tx, projection.targetId, pageId, object, now))
    }
    const assignmentRevision = projection.revision + 1
    for (const assignment of plan.assignments) {
      await insertRows(tx, mapIdentityAssignments, {
        id: newId(),
        projectionId: projection.id,
        observationId: assignment.observationId,
        targetId: projection.targetId,
        pageId: assignment.pageAllocationKey ? pages.get(assignment.pageAllocationKey) ?? null : null,
        objectId: assignment.objectAllocationKey ? objects.get(assignment.objectAllocationKey) ?? null : null,
        assignmentRevision,
        createdAt: now,
      })
    }
    for (const descriptor of plan.descriptors) {
      const objectId = objects.get(descriptor.objectAllocationKey)
      if (!objectId) continue
      const digest = sha256Hex(canonicalJson({ features: descriptor.features, condition: descriptor.condition }))
      const [same] = await tx
        .select()
        .from(mapObjectDescriptors)
        .where(
          and(
            eq(mapObjectDescriptors.objectId, objectId),
            eq(mapObjectDescriptors.implementationKey, descriptor.implementationKey),
            eq(mapObjectDescriptors.contentDigest, digest),
          ),
        )
        .limit(1)
      let version = same?.descriptorVersion
      if (!version) {
        const [max] = await tx
          .select({ version: sql<number>`coalesce(max(${mapObjectDescriptors.descriptorVersion}), 0)` })
          .from(mapObjectDescriptors)
          .where(
            and(
              eq(mapObjectDescriptors.objectId, objectId),
              eq(mapObjectDescriptors.implementationKey, descriptor.implementationKey),
            ),
          )
        version = Number(max?.version ?? 0) + 1
        await insertRows(tx, mapObjectDescriptors, {
          id: newId(),
          targetId: projection.targetId,
          objectId,
          implementationKey: descriptor.implementationKey,
          descriptorVersion: version,
          features: descriptor.features,
          conditionSnapshot: descriptor.condition,
          contentDigest: digest,
          createdAt: now,
        })
      }
      const [impl] = await tx
        .select()
        .from(mapImplementations)
        .where(
          and(
            eq(mapImplementations.objectId, objectId),
            eq(mapImplementations.implementationKey, descriptor.implementationKey),
          ),
        )
        .limit(1)
      if (!impl) {
        await insertRows(tx, mapImplementations, {
          id: newId(),
          targetId: projection.targetId,
          objectId,
          implementationKey: descriptor.implementationKey,
          currentDescriptorVersion: version,
          conditionSnapshot: descriptor.condition,
          createdAt: now,
          updatedAt: now,
        })
      } else if (impl.currentDescriptorVersion !== version) {
        await tx
          .update(mapImplementations)
          .set({ currentDescriptorVersion: version, conditionSnapshot: descriptor.condition, updatedAt: now })
          .where(eq(mapImplementations.id, impl.id))
      }
    }
    for (const asset of plan.assets) {
      const pageId = asset.pageAllocationKey
        ? pages.get(asset.pageAllocationKey) ?? (await lookupPageId(tx, projection.targetId, asset.pageAllocationKey))
        : undefined
      if (asset.pageAllocationKey && pageId) pages.set(asset.pageAllocationKey, pageId)
      const objectId = asset.objectAllocationKey
        ? objects.get(asset.objectAllocationKey) ??
          (await lookupObjectId(tx, projection.targetId, asset.objectAllocationKey))
        : undefined
      if (asset.objectAllocationKey && objectId) objects.set(asset.objectAllocationKey, objectId)
      const [impl] =
        objectId && asset.implementationKey
          ? await tx
              .select()
              .from(mapImplementations)
              .where(
                and(
                  eq(mapImplementations.objectId, objectId),
                  eq(mapImplementations.implementationKey, asset.implementationKey),
                ),
              )
              .limit(1)
          : [undefined]
      const assetRefKey = mapAssetRefKey({
        pageId,
        objectId,
        implementationKey: asset.implementationKey,
        descriptorVersion: impl?.currentDescriptorVersion ?? undefined,
      })
      const [existing] = await tx
        .select()
        .from(mapProjectionAssets)
        .where(
          and(eq(mapProjectionAssets.projectionId, projection.id), eq(mapProjectionAssets.assetRefKey, assetRefKey)),
        )
        .limit(1)
      const values = {
        pageId: pageId ?? null,
        objectId: objectId ?? null,
        implementationKey: asset.implementationKey ?? null,
        descriptorVersion: impl?.currentDescriptorVersion ?? null,
        lifecycle: asset.lifecycle,
        importance: asset.importance,
        executable: asset.executable ? 1 : 0,
        rejectReasons: asset.rejectReasons,
        dimensions: asset.dimensions,
        sampleCount: asset.sampleCount,
        changeCount: asset.changeCount,
        lastVerifiedAt: asset.lastVerifiedAt ? new Date(asset.lastVerifiedAt) : null,
        updatedAt: now,
      }
      if (existing) {
        await tx.update(mapProjectionAssets).set(values).where(eq(mapProjectionAssets.id, existing.id))
      } else {
        await insertRows(tx, mapProjectionAssets, {
          id: newId(),
          projectionId: projection.id,
          targetId: projection.targetId,
          assetRefKey,
          ...values,
          createdAt: now,
        })
      }
    }
    for (const conflict of plan.conflicts) {
      const [existing] = await tx
        .select()
        .from(mapConflicts)
        .where(and(eq(mapConflicts.targetId, projection.targetId), eq(mapConflicts.conflictKey, conflict.conflictKey)))
        .limit(1)
      if (!existing) {
        await insertRows(tx, mapConflicts, {
          id: newId(),
          targetId: projection.targetId,
          projectionId: projection.id,
          conflictKey: conflict.conflictKey,
          status: 'open',
          payload: conflict.payload as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
    if (mapProjectionTestHooks.beforeAdvanceCursor) await mapProjectionTestHooks.beforeAdvanceCursor()
    let status = projection.status
    if (projection.status === 'shadow' && plan.nextCursor >= Number(projection.sourceWatermark ?? 0)) {
      status = 'ready'
    }
    const updated = await updateRows(
      tx,
      mapProjections,
      {
        cursor: plan.nextCursor,
        revision: projection.revision + 1,
        status,
        rebuildCompleteness: plan.rebuildCompleteness ?? projection.rebuildCompleteness,
        lastError: null,
        updatedAt: now,
      },
      and(
        eq(mapProjections.id, projection.id),
        eq(mapProjections.cursor, input.expectedCursor),
        eq(mapProjections.revision, input.expectedRevision),
      ),
    )
    if (!updated.length) mapProjectionStale()
    return { cursor: plan.nextCursor, revision: projection.revision + 1, status }
  })
}

async function lookupPageId(tx: Db, targetId: string, allocationKey: string): Promise<string | undefined> {
  const { mapPages } = schemaFor(tx)
  const [row] = await tx
    .select()
    .from(mapPages)
    .where(and(eq(mapPages.targetId, targetId), eq(mapPages.allocationKey, allocationKey)))
    .limit(1)
  return row?.id
}

async function lookupObjectId(tx: Db, targetId: string, allocationKey: string): Promise<string | undefined> {
  const { mapObjects } = schemaFor(tx)
  const [row] = await tx
    .select()
    .from(mapObjects)
    .where(and(eq(mapObjects.targetId, targetId), eq(mapObjects.allocationKey, allocationKey)))
    .limit(1)
  return row?.id
}

export async function recordMapProjectionFailure(db: Db, input: { projectionId: string; message: string }) {
  const { mapProjections } = schemaFor(db)
  const now = await clockNow(db)
  await db
    .update(mapProjections)
    .set({ status: 'failed', lastError: input.message.slice(0, 512), updatedAt: now })
    .where(eq(mapProjections.id, input.projectionId))
}

export async function promoteMapProjection(db: Db, input: { targetId: string; projectionId: string }) {
  return atomic(db, async (tx) => {
    const { mapProjectionHeads, mapProjections } = schemaFor(tx)
    const [head] = await locked(
      tx,
      tx.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, input.targetId)),
    )
    const [next] = await tx.select().from(mapProjections).where(eq(mapProjections.id, input.projectionId)).limit(1)
    if (!next || next.targetId !== input.targetId) mapProjectionNotFound()
    const now = await clockNow(tx)
    if (head?.currentProjectionId && head.currentProjectionId !== next.id) {
      await tx
        .update(mapProjections)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(mapProjections.id, head.currentProjectionId))
    }
    await tx
      .update(mapProjections)
      .set({ status: next.status === 'shadow' || next.status === 'ready' ? 'active' : next.status, updatedAt: now })
      .where(eq(mapProjections.id, next.id))
    if (head) {
      await tx
        .update(mapProjectionHeads)
        .set({ currentProjectionId: next.id, updatedAt: now })
        .where(eq(mapProjectionHeads.targetId, input.targetId))
    } else {
      await tx.insert(mapProjectionHeads).values({
        targetId: input.targetId,
        currentProjectionId: next.id,
        identityRevision: next.identityRevision,
        updatedAt: now,
      })
    }
    return next
  })
}

export async function getMapProjection(db: Db, projectionId: string) {
  const { mapProjections } = schemaFor(db)
  const [row] = await db.select().from(mapProjections).where(eq(mapProjections.id, projectionId)).limit(1)
  if (!row) mapProjectionNotFound()
  return row
}
