import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import {
  canonicalJson,
  MAP_LIST_LIMIT_MAX,
  mapAssetDetailSchema,
  mapAssetListResponseSchema,
  mapChangeListResponseSchema,
  mapAssetRefSchema,
  mapGovernanceCommandSchema,
  mapGovernancePreviewResponseSchema,
  mapListQuerySchema,
  mapSummaryResponseSchema,
  type MapAssetListItem,
  type MapConditionSnapshot,
  type MapConditionTri,
  type MapGovernanceCommandBody,
  type MapGovernancePreviewBody,
  type MapListQuery,
} from '@cairn/shared'
import type { ExecutionActor } from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { isUniqueViolation } from '../runs/errors.js'
import { applyMapIdentityCommand } from './identities.js'
import { loadMapQueryView } from './releases.js'
import { startMapProjectionRebuild } from './projections.js'
import {
  mapCommandIdempotencyConflict,
  mapNotFound,
  mapRevisionConflict,
} from './errors.js'
import {
  assetKey,
  assetRef,
  decodeMapCursor,
  encodeMapCursor,
  ensureGovernanceHead,
  listDigest,
  loadOverlays,
  resolveAssetOverlay,
  requireLiveTarget,
  requireMapAsset,
  resolveMapView,
  viewMeta,
} from './view.js'

function matchesSearch(
  item: { name?: string; routeTemplate?: string; assetRefKey: string },
  search?: string,
): boolean {
  if (!search) return true
  const needle = search.toLowerCase()
  return [item.name, item.routeTemplate, item.assetRefKey].some((value) => value?.toLowerCase().includes(needle))
}

async function loadViewAssets(db: Db, view: Awaited<ReturnType<typeof resolveMapView>>) {
  if (!view.projectionId && !view.releaseId) return []
  const queryView = await loadMapQueryView(db, {
    targetId: view.targetId,
    view: view.releaseId
      ? { kind: 'release', releaseId: view.releaseId, manifestDigest: view.manifestDigest! }
      : { kind: 'projection', projectionId: view.projectionId! },
    limit: 50,
  })
  const overlays = view.kind === 'release' ? new Map() : await loadOverlays(db, view.targetId)
  return queryView.assets.map(item => ({
    ...item,
    pageId: item.assetRef.pageId,
    objectId: item.assetRef.objectId,
    implementationKey: item.assetRef.implementationKey,
    descriptorVersion: item.assetRef.descriptorVersion,
    overlayLifecycle: resolveAssetOverlay(overlays, item.assetRef),
    unknownFields: item.condition?.unknownFields ?? ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
    name: item.features?.semanticName,
  })).sort((a, b) => (b.descriptorVersion ?? 0) - (a.descriptorVersion ?? 0))
}

type ConditionEvaluator = (required: MapConditionSnapshot, observed: MapConditionSnapshot) => MapConditionTri
function filterViewAssets(assets: Awaited<ReturnType<typeof loadViewAssets>>, query: MapListQuery, evaluate?: ConditionEvaluator) {
  if (query.conditionSnapshot && !evaluate) throw new Error('Map condition evaluator is required')
  return assets.filter(item => matchesSearch(item, query.search))
    .filter(item => !query.lifecycle || item.lifecycle === query.lifecycle)
    .filter(item => !query.conditionSnapshot || !item.condition || evaluate!(item.condition, query.conditionSnapshot) !== 'unsatisfied')
}

function toListItem(
  targetId: string,
  item: Awaited<ReturnType<typeof loadViewAssets>>[number],
): MapAssetListItem {
  return {
    assetRef: assetRef({ ...item, targetId }),
    assetRefKey: item.assetRefKey,
    name: item.name,
    routeTemplate: item.routeTemplate,
    lifecycle: item.lifecycle,
    overlayLifecycle: item.overlayLifecycle,
    dimensions: item.dimensions,
    unknownFields: item.unknownFields,
    changeCount: item.changeCount,
    lastVerifiedAt: item.lastVerifiedAt,
    evidenceAvailability: item.evidenceAvailability,
  }
}

