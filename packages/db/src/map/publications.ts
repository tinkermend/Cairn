import { and, desc, eq } from 'drizzle-orm'
import {
  canonicalJson,
  mapReleaseListResponseSchema,
  mapReleasePublicationSchema,
  mapPublicationBodySchema,
  mapSealPublishBodySchema,
  type MapPublicationBody,
  type MapSealPublishBody,
  type ExecutionActor,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { mapCommandIdempotencyConflict, mapReleaseNotFound, mapRevisionConflict, mapTargetMismatch } from './errors.js'
import { loadLifecycleOverrides } from './governance.js'
import { MAP_ASSETS_POLICY_VERSION } from './projections.js'
import { sealMapReleaseTx } from './releases.js'
import { ensurePublicationHead, requireLiveTarget } from './view.js'

async function publicationCommand(
  db: Db,
  targetId: string,
  body: MapPublicationBody | MapSealPublishBody,
  actor: ExecutionActor,
  action: 'seal' | 'published' | 'withdrawn',
  releaseId?: string,
) {
  const parsed = action === 'seal' ? mapSealPublishBodySchema.parse(body) : mapPublicationBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapPublicationCommands, mapPublicationHeads, mapReleasePublications, mapReleases } = schemaFor(tx)
    await ensurePublicationHead(tx, targetId)
    const [head] = await locked(tx, tx.select().from(mapPublicationHeads).where(eq(mapPublicationHeads.targetId, targetId)))
    const payload = { action, releaseId: releaseId ?? null, body: parsed }
    const [receipt] = await tx.select().from(mapPublicationCommands)
      .where(and(eq(mapPublicationCommands.targetId, targetId), eq(mapPublicationCommands.commandKey, parsed.idempotencyKey))).limit(1)
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return mapReleasePublicationSchema.parse(receipt.result)
    }
    // Reserve earlier seal keys as well; they must never be reused for a different command.
    const [legacy] = await tx.select().from(mapReleasePublications)
      .where(and(eq(mapReleasePublications.targetId, targetId), eq(mapReleasePublications.commandKey, parsed.idempotencyKey))).limit(1)
    if (legacy) mapCommandIdempotencyConflict()
    if (head!.revision !== parsed.expectedPublicationRevision) mapRevisionConflict('发布修订已变更')
    const now = await clockNow(tx)
    if (action === 'seal') {
      const seal = parsed as MapSealPublishBody
      const release = await sealMapReleaseTx(tx, {
        targetId,
        projectionId: seal.projectionId,
        expectedProjectionRevision: seal.expectedProjectionRevision,
        policyVersion: MAP_ASSETS_POLICY_VERSION,
        commandKey: seal.idempotencyKey,
        actorId: actor.id,
        selectedAssetKeys: seal.selectedAssetKeys,
        lifecycleOverrides: await loadLifecycleOverrides(tx, targetId),
      })
      releaseId = release.releaseId
    } else {
      const [release] = await tx.select().from(mapReleases).where(eq(mapReleases.id, releaseId!)).limit(1)
      if (!release) mapReleaseNotFound()
      if (release.targetId !== targetId) mapTargetMismatch()
    }
    const [row] = await tx.select().from(mapReleasePublications).where(eq(mapReleasePublications.releaseId, releaseId!)).limit(1)
    const status = action === 'withdrawn' ? 'withdrawn' : 'published'
    const values = {
      publicationStatus: status as 'published' | 'withdrawn',
      reason: parsed.reason,
      actorId: actor.id,
      publishedAt: status === 'published' ? now : row?.publishedAt ?? null,
      withdrawnAt: status === 'withdrawn' ? now : null,
      updatedAt: now,
    }
    if (row) {
      await tx.update(mapReleasePublications).set(values).where(eq(mapReleasePublications.releaseId, releaseId!))
    } else {
      await tx.insert(mapReleasePublications).values({ releaseId: releaseId!, targetId, commandKey: parsed.idempotencyKey, ...values })
    }
    await tx.update(mapPublicationHeads).set({ revision: head!.revision + 1, updatedAt: now }).where(eq(mapPublicationHeads.targetId, targetId))
    await recordAudit(tx, actor, status === 'withdrawn' ? 'map.withdraw' : 'map.publish', 'map_release', releaseId!, parsed.reason)
    const result = await getMapReleasePublication(tx, targetId, releaseId!)
    await insertRows(tx, mapPublicationCommands, { id: newId(), targetId, commandKey: parsed.idempotencyKey, payload, result, createdAt: now })
    return result
  })
}

