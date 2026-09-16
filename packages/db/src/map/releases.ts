import { and, eq, sql } from 'drizzle-orm'
import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  canonicalJson,
  deriveMapEvidenceAvailability,
  mapConditionSnapshotSchema,
  mapDescriptorFeaturesSchema,
  mapAssetRefSchema,
  mapQueryViewSchema,
  mapReleaseManifestSchema,
  mapReleaseSchema,
  mapSealReleaseInputSchema,
  type MapQueryRequest,
  type MapQueryView,
  type MapRelease,
  type MapSealReleaseInput,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { isUniqueViolation } from '../runs/errors.js'
import {
  mapProjectionNotFound,
  mapQueryViewConflict,
  mapReleaseNotFound,
  mapSealConflict,
  mapTargetMismatch,
} from './errors.js'
import { loadOverlays, resolveAssetOverlay } from './view.js'
import { mapProjectionTestHooks } from './projections.js'

export async function sealMapReleaseTx(tx: Db, input: MapSealReleaseInput): Promise<MapRelease> {
  const command = mapSealReleaseInputSchema.parse(input)
  const { mapPages, mapObjectDescriptors, mapProjectionAssets, mapProjections, mapReleaseItems, mapReleases } = schemaFor(tx)
  const [projection] = await locked(
    tx,
    tx.select().from(mapProjections).where(eq(mapProjections.id, command.projectionId)),
  )
  if (!projection) mapProjectionNotFound()
  if (projection.targetId !== command.targetId) mapTargetMismatch()
  const [existing] = await tx
    .select()
    .from(mapReleases)
    .where(and(eq(mapReleases.targetId, command.targetId), eq(mapReleases.commandKey, command.commandKey)))
    .limit(1)
  if (existing) {
    return mapReleaseSchema.parse({
      releaseId: existing.id,
      targetId: existing.targetId,
      projectionId: existing.projectionId,
      releaseNo: existing.releaseNo,
      policyVersion: existing.policyVersion,
      sourceWatermark: existing.sourceWatermark,
      manifestDigest: existing.manifestDigest,
      createdAt: existing.createdAt.toISOString(),
    })
  }
  const caughtUp =
    projection.status === 'ready' ||
    (projection.status === 'active' && projection.cursor > 0 && projection.revision === command.expectedProjectionRevision)
  if (!caughtUp || projection.revision !== command.expectedProjectionRevision) {
    mapSealConflict('投影未就绪或修订不匹配，不能封存')
  }
  const assets = await tx
    .select()
    .from(mapProjectionAssets)
    .where(eq(mapProjectionAssets.projectionId, projection.id))
  const selected = command.selectedAssetKeys
    ? assets.filter((asset) => command.selectedAssetKeys!.includes(asset.assetRefKey))
    : assets
  const pages = await tx.select().from(mapPages).where(eq(mapPages.targetId, projection.targetId))
  const pageById = new Map(pages.map((page) => [page.id, page]))
  if (command.selectedAssetKeys?.some(key => !assets.some(asset => asset.assetRefKey === key))) mapSealConflict('选中的资产不属于该投影')
  const descriptors = await tx.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.targetId, command.targetId))
  const overrides = new Map(command.lifecycleOverrides?.map(item => [item.assetRefKey, item.lifecycle]))
  const items = selected.map((asset) => {
    const overlay = resolveAssetOverlay(overrides, { targetId: command.targetId, pageId: asset.pageId ?? undefined, objectId: asset.objectId ?? undefined, implementationKey: asset.implementationKey ?? undefined, descriptorVersion: asset.descriptorVersion ?? undefined })
    const descriptor = descriptors.find(row => row.objectId === asset.objectId && row.implementationKey === asset.implementationKey && row.descriptorVersion === asset.descriptorVersion)
    return ({
    assetRefKey: asset.assetRefKey,
    pageId: asset.pageId ?? undefined,
    objectId: asset.objectId ?? undefined,
    implementationKey: asset.implementationKey ?? undefined,
    descriptorVersion: asset.descriptorVersion ?? undefined,
    identityRevision: projection.identityRevision,
    condition: descriptor ? mapConditionSnapshotSchema.parse(descriptor.conditionSnapshot) : undefined,
    features: descriptor ? mapDescriptorFeaturesSchema.parse(descriptor.features) : undefined,
    routeTemplate: pageById.get(asset.pageId ?? '')?.routeTemplate,
    dimensions: asset.dimensions,
    lastVerifiedAt: asset.lastVerifiedAt?.toISOString(),
    sampleCount: asset.sampleCount,
    changeCount: asset.changeCount,
    lifecycle:
      overlay ?? asset.lifecycle,
    executable:
      overlay === 'RETIRED'
        ? false
        : asset.executable === 1,
  })})
  const manifest = mapReleaseManifestSchema.parse({
    protocol: MAP_ASSETS_PROTOCOL,
    algorithmVersion: MAP_IDENTITY_RULE_VERSION,
    targetId: projection.targetId,
    projectionId: projection.id,
    policyVersion: command.policyVersion,
    sourceWatermark: projection.sourceWatermark ?? projection.cursor,
    identityRevision: projection.identityRevision,
    projectionRevision: projection.revision,
    items,
  })
  const manifestDigest = sha256Hex(canonicalJson(manifest))
  const [latest] = await tx
    .select({ releaseNo: sql<number>`coalesce(max(${mapReleases.releaseNo}), 0)` })
    .from(mapReleases)
    .where(eq(mapReleases.targetId, command.targetId))
  const now = await clockNow(tx)
  const releaseId = newId()
  try {
    await insertRows(tx, mapReleases, {
      id: releaseId,
      targetId: command.targetId,
      releaseNo: Number(latest?.releaseNo ?? 0) + 1,
      projectionId: projection.id,
      policyVersion: command.policyVersion,
      sourceWatermark: manifest.sourceWatermark,
      manifestDigest,
      manifest,
      commandKey: command.commandKey,
      sealedAt: now,
      createdAt: now,
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      const [dup] = await tx
        .select()
        .from(mapReleases)
        .where(and(eq(mapReleases.targetId, command.targetId), eq(mapReleases.commandKey, command.commandKey)))
        .limit(1)
      if (dup) {
        return mapReleaseSchema.parse({
          releaseId: dup.id,
          targetId: dup.targetId,
          projectionId: dup.projectionId,
          releaseNo: dup.releaseNo,
          policyVersion: dup.policyVersion,
          sourceWatermark: dup.sourceWatermark,
          manifestDigest: dup.manifestDigest,
          createdAt: dup.createdAt.toISOString(),
        })
      }
    }
    throw error
  }
  if (mapProjectionTestHooks.beforeInsertReleaseItems) await mapProjectionTestHooks.beforeInsertReleaseItems()
  for (const item of items) {
    await insertRows(tx, mapReleaseItems, {
      id: newId(),
      releaseId,
      targetId: command.targetId,
      assetRefKey: item.assetRefKey,
      pageId: item.pageId ?? null,
      objectId: item.objectId ?? null,
      implementationKey: item.implementationKey ?? null,
      descriptorVersion: item.descriptorVersion ?? null,
      identityRevision: item.identityRevision,
      lifecycle: item.lifecycle,
      executable: item.executable ? 1 : 0,
      conditionSnapshot: item.condition ?? null,
      features: item.features ?? null,
    })
  }
  return mapReleaseSchema.parse({
    releaseId,
    targetId: command.targetId,
    projectionId: projection.id,
    releaseNo: Number(latest?.releaseNo ?? 0) + 1,
    policyVersion: command.policyVersion,
    sourceWatermark: manifest.sourceWatermark,
    manifestDigest,
    createdAt: now.toISOString(),
  })
}