function paginate<T extends { assetRefKey: string }>(
  rows: T[],
  digest: string,
  query: MapListQuery,
): { items: T[]; nextCursor?: string } {
  const sorted = [...rows].sort((a, b) => a.assetRefKey < b.assetRefKey ? -1 : a.assetRefKey > b.assetRefKey ? 1 : 0)
  const after = query.cursor ? decodeMapCursor(query.cursor, digest) : undefined
  const filtered = after ? sorted.filter((row) => row.assetRefKey > after) : sorted
  const limit = query.limit
  const page = filtered.slice(0, limit + 1)
  const hasMore = page.length > limit
  const items = hasMore ? page.slice(0, limit) : page
  return {
    items,
    nextCursor: hasMore ? encodeMapCursor(digest, items.at(-1)!.assetRefKey) : undefined,
  }
}

export async function getMapSummary(db: Db, targetId: string, query: MapListQuery, evaluate?: ConditionEvaluator) {
  await requireLiveTarget(db, targetId)
  const view = await resolveMapView(db, targetId, query)
  const assets = filterViewAssets(await loadViewAssets(db, view), query, evaluate)
  const { mapConflicts, mapReleasePublications, mapProjections } = schemaFor(db)
  const [latestProjection] = view.kind === 'projection' ? await db.select().from(mapProjections).where(eq(mapProjections.targetId, targetId)).orderBy(desc(mapProjections.generation)).limit(1) : []
  const rebuilding = latestProjection && latestProjection.id !== view.projectionId && ['shadow', 'ready', 'failed'].includes(latestProjection.status) ? latestProjection : undefined
  const conflicts = view.projectionId
    ? await db
        .select({ id: mapConflicts.id })
        .from(mapConflicts)
        .where(and(eq(mapConflicts.targetId, targetId), eq(mapConflicts.projectionId, view.projectionId!), eq(mapConflicts.status, 'open')))
    : []
  const [published] = await db
    .select()
    .from(mapReleasePublications)
    .where(and(eq(mapReleasePublications.targetId, targetId), eq(mapReleasePublications.publicationStatus, 'published')))
    .orderBy(desc(mapReleasePublications.publishedAt), desc(mapReleasePublications.releaseId))
    .limit(1)
  const pages = new Set(assets.map((item) => item.pageId).filter(Boolean))
  const objects = new Set(assets.map((item) => item.objectId).filter(Boolean))
  return mapSummaryResponseSchema.parse({
    view: await viewMeta(db, view),
    projectionStatus: view.kind === 'release' ? 'ready' : view.status ?? 'missing',
    rebuildStatus: rebuilding?.status,
    rebuildProjectionId: rebuilding?.id,
    rebuildCompleteness: view.rebuildCompleteness ?? undefined,
    pageCount: pages.size,
    objectCount: objects.size,
    conflictCount: conflicts.length,
    unknownConditionCount: assets.filter((item) => item.unknownFields.length > 0).length,
    changeCount: assets.filter((item) => item.changeCount > 0).length,
    publishedReleaseId: published?.releaseId,
    publicationStatus: published?.publicationStatus,
  })
}

export async function listMapAssets(
  db: Db,
  targetId: string,
  kind: 'pages' | 'objects',
  query: MapListQuery,
  evaluate?: ConditionEvaluator,
) {
  await requireLiveTarget(db, targetId)
  const view = await resolveMapView(db, targetId, query)
  const digest = listDigest({
    targetId,
    kind,
    projectionId: view.projectionId,
    releaseId: view.releaseId,
    search: query.search,
    lifecycle: query.lifecycle,
    conditionSnapshot: query.conditionSnapshot,
    revision: view.revision,
    governanceRevision: (await viewMeta(db, view)).governanceRevision,
  })
  const loaded = filterViewAssets(await loadViewAssets(db, view), query, evaluate)
  const grouped = new Map<string, (typeof loaded)[number]>()
  for (const item of loaded) {
    const key = kind === 'pages' ? (item.pageId ?? item.assetRefKey) : (item.objectId ?? item.assetRefKey)
    if (kind === 'objects' && !item.objectId) continue
    if (kind === 'pages' && !item.pageId) continue
    if (!grouped.has(key)) grouped.set(key, item)
  }
  const items = [...grouped.values()]
    .map(item => kind === 'pages' ? toListItem(targetId, { ...item, objectId: undefined, implementationKey: undefined, descriptorVersion: undefined, assetRefKey: assetKey({ targetId, pageId: item.pageId }), name: undefined }) : toListItem(targetId, item))
    .filter((item) => matchesSearch(item, query.search))
    .filter((item) => !query.lifecycle || item.lifecycle === query.lifecycle)
  const page = paginate(items, digest, query)
  return mapAssetListResponseSchema.parse({
    items: page.items,
    nextCursor: page.nextCursor,
    view: await viewMeta(db, view),
  })
}

