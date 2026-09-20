import { and, asc, eq, inArray, isNotNull, lte, ne, or } from 'drizzle-orm'
import { entityIdSchema } from '@cairn/shared'
import type { Db } from '../client.js'
import { locked, schemaFor } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'
import { lockConsoleAuthorization } from '../console/target-authorization.js'
import { assertDemonstrationOwner } from './demonstrations.js'

export const RECORDING_UPLOAD_DEADLINE_MS = 60_000

export async function reserveRecordingArtifactUpload(
  db: Db,
  input: { recordingId: string; artifactId: string; generationId: string },
  actorId: string,
) {
  entityIdSchema.parse(input.generationId)
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingArtifacts: artifacts, recordingArtifactUploads: uploads } = schemaFor(tx)
    await lockConsoleAuthorization(tx, actorId)
    await assertDemonstrationOwner(tx, input.recordingId, actorId, true)
    const [artifact] = await locked(
      tx,
      tx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, input.artifactId),
            eq(artifacts.recordingDraftId, input.recordingId),
          ),
        )
        .limit(1),
    )
    if (!artifact) throw notFound('RECORDING_ARTIFACT_NOT_FOUND', '录制附件不存在')
    if (
      artifact.expiresAt.getTime() <= Date.now() ||
      ['deleting', 'purged'].includes(artifact.status)
    )
      throw conflict('RECORDING_ARTIFACT_EXPIRED', '录制附件已到期或清理')
    const [previous] = await tx
      .select()
      .from(uploads)
      .where(eq(uploads.id, input.generationId))
      .limit(1)
    if (previous) {
      if (
        previous.artifactId !== artifact.id ||
        previous.id !== artifact.generationId ||
        !['pending', 'committed'].includes(previous.status) ||
        (previous.status === 'pending' && previous.deadlineAt.getTime() <= Date.now())
      )
        throw conflict('RECORDING_UPLOAD_STALE', '上传代次已失效')
      return {
        ...previous,
        manifest: artifact.manifest,
        alreadyAvailable: previous.status === 'committed',
      }
    }
    if (artifact.status === 'available')
      throw conflict('RECORDING_ARTIFACT_IMMUTABLE', '已提交附件不可覆盖')
    const now = new Date()
    if (artifact.generationId)
      await tx
        .update(uploads)
        .set({ status: 'deleting', nextSweepAt: now, updatedAt: now })
        .where(eq(uploads.id, artifact.generationId))
    const upload = {
      id: input.generationId,
      artifactId: artifact.id,
      objectKey: `recordings/${input.recordingId}/${artifact.id}/${input.generationId}`,
      status: 'pending' as const,
      deadlineAt: new Date(now.getTime() + RECORDING_UPLOAD_DEADLINE_MS),
      nextSweepAt: new Date(now.getTime() + RECORDING_UPLOAD_DEADLINE_MS),
      sweepCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await tx.insert(uploads).values(upload)
    await tx
      .update(artifacts)
      .set({ generationId: upload.id, status: 'pending', updatedAt: now })
      .where(eq(artifacts.id, artifact.id))
    return { ...upload, manifest: artifact.manifest, alreadyAvailable: false }
  })
}

export async function commitRecordingArtifactUpload(
  db: Db,
  input: {
    recordingId: string
    artifactId: string
    generationId: string
    digest: string
    byteSize: number
  },
  actorId: string,
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingArtifacts: artifacts, recordingArtifactUploads: uploads } = schemaFor(tx)
    await lockConsoleAuthorization(tx, actorId)
    await assertDemonstrationOwner(tx, input.recordingId, actorId, true)
    const [artifact] = await locked(
      tx,
      tx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, input.artifactId),
            eq(artifacts.recordingDraftId, input.recordingId),
          ),
        )
        .limit(1),
    )
    const [upload] = await locked(
      tx,
      tx.select().from(uploads).where(eq(uploads.id, input.generationId)).limit(1),
    )
    if (
      !artifact ||
      !upload ||
      artifact.generationId !== upload.id ||
      upload.artifactId !== artifact.id
    )
      return false
    if (artifact.manifest.digest !== input.digest || artifact.manifest.byteSize !== input.byteSize)
      throw conflict('RECORDING_ARTIFACT_DIGEST_MISMATCH', '附件内容与确认的清单不一致')
    if (artifact.status === 'available' && upload.status === 'committed') return true
    const now = new Date()
    if (
      artifact.status !== 'pending' ||
      upload.status !== 'pending' ||
      upload.deadlineAt <= now ||
      artifact.expiresAt <= now
    )
      return false
    await tx
      .update(uploads)
      .set({ status: 'committed', updatedAt: now })
      .where(eq(uploads.id, upload.id))
    await tx
      .update(artifacts)
      .set({
        status: 'available',
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        updatedAt: now,
      })
      .where(eq(artifacts.id, artifact.id))
    return true
  })
}

