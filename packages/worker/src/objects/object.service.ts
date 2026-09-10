import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  commitStoredObject,
  getStoredObjectById,
  getStoredObjectByKey,
  listPurgeCandidates,
  markStoredObjectPurgeFailed,
  markStoredObjectPurged,
  recordMissingObjectEvidence,
  recordObjectEvidence as recordObjectEvidenceRow,
  reserveStoredObject,
  type DbHandle,
} from '@cairn/db'
import {
  OBJECT_MISSING_REASONS,
  ObjectStoreError,
  isObjectStoreError,
  objectContentTypeSchema,
  type EvidenceMetadata,
  type EvidenceType,
} from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { sha256Digest } from '@cairn/storage'
import { DB_HANDLE } from '../db/db.module'

export const OBJECT_STORE = Symbol('OBJECT_STORE')
export const OBJECT_SERVICE_OPTIONS = Symbol('OBJECT_SERVICE_OPTIONS')

export const PURGE_ATTEMPT_WARN_AT = 8

export type ObjectServiceOptions = {
  retainDays: number
  pendingTtlSeconds: number
  maxBytes: number
  now?: () => Date
}

export type PutObjectInput = {
  runId: string
  body: Uint8Array
  contentType: string
  retainUntil?: Date
  objectId?: string
}

@Injectable()
export class ObjectService {
  private readonly logger = new Logger(ObjectService.name)

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(OBJECT_SERVICE_OPTIONS) private readonly options: ObjectServiceOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  async putObject(input: PutObjectInput): Promise<{
    objectId: string
    objectKey: string
    contentType: string
    byteSize: number
    digest: string
  }> {
    const contentType = objectContentTypeSchema.parse(input.contentType)
    if (input.body.byteLength > this.options.maxBytes) {
      throw new ObjectStoreError('OBJECT_TOO_LARGE', `对象超过 ${this.options.maxBytes} 字节上限`)
    }

    const retainUntil =
      input.retainUntil ??
      new Date(this.now().getTime() + this.options.retainDays * 86_400_000)

    const reserved = input.objectId
      ? await this.requirePending(input.objectId, input.runId)
      : await reserveStoredObject(this.handle.db, { runId: input.runId, retainUntil })

    const head = await this.store.put({
      key: reserved.objectKey,
      body: input.body,
      contentType,
    })
    const committed = await commitStoredObject(this.handle.db, {
      id: reserved.id,
      contentType,
      byteSize: head.byteSize,
      digest: head.digest,
      now: this.now(),
      pendingTtlSeconds: this.options.pendingTtlSeconds,
    })
    return {
      objectId: committed.id,
      objectKey: committed.objectKey,
      contentType,
      byteSize: committed.byteSize ?? head.byteSize,
      digest: committed.digest ?? head.digest,
    }
  }

  async getObject(objectKey: string): Promise<{
    head: { key: string; byteSize: number; digest: string }
    contentType: string
    body: Uint8Array
  }> {
    const row = await getStoredObjectByKey(this.handle.db, objectKey)
    if (!row || row.status !== 'available' || !row.contentType || row.digest == null || row.byteSize == null) {
      throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象不可用')
    }
    try {
      const got = await this.store.get(objectKey)
      const digest = sha256Digest(got.body)
      if (digest !== row.digest) {
        throw new ObjectStoreError('OBJECT_DIGEST_MISMATCH', '对象正文与账本摘要不一致')
      }
      return { head: got.head, contentType: row.contentType, body: got.body }
    } catch (error) {
      if (isObjectStoreError(error) && error.code === 'OBJECT_NOT_FOUND') {
        this.logger.warn({ objectKey, runId: row.runId }, '账本 AVAILABLE 但存储已无对象')
      }
      throw error
    }
  }

  async recordObjectEvidence(input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    type: EvidenceType
    objectKey: string
  }): Promise<EvidenceMetadata> {
    return recordObjectEvidenceRow(this.handle.db, input)
  }

  async recordMissingObjectEvidence(input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    type: EvidenceType
    missingReason?: string
  }): Promise<EvidenceMetadata> {
    return recordMissingObjectEvidence(this.handle.db, {
      ...input,
      missingReason: input.missingReason ?? OBJECT_MISSING_REASONS.storeUnavailable,
    })
  }

  async putObjectEvidence(input: PutObjectInput & {
    type: EvidenceType
    stepRunId?: string
    attemptId?: string
  }): Promise<EvidenceMetadata> {
    try {
      const put = await this.putObject(input)
      return await this.recordObjectEvidence({
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        type: input.type,
        objectKey: put.objectKey,
      })
    } catch (error) {
      if (!isObjectStoreError(error) || error.code !== 'OBJECT_NOT_AVAILABLE') {
        await this.recordMissingObjectEvidence({
          runId: input.runId,
          stepRunId: input.stepRunId,
          attemptId: input.attemptId,
          type: input.type,
          missingReason: OBJECT_MISSING_REASONS.storeUnavailable,
        })
      }
      throw error
    }
  }

  async purgeExpiredObjects(input: { limit?: number } = {}): Promise<{ purged: number }> {
    const limit = input.limit ?? 100
    const now = this.now()
    const candidates = await listPurgeCandidates(this.handle.db, {
      now,
      pendingTtlSeconds: this.options.pendingTtlSeconds,
      limit,
    })
    let purged = 0
    for (const candidate of candidates) {
      try {
        await this.store.delete(candidate.objectKey)
        const marked = await markStoredObjectPurged(this.handle.db, {
          id: candidate.id,
          expectedStatus: candidate.status,
          reason: candidate.status === 'pending' ? 'upload_incomplete' : 'expired',
          now,
        })
        if (marked.updated) purged += 1
      } catch (error) {
        const attempts = await markStoredObjectPurgeFailed(this.handle.db, { id: candidate.id, now })
        const message = error instanceof Error ? error.message : String(error)
        if (attempts >= PURGE_ATTEMPT_WARN_AT) {
          this.logger.warn(
            { objectKey: candidate.objectKey, purgeAttempts: attempts },
            `对象删除持续失败：${message}`,
          )
        }
      }
    }
    return { purged }
  }

  private async requirePending(
    objectId: string,
    runId: string,
  ): Promise<{ id: string; objectKey: string }> {
    const row = await getStoredObjectById(this.handle.db, objectId)
    if (!row || row.runId !== runId || row.status !== 'pending') {
      throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '只能重试未提交的对象')
    }
    return { id: row.id, objectKey: row.objectKey }
  }
}