export async function listMapJobCandidateAssets(
  db: Db,
  targetId: string,
  evaluate?: ConditionEvaluator,
): Promise<MapAssetListItem[]> {
  const items: MapAssetListItem[] = []
  let cursor: string | undefined
  do {
    const page = await listMapAssets(
      db,
      targetId,
      'objects',
      mapListQuerySchema.parse({ limit: MAP_LIST_LIMIT_MAX, cursor }),
      evaluate,
    )
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

export async function getMapAssetDetail(
  db: Db,
  targetId: string,
  objectId: string,
  query: MapListQuery,
) {
  await requireLiveTarget(db, targetId)
  const view = await resolveMapView(db, targetId, query)
  const assets = (await loadViewAssets(db, view)).filter((item) => item.objectId === objectId)
  const primary = assets[0]
  if (!primary) mapNotFound('地图对象不存在')
  const { mapIdentityRevisions } = schemaFor(db)
  const history = await db
    .select()
    .from(mapIdentityRevisions)
    .where(eq(mapIdentityRevisions.targetId, targetId))
    .orderBy(asc(mapIdentityRevisions.revision))
  return mapAssetDetailSchema.parse({
    ...toListItem(targetId, primary),
    implementations: assets.filter(item => item.implementationKey).map(item => ({
      implementationKey: item.implementationKey!,
      descriptorVersion: item.descriptorVersion,
      conditionUnknownFields: item.unknownFields,
      semanticName: item.features?.semanticName,
      role: item.features?.role,
      locale: item.condition?.locale,
      workspace: item.condition?.workspace,
      conditionSnapshot: item.condition,
    })),
    identityHistory: history
      .filter(row => row.revision <= view.identityRevision)
      .filter((row) => {
        const refs = [...(row.oldRefs as Array<Record<string, unknown>>), ...(row.newRefs as Array<Record<string, unknown>>)]
        return refs.some((ref) => ref.objectId === objectId)
      })
      .slice(-100)
      .map((row) => ({
        revision: row.revision,
        action: row.action,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        oldRefs: (row.oldRefs as Array<Record<string, unknown>>).map(({ allocationKey: _key, ...ref }) => mapAssetRefSchema.parse(ref)),
        newRefs: (row.newRefs as Array<Record<string, unknown>>).map(({ allocationKey: _key, ...ref }) => mapAssetRefSchema.parse(ref)),
      })),
    observationCoverage: primary.changeCount > 0 || primary.dimensions.length > 0 ? 'observed' : 'unknown',
    view: await viewMeta(db, view),
  })
}

export async function listMapChanges(db: Db, targetId: string, query: MapListQuery, evaluate?: ConditionEvaluator) {
  await requireLiveTarget(db, targetId)
  const view = await resolveMapView(db, targetId, query)
  const digest = listDigest({
    targetId,
    kind: 'changes',
    projectionId: view.projectionId,
    releaseId: view.releaseId,
    search: query.search,
    lifecycle: query.lifecycle,
    conditionSnapshot: query.conditionSnapshot,
    revision: view.revision,
    governanceRevision: (await viewMeta(db, view)).governanceRevision,
  })
  const assets = filterViewAssets(await loadViewAssets(db, view), query, evaluate)
    .filter((item) => item.changeCount > 0)
    .map((item) => ({
      kind: 'asset' as const,
      assetRefKey: item.assetRefKey,
      changeCount: item.changeCount,
    }))
  const { mapConflicts } = schemaFor(db)
  const conflicts = view.projectionId
    ? (
        await db
          .select()
          .from(mapConflicts)
          .where(and(eq(mapConflicts.targetId, targetId), eq(mapConflicts.projectionId, view.projectionId!), eq(mapConflicts.status, 'open')))
      ).map((row) => ({
        kind: 'conflict' as const,
        conflictKey: row.conflictKey,
        status: row.status,
        payload: row.payload,
        assetRefKey: row.conflictKey,
      }))
    : []
  const page = paginate([...assets, ...conflicts], digest, query)
  return mapChangeListResponseSchema.parse({
    items: page.items.map((item) =>
      item.kind === 'asset'
        ? { kind: 'asset', assetRefKey: item.assetRefKey, changeCount: item.changeCount }
        : { kind: 'conflict', conflictKey: item.conflictKey, status: item.status, payload: item.payload },
    ),
    nextCursor: page.nextCursor,
    view: await viewMeta(db, view),
  })
}

function commandPayload(body: MapGovernancePreviewBody | MapGovernanceCommandBody) {
  return {
    kind: body.kind,
    expectedIdentityRevision: body.expectedIdentityRevision,
    expectedGovernanceRevision: body.expectedGovernanceRevision,
    reason: body.reason,
    assetRef: body.assetRef ?? null,
    payload: body.payload ?? null,
    evidenceRefs: body.evidenceRefs ?? [],
  }
}

export async function previewMapGovernance(
  db: Db,
  targetId: string,
  body: MapGovernancePreviewBody,
  visible: boolean,
) {
  await requireLiveTarget(db, targetId)
  const { mapProjectionHeads, mapScenarioBindings } = schemaFor(db)
  const [head] = await db.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)).limit(1)
  const { mapGovernanceHeads } = schemaFor(db)
  const [gov] = await db.select().from(mapGovernanceHeads).where(eq(mapGovernanceHeads.targetId, targetId)).limit(1)
  const identityRevision = head?.identityRevision ?? 0
  const rejectReasons: string[] = []
  if (body.kind === 'correct_identity' && body.expectedIdentityRevision !== identityRevision) {
    rejectReasons.push('revision_conflict')
  }
  if (body.kind !== 'correct_identity' && body.expectedGovernanceRevision !== (gov?.revision ?? 0)) {
    rejectReasons.push('revision_conflict')
  }
  if (body.kind !== 'correct_identity' && !body.assetRef) rejectReasons.push('asset_ref_required')
  if (body.kind === 'correct_identity' && !body.payload) rejectReasons.push('identity_payload_required')
  try {
    if (body.assetRef) await requireMapAsset(db, targetId, body.assetRef)
    for (const ref of body.payload?.oldRefs ?? []) await requireMapAsset(db, targetId, ref)
    if (body.payload?.newRefs.some(ref => ref.targetId !== targetId)) rejectReasons.push('target_mismatch')
  } catch { rejectReasons.push('asset_not_found') }
  const keys = [
    body.assetRef ? assetKey({ ...body.assetRef, targetId }) : undefined,
    ...(body.payload?.oldRefs ?? []).map((ref) => assetKey(ref)),
    ...(body.payload?.newRefs ?? []).map((ref) => assetKey(ref)),
  ].filter((value): value is string => Boolean(value))
  const bindings = keys.length
    ? await db
        .select()
        .from(mapScenarioBindings)
        .where(and(eq(mapScenarioBindings.targetId, targetId), or(inArray(mapScenarioBindings.assetRefKey, keys), ...((body.payload?.oldRefs ?? []).map(ref => ref.objectId ? eq(mapScenarioBindings.objectId, ref.objectId) : eq(mapScenarioBindings.pageId, ref.pageId!))))!, eq(mapScenarioBindings.status, 'active')))
    : []
  const pending = body.kind === 'correct_identity' && body.payload?.action === 'split' ? bindings.length : 0
  return mapGovernancePreviewResponseSchema.parse({
    baseRevision: body.kind === 'correct_identity' ? identityRevision : (gov?.revision ?? 0),
    kind: body.kind,
    affectedAssetKeys: keys,
    visibleReferenceCount: visible ? bindings.length : 0,
    pendingConfirmationCount: visible ? pending : 0,
    restricted: !visible,
    rejectReasons,
  })
}

