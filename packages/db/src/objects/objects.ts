import type { StoredObjectRow } from '../records.js'
import { atomic, schemaFor } from '../native.js'
import { updateRows, locked } from '../native.js'
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import {
  OBJECT_MISSING_REASONS,
  ObjectStoreError,
  RUNTIME_SCHEMA_VERSION,
  objectContentTypeSchema,
  objectDigestSchema,
  objectKeyFor,
  objectKeySchema,
  capturedSpanMsOf,
  writeEvidenceArtifactKey,
  type EvidenceMetadata,
  type EvidenceType,
  type JsonValue,
  type PurgeReason,
  type StoredObjectStatus,
} from '@cairn/shared'
import { toEvidenceMetadata } from './evidence-map.js'
import { requireLiveRun } from '../lifecycle.js'
import { lockRunRow } from '../leases/leases.js'
import { appendRunEvents } from '../observe/events.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { evidences } from '../schema/execution.js'
import { storedObjects } from '../schema/objects.js'
import { mapRestriction } from '../runs/errors.js'

export type StoredObjectRecord = {
  id: string
  objectKey: string
  runId: string | null
  ownerKind: 'run' | 'artifact'
  artifactId: string | null
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
  deleteRequestedAt?: Date | null
}

function rethrow(error: unknown): never {
  const mapped = mapRestriction(error)
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
    await atomic(db, async (tx) => {
      await requireLiveRun(tx as unknown as Db, input.runId)
      const { storedObjects } = schemaFor(tx)
      await tx.insert(storedObjects).values({
        id,
        objectKey,
        runId: input.runId,
        ownerKind: 'run',
        status: 'pending',
        retainUntil: input.retainUntil,
      })
    })
  } catch (error) {
    rethrow(error)
  }
  return { id, objectKey }
}

export async function getStoredObjectById(db: Db, id: string): Promise<StoredObjectRecord | null> {
  const { storedObjects } = schemaFor(db)
  const [row] = await db.select().from(storedObjects).where(eq(storedObjects.id, id)).limit(1)
  return row ? toRecord(row) : null
}

export async function getStoredObjectByKey(
  db: Db,
  objectKey: string,
): Promise<StoredObjectRecord | null> {
  const { storedObjects } = schemaFor(db)
  const key = objectKeySchema.parse(objectKey)
  const [row] = await db
    .select()
    .from(storedObjects)
    .where(eq(storedObjects.objectKey, key))
    .limit(1)
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
  const { storedObjects } = schemaFor(db)
  const now = input.now ?? new Date()
  const contentType = objectContentTypeSchema.parse(input.contentType)
  const digest = objectDigestSchema.parse(input.digest)
  const [row] = await db.select().from(storedObjects).where(eq(storedObjects.id, input.id)).limit(1)
  if (!row || row.status !== 'pending' || row.deleteRequestedAt) {
    throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象不是待提交状态，无法提交')
  }
  if (
    input.pendingTtlSeconds !== undefined &&
    row.createdAt.getTime() + input.pendingTtlSeconds * 1000 < now.getTime()
  ) {
    throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '未完成上传已过期，不能再提交')
  }

  const [updated] = await updateRows(
    db,
    storedObjects,
    {
      status: 'available',
      contentType,
      byteSize: input.byteSize,
      digest,
      availableAt: now,
    },
    and(eq(storedObjects.id, input.id), eq(storedObjects.status, 'pending')),
  )
  if (!updated) {
    throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象不是待提交状态，无法提交')
  }
  return toRecord(updated)
}