export async function abandonRecordingArtifactUpload(db: Db, generationId: string) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingArtifactUploads: uploads } = schemaFor(tx)
    const [upload] = await locked(
      tx,
      tx.select().from(uploads).where(eq(uploads.id, generationId)).limit(1),
    )
    if (!upload || upload.status === 'committed') return false
    await tx
      .update(uploads)
      .set({ status: 'deleting', nextSweepAt: new Date(), updatedAt: new Date() })
      .where(eq(uploads.id, generationId))
    return true
  })
}

export async function readRecordingArtifact(
  db: Db,
  recordingId: string,
  artifactId: string,
  actorId: string,
) {
  await assertDemonstrationOwner(db, recordingId, actorId)
  const { recordingArtifacts: artifacts, recordingArtifactUploads: uploads } = schemaFor(db)
  const [row] = await db
    .select({ artifact: artifacts, upload: uploads })
    .from(artifacts)
    .innerJoin(uploads, eq(uploads.id, artifacts.generationId))
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.recordingDraftId, recordingId),
        eq(artifacts.status, 'available'),
        eq(uploads.status, 'committed'),
      ),
    )
    .limit(1)
  if (!row || row.artifact.expiresAt.getTime() <= Date.now())
    throw notFound('RECORDING_ARTIFACT_NOT_AVAILABLE', '附件未上传、缺失或已到期')
  return { objectKey: row.upload.objectKey, manifest: row.artifact.manifest }
}

/** Claim a bounded cleanup batch. Generations remain tombstones and are re-swept after deletion. */
export async function claimRecordingArtifactCleanup(
  db: Db,
  input: { now?: Date; limit?: number } = {},
) {
  const now = input.now ?? new Date()
  const limit = Math.min(20, Math.max(1, input.limit ?? 10))
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const {
      recordingArtifacts: artifacts,
      recordingArtifactUploads: uploads,
      recordingDrafts: drafts,
    } = schemaFor(tx)
    const expired = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(drafts, eq(drafts.id, artifacts.recordingDraftId))
      .where(
        and(
          inArray(artifacts.status, ['pending', 'available', 'missing']),
          or(lte(artifacts.expiresAt, now), isNotNull(drafts.deletedAt)),
        ),
      )
      .orderBy(asc(artifacts.expiresAt))
      .limit(limit)
    for (const item of expired) {
      await tx
        .update(artifacts)
        .set({ status: 'deleting', updatedAt: now })
        .where(eq(artifacts.id, item.id))
      await tx
        .update(uploads)
        .set({ status: 'deleting', nextSweepAt: now, updatedAt: now })
        .where(and(eq(uploads.artifactId, item.id), ne(uploads.status, 'purged')))
      const [anyUpload] = await tx
        .select({ id: uploads.id })
        .from(uploads)
        .where(eq(uploads.artifactId, item.id))
        .limit(1)
      if (!anyUpload)
        await tx
          .update(artifacts)
          .set({ status: 'purged', updatedAt: now })
          .where(eq(artifacts.id, item.id))
    }
    const candidates = await locked(
      tx,
      tx
        .select()
        .from(uploads)
        .where(
          and(
            or(
              inArray(uploads.status, ['deleting', 'purged']),
              and(eq(uploads.status, 'pending'), lte(uploads.deadlineAt, now)),
            ),
            lte(uploads.nextSweepAt, now),
          ),
        )
        .orderBy(asc(uploads.nextSweepAt))
        .limit(limit),
      true,
    )
    for (const item of candidates) {
      await tx
        .update(uploads)
        .set({ status: 'deleting', nextSweepAt: new Date(now.getTime() + 60_000), updatedAt: now })
        .where(eq(uploads.id, item.id))
      await tx
        .update(artifacts)
        .set({ status: 'deleting', updatedAt: now })
        .where(and(eq(artifacts.id, item.artifactId), eq(artifacts.generationId, item.id)))
    }
    return candidates.map((item) => ({ id: item.id, objectKey: item.objectKey }))
  })
}

export async function settleRecordingArtifactCleanup(
  db: Db,
  generationId: string,
  now = new Date(),
) {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db
    const { recordingArtifacts: artifacts, recordingArtifactUploads: uploads } = schemaFor(tx)
    const [upload] = await locked(
      tx,
      tx.select().from(uploads).where(eq(uploads.id, generationId)).limit(1),
    )
    if (!upload || !['deleting', 'purged'].includes(upload.status)) return
    const count = upload.sweepCount + 1
    // Re-sweep quickly around the maximum upload window; retain daily tombstones for delayed storage writes.
    await tx
      .update(uploads)
      .set({
        status: 'purged',
        sweepCount: count,
        nextSweepAt: new Date(now.getTime() + (count < 3 ? 60_000 : 86_400_000)),
        updatedAt: now,
      })
      .where(eq(uploads.id, generationId))
    await tx
      .update(artifacts)
      .set({ status: 'purged', updatedAt: now })
      .where(
        and(
          eq(artifacts.id, upload.artifactId),
          eq(artifacts.generationId, upload.id),
          eq(artifacts.status, 'deleting'),
        ),
      )
  })
}