export async function applyMapGovernanceCommand(
  db: Db,
  targetId: string,
  body: MapGovernanceCommandBody,
  actor: ExecutionActor,
) {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapAssetGovernance, mapGovernanceCommands, mapProjectionHeads, mapScenarioBindings } = schemaFor(tx)
    await ensureGovernanceHead(tx, targetId)
    const [lockedGov] = await locked(
      tx,
      tx.select().from(mapGovernanceHeadsTable(tx)).where(eq(mapGovernanceHeadsTable(tx).targetId, targetId)),
    )
    const currentGovernanceRevision = lockedGov?.revision ?? 0
    const [existing] = await tx
      .select()
      .from(mapGovernanceCommands)
      .where(and(eq(mapGovernanceCommands.targetId, targetId), eq(mapGovernanceCommands.commandKey, body.idempotencyKey)))
      .limit(1)
    const payload = commandPayload(body)
    if (existing) {
      if (canonicalJson(existing.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return mapGovernanceCommandSchema.parse({
        commandId: existing.id,
        idempotencyKey: existing.commandKey,
        targetId,
        kind: existing.kind,
        status: existing.status,
        expectedRevision: existing.expectedRevision,
        resultRevision: existing.resultRevision ?? undefined,
        reason: existing.reason,
        payload: existing.payload,
        createdAt: existing.createdAt.toISOString(),
      })
    }
    const [head] = await tx.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)).limit(1)
    const identityRevision = head?.identityRevision ?? 0
    if (body.kind === 'correct_identity' && body.expectedIdentityRevision !== identityRevision) {
      mapRevisionConflict('身份治理修订已变更')
    }
    if (body.kind !== 'correct_identity' && body.expectedGovernanceRevision !== currentGovernanceRevision) {
      mapRevisionConflict('治理修订已变更')
    }
    if (body.assetRef) await requireMapAsset(tx, targetId, body.assetRef)
    for (const ref of body.payload?.oldRefs ?? []) await requireMapAsset(tx, targetId, ref)
    const now = await clockNow(tx)
    const commandId = newId()
    try {
      await insertRows(tx, mapGovernanceCommands, {
        id: commandId,
        targetId,
        commandKey: body.idempotencyKey,
        kind: body.kind,
        status: 'applied',
        expectedRevision: body.kind === 'correct_identity' ? (body.expectedIdentityRevision ?? 0) : (body.expectedGovernanceRevision ?? 0),
        resultRevision: body.kind === 'correct_identity' ? identityRevision + 1 : currentGovernanceRevision + 1,
        payload,
        reason: body.reason,
        evidence: body.evidenceRefs ?? [],
        actorId: actor.id,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      if (isUniqueViolation(error)) mapCommandIdempotencyConflict()
      throw error
    }
    if (body.kind === 'correct_identity') {
      if (!body.payload) mapRevisionConflict('身份纠正缺少载荷')
      await applyMapIdentityCommand(tx, {
        targetId,
        expectedIdentityRevision: body.expectedIdentityRevision ?? 0,
        commandKey: body.idempotencyKey,
        action: body.payload.action,
        oldRefs: body.payload.oldRefs,
        newRefs: body.payload.newRefs,
        reason: body.reason,
        evidenceRefs: body.evidenceRefs ?? [],
        actorId: actor.id,
      })
      if (body.payload.action === 'split') {
        const keys = body.payload.oldRefs.map((ref) => assetKey(ref))
        if (keys.length) {
          await tx
            .update(mapScenarioBindings)
            .set({ resolution: 'pending_confirmation', updatedAt: now })
            .where(and(eq(mapScenarioBindings.targetId, targetId), or(inArray(mapScenarioBindings.assetRefKey, keys), ...((body.payload?.oldRefs ?? []).map(ref => ref.objectId ? eq(mapScenarioBindings.objectId, ref.objectId) : eq(mapScenarioBindings.pageId, ref.pageId!))))!, eq(mapScenarioBindings.status, 'active')))
        }
      }
      await startMapProjectionRebuild(tx, { targetId })
    } else {
      const ref = body.assetRef
      if (!ref) mapNotFound('治理对象不存在')
      const key = assetKey(ref)
      const nextRevision = currentGovernanceRevision + 1
      await tx
        .update(mapGovernanceHeadsTable(tx))
        .set({ revision: nextRevision, updatedAt: now })
        .where(eq(mapGovernanceHeadsTable(tx).targetId, targetId))
      if (body.kind === 'restore') {
        await tx.delete(mapAssetGovernance).where(and(eq(mapAssetGovernance.targetId, targetId), eq(mapAssetGovernance.assetRefKey, key)))
      } else {
        const lifecycle = body.kind === 'retire' ? 'RETIRED' : 'TRUSTED'
        const [overlay] = await tx
          .select()
          .from(mapAssetGovernance)
          .where(and(eq(mapAssetGovernance.targetId, targetId), eq(mapAssetGovernance.assetRefKey, key)))
          .limit(1)
        if (overlay) {
          await tx
            .update(mapAssetGovernance)
            .set({ lifecycle, revision: nextRevision, reason: body.reason, actorId: actor.id, commandId, updatedAt: now })
            .where(eq(mapAssetGovernance.id, overlay.id))
        } else {
          await insertRows(tx, mapAssetGovernance, {
            id: newId(),
            targetId,
            assetRefKey: key,
            lifecycle,
            revision: nextRevision,
            reason: body.reason,
            actorId: actor.id,
            commandId,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
    }
    await recordAudit(tx, actor, 'map.governance', 'map', commandId, `${body.kind} ${body.reason}`)
    const [created] = await tx.select().from(mapGovernanceCommands).where(eq(mapGovernanceCommands.id, commandId)).limit(1)
    return mapGovernanceCommandSchema.parse({
      commandId,
      idempotencyKey: body.idempotencyKey,
      targetId,
      kind: body.kind,
      status: 'applied',
      expectedRevision: created!.expectedRevision,
      resultRevision: created!.resultRevision ?? undefined,
      reason: body.reason,
      payload,
      createdAt: now.toISOString(),
    })
  })
}

function mapGovernanceHeadsTable(db: Db) {
  return schemaFor(db).mapGovernanceHeads
}

export async function getMapGovernanceCommand(db: Db, targetId: string, commandId: string) {
  await requireLiveTarget(db, targetId)
  const { mapGovernanceCommands } = schemaFor(db)
  const [row] = await db
    .select()
    .from(mapGovernanceCommands)
    .where(and(eq(mapGovernanceCommands.targetId, targetId), eq(mapGovernanceCommands.id, commandId)))
    .limit(1)
  if (!row) mapNotFound('治理命令不存在')
  return mapGovernanceCommandSchema.parse({
    commandId: row.id,
    idempotencyKey: row.commandKey,
    targetId,
    kind: row.kind,
    status: row.status,
    expectedRevision: row.expectedRevision,
    resultRevision: row.resultRevision ?? undefined,
    reason: row.reason,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  })
}

export async function loadLifecycleOverrides(db: Db, targetId: string) {
  const overlays = await loadOverlays(db, targetId)
  return [...overlays.entries()].map(([assetRefKey, lifecycle]) => ({ assetRefKey, lifecycle }))
}


export async function requestMapProjectionRebuild(db: Db, targetId: string, actor: ExecutionActor) {
  await requireLiveTarget(db, targetId)
  return atomic(db, async tx => {
    const projection = await startMapProjectionRebuild(tx, { targetId })
    await recordAudit(tx, actor, 'map.rebuild', 'map', targetId, '请求重建地图投影')
    return projection
  })
}