export async function listPurgeCandidates(
  db: Db,
  input: { now: Date; pendingTtlSeconds: number; limit: number },
): Promise<PurgeCandidate[]> {
  const { storedObjects } = schemaFor(db)
  const pendingBefore = new Date(input.now.getTime() - input.pendingTtlSeconds * 1000)
  const rows = await db
    .select()
    .from(storedObjects)
    .where(
      or(
        and(eq(storedObjects.status, 'available'), lt(storedObjects.retainUntil, input.now)),
        and(eq(storedObjects.status, 'pending'), lt(storedObjects.createdAt, pendingBefore)),
        and(
          or(eq(storedObjects.status, 'pending'), eq(storedObjects.status, 'available')),
          isNotNull(storedObjects.deleteRequestedAt),
        ),
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
      deleteRequestedAt: row.deleteRequestedAt,
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
  const { evidences, storedObjects } = schemaFor(db)
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [updated] = await updateRows(
      tx,
      storedObjects,
      {
        status: 'purged',
        purgedAt: now,
        purgeReason: input.reason,
      },
      and(eq(storedObjects.id, input.id), eq(storedObjects.status, input.expectedStatus)),
      { objectKey: storedObjects.objectKey },
    )
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
  const { storedObjects } = schemaFor(db)
  const now = input.now ?? new Date()
  // 单语句自增：两个 Worker 同时清同一行时，读改写会把其中一次失败吞掉，
  // 计数偏小就等于退避失效。
  const [row] = await updateRows(
    db,
    storedObjects,
    { purgeAttempts: sql`${storedObjects.purgeAttempts} + 1`, lastPurgeErrorAt: now },
    eq(storedObjects.id, input.id),
    { purgeAttempts: storedObjects.purgeAttempts },
  )
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
  const { evidences, storedObjects } = schemaFor(db)
  const objectKey = objectKeySchema.parse(input.objectKey)
  return db.transaction(async (tx) => {
    if (!(await lockRunRow(tx as unknown as Db, input.runId))) {
      throw new ObjectStoreError('OBJECT_KEY_INVALID', '运行不存在')
    }
    const [obj] = await locked(
      tx,
      tx.select().from(storedObjects).where(eq(storedObjects.objectKey, objectKey)),
    )
    if (
      !obj ||
      obj.status !== 'available' ||
      !obj.contentType ||
      obj.byteSize == null ||
      !obj.digest
    ) {
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
    await appendRunEvents(tx as unknown as Db, input.runId, [
      {
        type: 'evidence.recorded',
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        payload: { evidenceId: id, type: input.type, status: 'available' },
      },
    ])
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
  const { evidences } = schemaFor(db)
  const id = newId()
  const createdAt = new Date()
  return atomic(db, async (tx) => {
    await lockRunRow(tx, input.runId)
    await tx.insert(evidences).values({
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
    const [row] = await tx.select().from(evidences).where(eq(evidences.id, id)).limit(1)
    await appendRunEvents(tx, input.runId, [
      {
        type: 'evidence.missing',
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        payload: { evidenceId: id, type: input.type, status: 'missing', missingReason: input.missingReason },
      },
    ])
    return toEvidenceMetadata(row!)
  })
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
    artifactKey?: string
  },
): Promise<EvidenceMetadata> {
  const { evidences } = schemaFor(db)
  return db.transaction(async (tx) => {
    if (!(await lockRunRow(tx as unknown as Db, input.runId))) {
      throw new ObjectStoreError('OBJECT_KEY_INVALID', '运行不存在')
    }
    const artifactKey =
      input.artifactKey ??
      writeEvidenceArtifactKey({ type: input.type, attemptId: input.attemptId })
    const [keyed] = await tx
      .select()
      .from(evidences)
      .where(and(eq(evidences.runId, input.runId), eq(evidences.artifactKey, artifactKey)))
      .limit(1)
    if (keyed) return toEvidenceMetadata(keyed)
    if (input.type === 'video' && !input.attemptId && !input.stepRunId) {
      const [existing] = await tx
        .select()
        .from(evidences)
        .where(
          and(
            eq(evidences.runId, input.runId),
            eq(evidences.type, input.type),
            isNull(evidences.attemptId),
            isNull(evidences.stepRunId),
          ),
        )
        .orderBy(asc(evidences.createdAt), asc(evidences.id))
        .limit(1)
      if (existing) return toEvidenceMetadata(existing)
    }
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
      artifactKey,
      status: 'pending',
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      objectId: reserved.id,
      objectKey: reserved.objectKey,
      uploadAttempts: 0,
      createdAt,
    })
    const [row] = await tx.select().from(evidences).where(eq(evidences.id, id)).limit(1)
    await appendRunEvents(tx as unknown as Db, input.runId, [
      {
        type: 'evidence.recorded',
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        payload: { evidenceId: id, type: input.type, status: 'pending' },
      },
    ])
    return toEvidenceMetadata(row!)
  })
}

export async function reopenAvailableRunVideo(
  db: Db,
  input: { runId: string; retainUntil: Date; capturedSpanMs: number },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
  return db.transaction(async (tx) => {
    if (!(await lockRunRow(tx as unknown as Db, input.runId))) {
      throw new ObjectStoreError('OBJECT_KEY_INVALID', '运行不存在')
    }
    const [existing] = await tx
      .select()
      .from(evidences)
      .where(
        and(
          eq(evidences.runId, input.runId),
          eq(evidences.type, 'video'),
          isNull(evidences.attemptId),
          isNull(evidences.stepRunId),
        ),
      )
      .orderBy(asc(evidences.createdAt), asc(evidences.id))
      .limit(1)
    if (!existing) return null
    if (existing.status === 'pending') return toEvidenceMetadata(existing)
    if (existing.status !== 'available') return toEvidenceMetadata(existing)
    if (capturedSpanMsOf(existing.payload) >= input.capturedSpanMs) {
      return toEvidenceMetadata(existing)
    }
    const reserved = await reserveStoredObject(tx as unknown as Db, {
      runId: input.runId,
      retainUntil: input.retainUntil,
    })
    const [updated] = await updateRows(
      tx,
      evidences,
      {
        status: 'pending',
        objectId: reserved.id,
        objectKey: reserved.objectKey,
        contentType: null,
        byteSize: null,
        digest: null,
        payload: null,
        missingReason: null,
        uploadAttempts: 0,
      },
      and(eq(evidences.id, existing.id), eq(evidences.status, 'available')),
    )
    return toEvidenceMetadata(updated ?? existing)
  })
}

export async function findPendingObjectEvidence(
  db: Db,
  input: { attemptId: string; type: EvidenceType },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
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

export async function findObjectEvidenceByArtifactKey(
  db: Db,
  input: { runId: string; artifactKey: string },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
  const [row] = await db
    .select()
    .from(evidences)
    .where(and(eq(evidences.runId, input.runId), eq(evidences.artifactKey, input.artifactKey)))
    .limit(1)
  return row ? toEvidenceMetadata(row) : null
}

export async function findObjectEvidenceByAttemptType(
  db: Db,
  input: { attemptId: string; type: EvidenceType },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
  const [row] = await db
    .select()
    .from(evidences)
    .where(and(eq(evidences.attemptId, input.attemptId), eq(evidences.type, input.type)))
    .orderBy(asc(evidences.createdAt))
    .limit(1)
  return row ? toEvidenceMetadata(row) : null
}

export async function findObjectEvidenceByRunType(
  db: Db,
  input: { runId: string; type: EvidenceType },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
  const [row] = await db
    .select()
    .from(evidences)
    .where(
      and(
        eq(evidences.runId, input.runId),
        eq(evidences.type, input.type),
        isNull(evidences.attemptId),
        isNull(evidences.stepRunId),
      ),
    )
    .orderBy(asc(evidences.createdAt), asc(evidences.id))
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
    payload?: JsonValue
  },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
  const contentType = objectContentTypeSchema.parse(input.contentType)
  const digest = objectDigestSchema.parse(input.digest)
  return atomic(db, async (tx) => {
    const [current] = await tx.select().from(evidences).where(eq(evidences.id, input.id)).limit(1)
    if (!current) return null
    await lockRunRow(tx, current.runId)
    const [updated] = await updateRows(
      tx,
      evidences,
      {
        status: 'available',
        contentType,
        byteSize: input.byteSize,
        digest,
        missingReason: null,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      },
      and(eq(evidences.id, input.id), eq(evidences.status, 'pending')),
    )
    if (!updated) return null
    await appendRunEvents(tx, current.runId, [
      {
        type: 'evidence.recorded',
        stepRunId: current.stepRunId ?? undefined,
        attemptId: current.attemptId ?? undefined,
        payload: { evidenceId: current.id, type: current.type, status: 'available' },
      },
    ])
    return toEvidenceMetadata(updated)
  })
}

export async function markEvidenceMissing(
  db: Db,
  input: { id: string; reason: string },
): Promise<EvidenceMetadata | null> {
  const { evidences } = schemaFor(db)
  return atomic(db, async (tx) => {
    const [current] = await tx.select().from(evidences).where(eq(evidences.id, input.id)).limit(1)
    if (!current) return null
    await lockRunRow(tx, current.runId)
    const [updated] = await updateRows(
      tx,
      evidences,
      {
        status: 'missing',
        missingReason: input.reason,
      },
      and(eq(evidences.id, input.id), eq(evidences.status, 'pending')),
    )
    if (!updated) return null
    await appendRunEvents(tx, current.runId, [
      {
        type: 'evidence.missing',
        stepRunId: current.stepRunId ?? undefined,
        attemptId: current.attemptId ?? undefined,
        payload: { evidenceId: current.id, type: current.type, status: 'missing', missingReason: input.reason },
      },
    ])
    return toEvidenceMetadata(updated)
  })
}

export async function bumpEvidenceUploadAttempts(db: Db, id: string): Promise<number> {
  const { evidences } = schemaFor(db)
  const [row] = await updateRows(
    db,
    evidences,
    { uploadAttempts: sql`${evidences.uploadAttempts} + 1` },
    eq(evidences.id, id),
    { uploadAttempts: evidences.uploadAttempts },
  )
  return row?.uploadAttempts ?? 0
}

function toRecord(row: StoredObjectRow): StoredObjectRecord {
  return {
    id: row.id,
    objectKey: row.objectKey,
    runId: row.runId,
    ownerKind: row.ownerKind ?? 'run',
    artifactId: row.artifactId ?? null,
    status: row.status,
    contentType: row.contentType,
    byteSize: row.byteSize,
    digest: row.digest,
    retainUntil: row.retainUntil,
    createdAt: row.createdAt,
    purgeAttempts: row.purgeAttempts,
  }
}