export const sealAndPublishMapRelease = (db: Db, targetId: string, body: MapSealPublishBody, actor: ExecutionActor) =>
  publicationCommand(db, targetId, body, actor, 'seal')
export const publishMapRelease = (db: Db, targetId: string, releaseId: string, body: MapPublicationBody, actor: ExecutionActor) =>
  publicationCommand(db, targetId, body, actor, 'published', releaseId)
export const withdrawMapRelease = (db: Db, targetId: string, releaseId: string, body: MapPublicationBody, actor: ExecutionActor) =>
  publicationCommand(db, targetId, body, actor, 'withdrawn', releaseId)

export async function getMapReleasePublication(db: Db, targetId: string, releaseId: string) {
  const { mapPublicationHeads, mapReleasePublications, mapReleases } = schemaFor(db)
  const [release] = await db.select().from(mapReleases).where(eq(mapReleases.id, releaseId)).limit(1)
  if (!release) mapReleaseNotFound()
  if (release.targetId !== targetId) mapTargetMismatch()
  const [publication] = await db
    .select()
    .from(mapReleasePublications)
    .where(eq(mapReleasePublications.releaseId, releaseId))
    .limit(1)
  const [head] = await db.select().from(mapPublicationHeads).where(eq(mapPublicationHeads.targetId, targetId)).limit(1)
  return mapReleasePublicationSchema.parse({
    release: {
      releaseId: release.id,
      targetId: release.targetId,
      projectionId: release.projectionId,
      releaseNo: release.releaseNo,
      policyVersion: release.policyVersion,
      sourceWatermark: release.sourceWatermark,
      manifestDigest: release.manifestDigest,
      createdAt: release.createdAt.toISOString(),
    },
    publicationStatus: publication?.publicationStatus,
    publicationRevision: head?.revision ?? 0,
    reason: publication?.reason,
    publishedAt: publication?.publishedAt?.toISOString(),
    withdrawnAt: publication?.withdrawnAt?.toISOString(),
  })
}

export async function listMapReleases(db: Db, targetId: string, input: { cursor?: string; limit: number }) {
  await requireLiveTarget(db, targetId)
  const { mapPublicationHeads, mapReleasePublications, mapReleases } = schemaFor(db)
  const releases = await db
    .select()
    .from(mapReleases)
    .where(eq(mapReleases.targetId, targetId))
    .orderBy(desc(mapReleases.releaseNo))
  const publications = await db.select().from(mapReleasePublications).where(eq(mapReleasePublications.targetId, targetId))
  const pubByRelease = new Map(publications.map((row) => [row.releaseId, row]))
  const [head] = await db.select().from(mapPublicationHeads).where(eq(mapPublicationHeads.targetId, targetId)).limit(1)
  const items = releases.map((release) => {
    const publication = pubByRelease.get(release.id)
    return {
      release: {
        releaseId: release.id,
        targetId: release.targetId,
        projectionId: release.projectionId,
        releaseNo: release.releaseNo,
        policyVersion: release.policyVersion,
        sourceWatermark: release.sourceWatermark,
        manifestDigest: release.manifestDigest,
        createdAt: release.createdAt.toISOString(),
      },
      publicationStatus: publication?.publicationStatus,
      publicationRevision: head?.revision ?? 0,
      reason: publication?.reason,
      publishedAt: publication?.publishedAt?.toISOString(),
      withdrawnAt: publication?.withdrawnAt?.toISOString(),
      assetRefKey: release.id,
    }
  })
  let start = 0
  if (input.cursor) {
    const index = items.findIndex((item) => item.release.releaseId === input.cursor)
    start = index >= 0 ? index + 1 : items.length
  }
  const page = items.slice(start, start + input.limit + 1)
  const hasMore = page.length > input.limit
  const shown = hasMore ? page.slice(0, input.limit) : page
  return mapReleaseListResponseSchema.parse({
    items: shown.map(({ assetRefKey: _k, ...item }) => item),
    nextCursor: hasMore ? shown.at(-1)!.release.releaseId : undefined,
    publicationRevision: head?.revision ?? 0,
  })
}
