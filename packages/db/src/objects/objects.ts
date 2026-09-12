import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import {
  OBJECT_MISSING_REASONS,
  ObjectStoreError,
  RUNTIME_SCHEMA_VERSION,
  objectContentTypeSchema,
  objectDigestSchema,
  objectKeyFor,
  objectKeySchema,
  type EvidenceMetadata,
  type EvidenceType,
  type PurgeReason,
  type StoredObjectStatus,
} from '@cairn/shared'
import { toEvidenceMetadata } from './evidence-map.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { evidences } from '../schema/execution.js'
import { storedObjects } from '../schema/objects.js'
import { mapPgRestriction } from '../runs/errors.js'

export type StoredObjectRecord = {
  id: string
  objectKey: string
  runId: string
  status: StoredObjectStatus
  contentType: string | null
  byteSize: number | null
  digest: string | null
  retainUntil: Date
  createdAt: Date
  purgeAttempts: number
}

export type PurgeCandidate = {
  id: string
  objectKey: string
  status: Extract<StoredObjectStatus, 'pending' | 'available'>
  retainUntil: Date
  purgeAttempts: number
}

function rethrow(error: unknown): never {
  const mapped = mapPgRestriction(error)
  if (mapped) throw mapped
  throw error
}

export async function reserveStoredObject(
  db: Db,
  input: { runId: string; retainUntil: Date; id?: string },
): Promise<{ id: string; objectKey: string }> {
  const id = input.id ?? newId()
  const objectKey = objectKeyFor(input.runId, id)
  try {
    await db.insert(storedObjects).values({
      id,
      objectKey,
      runId: input.runId,
      status: 'pending',
      retainUntil: input.retainUntil,
    })
  } catch (error) {
    rethrow(error)
  }
  return { id, objectKey }
}

export async function getStoredObjectById(db: Db, id: string): Promise<StoredObjectRecord | null> {
  const [row] = await db.select().from(storedObjects).where(eq(storedObjects.id, id)).limit(1)
  return row ? toRecord(row) : null
}

export async function getStoredObjectByKey(
  db: Db,
  objectKey: string,
): Promise<StoredObjectRecord | null> {
  const key = objectKeySchema.parse(objectKey)
  const [row] = await db.select().from(storedObjects).where(eq(storedObjects.objectKey, key)).limit(1)
  return row ? toRecord(row) : null
}

export async function commitStoredObject(
  db: Db,
  input: {
    id: string
    contentType: string
    byteSize: number
    digest: string
    now?: Date
    pendingTtlSeconds?: number
  },
): Promise<StoredObjectRecord> {
  const now = input.now ?? new Date()
  const contentType = objectContentTypeSchema.parse(input.contentType)
  const digest = objectDigestSchema.parse(input.digest)
  const [row] = await db.select().from(storedObjects).where(eq(storedObjects.id, input.id)).limit(1)
  if (!row || row.status !== 'pending') {
    throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象不是待提交状态，无法提交')
  }
  if (
    input.pendingTtlSeconds !== undefined &&
    row.createdAt.getTime() + input.pendingTtlSeconds * 1000 < now.getTime()
  ) {
    throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '未完成上传已过期，不能再提交')
  }

  const [updated] = await db
    .update(storedObjects)
    .set({
      status: 'available',
      contentType,
      byteSize: input.byteSize,
      digest,
      availableAt: now,
    })
    .where(and(eq(storedObjects.id, input.id), eq(storedObjects.status, 'pending')))
    .returning()
  if (!updated) {
    throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象不是待提交状态，无法提交')
  }
  return toRecord(updated)
}

export async function listPurgeCandidates(
  db: Db,
  input: { now: Date; pendingTtlSeconds: number; limit: number },
): Promise<PurgeCandidate[]> {
  const pendingBefore = new Date(input.now.getTime() - input.pendingTtlSeconds * 1000)
  const rows = await db
    .select()
    .from(storedObjects)
    .where(
      or(
        and(eq(storedObjects.status, 'available'), lt(storedObjects.retainUntil, input.now)),
        and(eq(storedObjects.status, 'pending'), lt(storedObjects.createdAt, pendingBefore)),
      ),
    )
    .orderBy(asc(storedObjects.purgeAttempts), asc(storedObjects.retainUntil))
    .limit(input.limit)

  return rows
    .filter((row): row is typeof row & { status: 'pending' | 'available' } => {
      return row.status === 'pending' || row.status === 'available'
    })
    .map((row) => ({
      id: row.id,
      objectKey: row.objectKey,
      status: row.status,
      retainUntil: row.retainUntil,
      purgeAttempts: row.purgeAttempts,
    }))
}

export async function markStoredObjectPurged(
  db: Db,
  input: {
    id: string
    expectedStatus: 'pending' | 'available'
    reason: PurgeReason
    now?: Date
  },
): Promise<{ updated: boolean }> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(storedObjects)
      .set({
        status: 'purged',
        purgedAt: now,
        purgeReason: input.reason,
      })
      .where(and(eq(storedObjects.id, input.id), eq(storedObjects.status, input.expectedStatus)))
      .returning({ objectKey: storedObjects.objectKey })
    if (!updated) return { updated: false }

    await tx
      .update(evidences)
      .set({
        status: 'missing',
        missingReason: OBJECT_MISSING_REASONS.purged,
      })
      .where(and(eq(evidences.objectKey, updated.objectKey), isNull(evidences.missingReason)))
    return { updated: true }
  })
}

