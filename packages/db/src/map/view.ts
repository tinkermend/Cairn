import { eq } from 'drizzle-orm'
import {
  canonicalJson,
  mapAssetRefKey,
  mapAssetRefSchema,
  type MapConditionSnapshot,
  type MapLifecycle,
  type MapListQuery,
  type MapOverlayLifecycle,
  type MapViewMeta,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { notFound } from '../runs/errors.js'
import { mapNotFound, mapCursorExpired, mapProjectionNotFound, mapQueryViewConflict, mapReleaseNotFound, mapTargetMismatch } from './errors.js'

export type ResolvedMapView = {
  kind: 'projection' | 'release'
  targetId: string
  projectionId?: string
  releaseId?: string
  manifestDigest?: string
  cursor: number
  revision: number
  identityRevision: number
  sourceWatermark?: number
  policyVersion?: string
  status?: string
  rebuildCompleteness?: string | null
}

export async function requireLiveTarget(db: Db, targetId: string) {
  const { targets } = schemaFor(db)
  const [row] = await db.select().from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!row || row.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  return row
}

async function ensureHead(db: Db, targetId: string, kind: 'governance' | 'publication') {
  return atomic(db, async (tx) => {
    const { targets, mapGovernanceHeads, mapPublicationHeads } = schemaFor(tx)
    await locked(tx, tx.select({ id: targets.id }).from(targets).where(eq(targets.id, targetId)))
    const table = kind === 'governance' ? mapGovernanceHeads : mapPublicationHeads
    const [head] = await tx.select().from(table).where(eq(table.targetId, targetId)).limit(1)
    if (head) return head
    const now = await clockNow(tx)
    await tx.insert(table).values({ targetId, revision: 0, updatedAt: now })
    return { targetId, revision: 0, updatedAt: now }
  })
}

export const ensureGovernanceHead = (db: Db, targetId: string) => ensureHead(db, targetId, 'governance')
export const ensurePublicationHead = (db: Db, targetId: string) => ensureHead(db, targetId, 'publication')

/** Validate identity and descriptor ownership, including refs with an omitted page id. */
export async function requireMapAsset(db: Db, targetId: string, ref: ReturnType<typeof assetRef>) {
  if (ref.targetId !== targetId) mapNotFound()
  const { mapPages, mapObjects, mapImplementations, mapObjectDescriptors } = schemaFor(db)
  if (ref.pageId) {
    const [page] = await db.select().from(mapPages).where(eq(mapPages.id, ref.pageId)).limit(1)
    if (!page || page.targetId !== targetId) mapNotFound()
  }
  if (ref.objectId) {
    const [object] = await db.select().from(mapObjects).where(eq(mapObjects.id, ref.objectId)).limit(1)
    if (!object || object.targetId !== targetId || (ref.pageId && object.pageId !== ref.pageId)) mapNotFound()
    if (ref.implementationKey) {
      const implementations = await db.select().from(mapImplementations).where(eq(mapImplementations.objectId, ref.objectId))
      if (!implementations.some(item => item.implementationKey === ref.implementationKey)) mapNotFound()
    }
    if (ref.descriptorVersion) {
      const descriptors = await db.select().from(mapObjectDescriptors).where(eq(mapObjectDescriptors.objectId, ref.objectId))
      if (!descriptors.some(item => item.implementationKey === ref.implementationKey && item.descriptorVersion === ref.descriptorVersion)) mapNotFound()
    }
  }
}

export async function loadOverlays(db: Db, targetId: string): Promise<Map<string, MapOverlayLifecycle>> {
  const { mapAssetGovernance } = schemaFor(db)
  const rows = await db.select().from(mapAssetGovernance).where(eq(mapAssetGovernance.targetId, targetId))
  return new Map(rows.map((row) => [row.assetRefKey, row.lifecycle]))
}

export async function resolveMapView(
  db: Db,
  targetId: string,
  query: Pick<MapListQuery, 'projectionId' | 'releaseId' | 'manifestDigest'>,
): Promise<ResolvedMapView> {
  if (query.projectionId && query.releaseId) mapQueryViewConflict()
  const { mapProjectionHeads, mapProjections, mapReleases } = schemaFor(db)
  if (query.releaseId) {
    const [release] = await db.select().from(mapReleases).where(eq(mapReleases.id, query.releaseId)).limit(1)
    if (!release) mapReleaseNotFound()
    if (release.targetId !== targetId) mapTargetMismatch()
    if (query.manifestDigest && release.manifestDigest !== query.manifestDigest) mapReleaseNotFound()
    return {
      kind: 'release',
      targetId,
      releaseId: release.id,
      manifestDigest: release.manifestDigest,
      cursor: 0,
      revision: 0,
      identityRevision:
        release.manifest && typeof release.manifest === 'object' && 'identityRevision' in release.manifest
          ? Number(release.manifest.identityRevision)
          : 0,
      sourceWatermark: release.sourceWatermark,
      policyVersion: release.policyVersion,
    }
  }
  const projectionId = query.projectionId
    ? query.projectionId
    : (await db.select().from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)).limit(1))[0]
        ?.currentProjectionId
  if (!projectionId) {
    return {
      kind: 'projection',
      targetId,
      cursor: 0,
      revision: 0,
      identityRevision: 0,
      status: 'missing',
    }
  }
  const [projection] = await db.select().from(mapProjections).where(eq(mapProjections.id, projectionId)).limit(1)
  if (!projection) mapProjectionNotFound()
  if (projection.targetId !== targetId) mapTargetMismatch()
  return {
    kind: 'projection',
    targetId,
    projectionId: projection.id,
    cursor: projection.cursor,
    revision: projection.revision,
    identityRevision: projection.identityRevision,
    sourceWatermark: projection.sourceWatermark ?? projection.cursor,
    policyVersion: projection.policyVersion,
    status: projection.status,
    rebuildCompleteness: projection.rebuildCompleteness,
  }
}