export async function sealMapRelease(db: Db, input: MapSealReleaseInput): Promise<MapRelease> {
  return atomic(db, (tx) => sealMapReleaseTx(tx, input))
}

export async function getMapRelease(
  db: Db,
  input: { releaseId: string; targetId?: string; manifestDigest?: string },
): Promise<MapRelease> {
  const { mapReleases } = schemaFor(db)
  const [row] = await db.select().from(mapReleases).where(eq(mapReleases.id, input.releaseId)).limit(1)
  if (!row) mapReleaseNotFound()
  if (input.targetId && row.targetId !== input.targetId) mapTargetMismatch()
  if (input.manifestDigest && row.manifestDigest !== input.manifestDigest) mapReleaseNotFound()
  return mapReleaseSchema.parse({
    releaseId: row.id,
    targetId: row.targetId,
    projectionId: row.projectionId,
    releaseNo: row.releaseNo,
    policyVersion: row.policyVersion,
    sourceWatermark: row.sourceWatermark,
    manifestDigest: row.manifestDigest,
    createdAt: row.createdAt.toISOString(),
  })
}

export async function loadMapQueryView(db: Db, request: MapQueryRequest): Promise<MapQueryView> {
  if (request.view.kind === 'projection' && 'releaseId' in request.view) mapQueryViewConflict()
  const { mapPages, mapProjectionAssets, mapProjections, mapReleaseItems, mapReleases } = schemaFor(db)
  if (request.view.kind === 'release') {
    const [release] = await db.select().from(mapReleases).where(eq(mapReleases.id, request.view.releaseId)).limit(1)
    if (!release) mapReleaseNotFound()
    if (release.targetId !== request.targetId) mapTargetMismatch()
    if (release.manifestDigest !== request.view.manifestDigest) mapReleaseNotFound()
    const manifest = mapReleaseManifestSchema.parse(release.manifest)
    const items = manifest.items
    return mapQueryViewSchema.parse({
      targetId: release.targetId,
      viewRef: { kind: 'release', releaseId: release.id, manifestDigest: release.manifestDigest },
      identityRevision: release.manifest && typeof release.manifest === 'object' && 'identityRevision' in release.manifest
        ? Number(release.manifest.identityRevision)
        : 0,
      assets: items.map((item) => ({
        assetRef: mapAssetRefSchema.parse({
          targetId: release.targetId,
          pageId: item.pageId ?? undefined,
          objectId: item.objectId ?? undefined,
          implementationKey: item.implementationKey ?? undefined,
          descriptorVersion: item.descriptorVersion ?? undefined,
        }),
        assetRefKey: item.assetRefKey,
        lifecycle: item.lifecycle,
        importance: 0,
        executable: item.executable,
        rejectReasons: [],
        dimensions: item.dimensions ?? [],
        lastVerifiedAt: item.lastVerifiedAt,
        sampleCount: item.sampleCount ?? 0,
        changeCount: item.changeCount ?? 0,
        condition: item.condition,
        features: item.features,
        routeTemplate: item.routeTemplate,
        evidenceAvailability: 'available',
      })),
    })
  }
  const [projection] = await db
    .select()
    .from(mapProjections)
    .where(eq(mapProjections.id, request.view.projectionId))
    .limit(1)
  if (!projection) mapProjectionNotFound()
  if (projection.targetId !== request.targetId) mapTargetMismatch()
  const assets = await db
    .select()
    .from(mapProjectionAssets)
    .where(eq(mapProjectionAssets.projectionId, projection.id))
  const pages = await db.select().from(mapPages).where(eq(mapPages.targetId, projection.targetId))
  const pageById = new Map(pages.map((page) => [page.id, page]))
  const { mapObjectDescriptors } = schemaFor(db)
  const descriptors = await db.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.targetId, projection.targetId))
  const overlays = await loadOverlays(db, projection.targetId)
  return mapQueryViewSchema.parse({
    targetId: projection.targetId,
    viewRef: {
      kind: 'projection',
      projectionId: projection.id,
      cursor: projection.cursor,
      revision: projection.revision,
    },
    identityRevision: projection.identityRevision,
    assets: assets.map((item) => {
      const descriptor = descriptors.find(row => row.objectId === item.objectId && row.implementationKey === item.implementationKey && row.descriptorVersion === item.descriptorVersion)
      const overlay = resolveAssetOverlay(overlays, { targetId: projection.targetId, pageId: item.pageId ?? undefined, objectId: item.objectId ?? undefined, implementationKey: item.implementationKey ?? undefined, descriptorVersion: item.descriptorVersion ?? undefined })
      return ({
      assetRef: mapAssetRefSchema.parse({
        targetId: projection.targetId,
        pageId: item.pageId ?? undefined,
        objectId: item.objectId ?? undefined,
        implementationKey: item.implementationKey ?? undefined,
        descriptorVersion: item.descriptorVersion ?? undefined,
      }),
      assetRefKey: item.assetRefKey,
      lifecycle: overlay ?? item.lifecycle,
      importance: item.importance,
      executable: overlay !== 'RETIRED' && item.executable === 1,
      condition: descriptor ? mapConditionSnapshotSchema.parse(descriptor.conditionSnapshot) : undefined,
      features: descriptor ? mapDescriptorFeaturesSchema.parse(descriptor.features) : undefined,
      rejectReasons: item.rejectReasons,
      dimensions: item.dimensions,
      lastVerifiedAt: item.lastVerifiedAt ? item.lastVerifiedAt.toISOString() : undefined,
      sampleCount: item.sampleCount,
      changeCount: item.changeCount,
      routeTemplate: pageById.get(item.pageId ?? '')?.routeTemplate,
      evidenceAvailability: deriveMapEvidenceAvailability({ sealed: false, projectionStatus: projection.status, rebuildCompleteness: projection.rebuildCompleteness, lastVerifiedAt: item.lastVerifiedAt?.toISOString(), changeCount: item.changeCount, hasDimensions: item.dimensions.length > 0 }),
    })}),
  })
}