export async function markStoredObjectPurgeFailed(
  db: Db,
  input: { id: string; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date()
  // 单语句自增：两个 Worker 同时清同一行时，读改写会把其中一次失败吞掉，
  // 计数偏小就等于退避失效。
  const [row] = await db
    .update(storedObjects)
    .set({ purgeAttempts: sql`${storedObjects.purgeAttempts} + 1`, lastPurgeErrorAt: now })
    .where(eq(storedObjects.id, input.id))
    .returning({ purgeAttempts: storedObjects.purgeAttempts })
  return row?.purgeAttempts ?? 0
}

export async function recordObjectEvidence(
  db: Db,
  input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    type: EvidenceType
    objectKey: string
  },
): Promise<EvidenceMetadata> {
  const objectKey = objectKeySchema.parse(input.objectKey)
  return db.transaction(async (tx) => {
    const [obj] = await tx
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.objectKey, objectKey))
      .for('update')
    if (!obj || obj.status !== 'available' || !obj.contentType || obj.byteSize == null || !obj.digest) {
      throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '只能把 AVAILABLE 对象挂到证据上')
    }
    if (obj.runId !== input.runId) {
      throw new ObjectStoreError('OBJECT_KEY_INVALID', '对象不属于这次运行')
    }

    const id = newId()
    const createdAt = new Date()
    await tx.insert(evidences).values({
      id,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      type: input.type,
      status: 'available',
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      objectId: obj.id,
      objectKey,
      contentType: obj.contentType,
      byteSize: obj.byteSize,
      digest: obj.digest,
      createdAt,
    })
    const [row] = await tx.select().from(evidences).where(eq(evidences.id, id)).limit(1)
    return toEvidenceMetadata(row!)
  })
}

export async function recordMissingObjectEvidence(
  db: Db,
  input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    type: EvidenceType
    missingReason: string
  },
): Promise<EvidenceMetadata> {
  const id = newId()
  const createdAt = new Date()
  await db.insert(evidences).values({
    id,
    runId: input.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
    type: input.type,
    status: 'missing',
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    missingReason: input.missingReason,
    createdAt,
  })
  const [row] = await db.select().from(evidences).where(eq(evidences.id, id)).limit(1)
  return toEvidenceMetadata(row!)
}

export async function reserveObjectEvidence(
  db: Db,
  input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    type: EvidenceType
    retainUntil: Date
    objectId?: string
  },
): Promise<EvidenceMetadata> {
  return db.transaction(async (tx) => {
    const reserved = await reserveStoredObject(tx as unknown as Db, {
      runId: input.runId,
      retainUntil: input.retainUntil,
      id: input.objectId,
    })
    const id = newId()
    const createdAt = new Date()
    await tx.insert(evidences).values({
      id,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      type: input.type,
      status: 'pending',
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      objectId: reserved.id,
      objectKey: reserved.objectKey,
      uploadAttempts: 0,
      createdAt,
    })
    const [row] = await tx.select().from(evidences).where(eq(evidences.id, id)).limit(1)
    return toEvidenceMetadata(row!)
  })
}

export async function findPendingObjectEvidence(
  db: Db,
  input: { attemptId: string; type: EvidenceType },
): Promise<EvidenceMetadata | null> {
  const [row] = await db
    .select()
    .from(evidences)
    .where(
      and(
        eq(evidences.attemptId, input.attemptId),
        eq(evidences.type, input.type),
        eq(evidences.status, 'pending'),
      ),
    )
    .limit(1)
  return row ? toEvidenceMetadata(row) : null
}

export async function findObjectEvidenceByAttemptType(
  db: Db,
  input: { attemptId: string; type: EvidenceType },
): Promise<EvidenceMetadata | null> {
  const [row] = await db
    .select()
    .from(evidences)
    .where(and(eq(evidences.attemptId, input.attemptId), eq(evidences.type, input.type)))
    .orderBy(asc(evidences.createdAt))
    .limit(1)
  return row ? toEvidenceMetadata(row) : null
}

export async function commitObjectEvidence(
  db: Db,
  input: {
    id: string
    contentType: string
    byteSize: number
    digest: string
  },
): Promise<EvidenceMetadata | null> {
  const contentType = objectContentTypeSchema.parse(input.contentType)
  const digest = objectDigestSchema.parse(input.digest)
  const [updated] = await db
    .update(evidences)
    .set({
      status: 'available',
      contentType,
      byteSize: input.byteSize,
      digest,
      missingReason: null,
    })
    .where(and(eq(evidences.id, input.id), eq(evidences.status, 'pending')))
    .returning()
  return updated ? toEvidenceMetadata(updated) : null
}

export async function markEvidenceMissing(
  db: Db,
  input: { id: string; reason: string },
): Promise<EvidenceMetadata | null> {
  const [updated] = await db
    .update(evidences)
    .set({
      status: 'missing',
      missingReason: input.reason,
    })
    .where(and(eq(evidences.id, input.id), eq(evidences.status, 'pending')))
    .returning()
  return updated ? toEvidenceMetadata(updated) : null
}

export async function bumpEvidenceUploadAttempts(db: Db, id: string): Promise<number> {
  const [row] = await db
    .update(evidences)
    .set({ uploadAttempts: sql`${evidences.uploadAttempts} + 1` })
    .where(eq(evidences.id, id))
    .returning({ uploadAttempts: evidences.uploadAttempts })
  return row?.uploadAttempts ?? 0
}

function toRecord(row: typeof storedObjects.$inferSelect): StoredObjectRecord {
  return {
    id: row.id,
    objectKey: row.objectKey,
    runId: row.runId,
    status: row.status,
    contentType: row.contentType,
    byteSize: row.byteSize,
    digest: row.digest,
    retainUntil: row.retainUntil,
    createdAt: row.createdAt,
    purgeAttempts: row.purgeAttempts,
  }
}