export async function viewMeta(db: Db, view: ResolvedMapView): Promise<MapViewMeta> {
  const { mapGovernanceHeads, mapPublicationHeads } = schemaFor(db)
  const [gov] = await db.select().from(mapGovernanceHeads).where(eq(mapGovernanceHeads.targetId, view.targetId)).limit(1)
  const [pub] = await db.select().from(mapPublicationHeads).where(eq(mapPublicationHeads.targetId, view.targetId)).limit(1)
  const now = await clockNow(db)
  return {
    viewRef:
      view.kind === 'release' && view.releaseId && view.manifestDigest
        ? { kind: 'release', releaseId: view.releaseId, manifestDigest: view.manifestDigest }
        : view.projectionId
          ? {
              kind: 'projection',
              projectionId: view.projectionId,
              cursor: view.cursor,
              revision: view.revision,
            }
          : { kind: 'missing' },
    sourceWatermark: view.sourceWatermark,
    policyVersion: view.policyVersion,
    identityRevision: view.identityRevision,
    governanceRevision: gov?.revision ?? 0,
    publicationRevision: pub?.revision ?? 0,
    computedAt: now.toISOString(),
  }
}

export function listDigest(input: {
  targetId: string
  kind: string
  projectionId?: string
  releaseId?: string
  search?: string
  lifecycle?: string
  conditionSnapshot?: MapConditionSnapshot
  assetRefKey?: string
  revision?: number
  governanceRevision?: number
}): string {
  return sha256Hex(
    canonicalJson({
      targetId: input.targetId,
      kind: input.kind,
      revision: input.revision ?? null,
      governanceRevision: input.governanceRevision ?? null,
      projectionId: input.projectionId ?? null,
      releaseId: input.releaseId ?? null,
      search: input.search ?? null,
      lifecycle: input.lifecycle ?? null,
      conditionSnapshot: input.conditionSnapshot ?? null,
      assetRefKey: input.assetRefKey ?? null,
    }),
  )
}

export function encodeMapCursor(digest: string, sortKey: string): string {
  return Buffer.from(JSON.stringify({ d: digest, k: sortKey }), 'utf8').toString('base64url')
}

export function decodeMapCursor(cursor: string, expectedDigest: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { d?: unknown; k?: unknown }
    if (typeof parsed.d !== 'string' || typeof parsed.k !== 'string' || parsed.d !== expectedDigest) mapCursorExpired()
    return parsed.k
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error
    mapCursorExpired()
  }
}

export function applyOverlay(lifecycle: MapLifecycle, overlay?: MapOverlayLifecycle): MapLifecycle {
  return overlay ?? lifecycle
}

export function assetKey(input: {
  targetId: string
  pageId?: string | null
  objectId?: string | null
  implementationKey?: string | null
  descriptorVersion?: number | null
}): string {
  return mapAssetRefKey({
    pageId: input.pageId ?? undefined,
    objectId: input.objectId ?? undefined,
    implementationKey: input.implementationKey ?? undefined,
    descriptorVersion: input.descriptorVersion ?? undefined,
  })
}

export function assetRef(input: {
  targetId: string
  pageId?: string | null
  objectId?: string | null
  implementationKey?: string | null
  descriptorVersion?: number | null
}) {
  return mapAssetRefSchema.parse({
    targetId: input.targetId,
    pageId: input.pageId ?? undefined,
    objectId: input.objectId ?? undefined,
    implementationKey: input.implementationKey ?? undefined,
    descriptorVersion: input.descriptorVersion ?? undefined,
  })
}

export function resolveAssetOverlay(overlays: Map<string, MapOverlayLifecycle>, ref: ReturnType<typeof assetRef>): MapOverlayLifecycle | undefined {
  return overlays.get(assetKey(ref))
    ?? (ref.objectId ? overlays.get(assetKey({ targetId: ref.targetId, pageId: ref.pageId, objectId: ref.objectId })) : undefined)
    ?? (ref.objectId ? overlays.get(assetKey({ targetId: ref.targetId, objectId: ref.objectId })) : undefined)
    ?? (ref.pageId ? overlays.get(assetKey({ targetId: ref.targetId, pageId: ref.pageId })) : undefined)
}
