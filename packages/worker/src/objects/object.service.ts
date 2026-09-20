import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  bumpEvidenceUploadAttempts,
  claimRecordingArtifactCleanup,
  settleRecordingArtifactCleanup,
  commitObjectEvidence,
  commitStoredObject,
  findObjectEvidenceByAttemptType,
  findObjectEvidenceByArtifactKey,
  findObjectEvidenceByRunType,
  getStoredObjectById,
  getStoredObjectByKey,
  listPurgeCandidates,
  markEvidenceMissing,
  markStoredObjectPurgeFailed,
  markStoredObjectPurged,
  recordMissingObjectEvidence,
  recordObjectEvidence as recordObjectEvidenceRow,
  reserveObjectEvidence,
  reopenAvailableRunVideo,
  reserveStoredObject,
  settleExpiredPendingEvidence,
  type DbHandle,
} from '@cairn/db'
import {
  OBJECT_MISSING_REASONS,
  ObjectStoreError,
  capturedSpanMsOf,
  isObjectStoreError,
  objectContentTypeSchema,
  DEFAULT_TRACE_RETAIN_DAYS,
  DEFAULT_VIDEO_RETAIN_DAYS,
  type EvidenceMetadata,
  type EvidenceType,
  type JsonValue,
} from '@cairn/shared'
import type { ObjectStore, ObjectStoreProbeResult } from '@cairn/storage'
import { DB_HANDLE } from '../db/db.module'

export const OBJECT_STORE = Symbol('OBJECT_STORE')
export const OBJECT_SERVICE_OPTIONS = Symbol('OBJECT_SERVICE_OPTIONS')

export const PURGE_ATTEMPT_WARN_AT = 8

export type ObjectServiceOptions = {
  retainDays: number
  pendingTtlSeconds: number
  maxBytes: number
  traceMaxBytes?: number
  videoMaxBytes?: number
  uploadMaxAttempts?: number
  /** 进程内补传退避。生产默认 200ms；测试置 0。 */
  uploadBackoffMs?: number
  /** 仅测试：`putObject` 已成功、尚未 `commitObjectEvidence` 时插入。 */
  afterObjectPut?: () => Promise<void>
  now?: () => Date
}

export type PutObjectInput = {
  runId: string
  body: Uint8Array
  contentType: string
  retainUntil?: Date
  objectId?: string
  maxBytes?: number
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

  videoMaxBytes(): number {
    return this.options.videoMaxBytes ?? this.options.maxBytes
  }

  probeStore(): Promise<ObjectStoreProbeResult> {
    return this.store.probe()
  }

  objectStore(): ObjectStore {
    return this.store
  }

  async putObject(input: PutObjectInput): Promise<{
    objectId: string
    objectKey: string
    contentType: string
    byteSize: number
    digest: string
  }> {
    const contentType = objectContentTypeSchema.parse(input.contentType)
    const limit = input.maxBytes ?? this.options.maxBytes
    if (input.body.byteLength > limit) {
      throw new ObjectStoreError('OBJECT_TOO_LARGE', `对象超过 ${limit} 字节上限`)
    }

    const retainUntil =
      input.retainUntil ??
      new Date(this.now().getTime() + this.options.retainDays * 86_400_000)

    const reserved = input.objectId
      ? await this.requirePending(input.objectId, input.runId)
      : await reserveStoredObject(this.handle, { runId: input.runId, retainUntil })

    const head = await this.store.put({
      key: reserved.objectKey,
      body: input.body,
      contentType,
    })
    const committed = await commitStoredObject(this.handle, {
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
    const row = await getStoredObjectByKey(this.handle, objectKey)
    if (!row || row.status !== 'available' || !row.contentType || row.digest == null || row.byteSize == null) {
      throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象不可用')
    }
    try {
      const got = await this.store.get(objectKey)
      // 适配器读出时已复算过一次，直接用它的结果，别对 32 MiB 再哈希一遍。
      if (got.head.digest !== row.digest) {
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
    return recordObjectEvidenceRow(this.handle, input)
  }

  async recordMissingObjectEvidence(input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    type: EvidenceType
    missingReason?: string
  }): Promise<EvidenceMetadata> {
    return recordMissingObjectEvidence(this.handle, {
      ...input,
      missingReason: input.missingReason ?? OBJECT_MISSING_REASONS.storeUnavailable,
    })
  }

  async putObjectEvidence(input: PutObjectInput & {
    type: EvidenceType
    stepRunId?: string
    attemptId?: string
    artifactKey?: string
    payload?: JsonValue
  }): Promise<EvidenceMetadata> {
    const contentType = objectContentTypeSchema.parse(input.contentType)
    const limit = evidenceByteLimit(input.type, this.options)
    const maxAttempts = this.options.uploadMaxAttempts ?? 3

    let existing = input.artifactKey
      ? await findObjectEvidenceByArtifactKey(this.handle, {
          runId: input.runId,
          artifactKey: input.artifactKey,
        })
      : input.attemptId
      ? await findObjectEvidenceByAttemptType(this.handle, {
          attemptId: input.attemptId,
          type: input.type,
        })
      : input.type === 'video'
        ? await findObjectEvidenceByRunType(this.handle, {
            runId: input.runId,
            type: input.type,
          })
        : null
    if (existing?.status === 'missing') return existing
    if (existing?.status === 'available') {
      const nextSpan = capturedSpanMsOf(input.payload)
      if (input.type !== 'video' || input.attemptId || nextSpan < 0) return existing
      const retainUntil =
        input.retainUntil ??
        new Date(this.now().getTime() + evidenceRetainDays(input.type, this.options) * 86_400_000)
      const reopened = await reopenAvailableRunVideo(this.handle, {
        runId: input.runId,
        retainUntil,
        capturedSpanMs: nextSpan,
      })
      if (!reopened || reopened.status !== 'pending') return reopened ?? existing
      existing = reopened
    }

    const tooLargeReason = evidenceTooLargeReason(input.type)
    if (input.body.byteLength > limit) {
      if (existing?.status === 'pending') {
        await markEvidenceMissing(this.handle, { id: existing.id, reason: tooLargeReason })
      } else {
        await this.recordMissingObjectEvidence({
          runId: input.runId,
          stepRunId: input.stepRunId,
          attemptId: input.attemptId,
          type: input.type,
          missingReason: tooLargeReason,
        })
      }
      throw new ObjectStoreError('OBJECT_TOO_LARGE', `对象超过 ${limit} 字节上限`)
    }

    if (!existing || existing.status !== 'pending') {
      const retainUntil =
        input.retainUntil ??
        new Date(this.now().getTime() + evidenceRetainDays(input.type, this.options) * 86_400_000)
      existing = await reserveObjectEvidence(this.handle, {
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
        type: input.type,
        artifactKey: input.artifactKey,
        retainUntil,
      })
    }

    const backoffMs = this.options.uploadBackoffMs ?? 200
    for (;;) {
      const object = existing.objectKey
        ? await getStoredObjectByKey(this.handle, existing.objectKey)
        : null
      if (!object) {
        throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '待上传对象不存在')
      }

      try {
        if (object.status === 'available') {
          if (object.contentType == null || object.byteSize == null || object.digest == null) {
            throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '对象账本不完整，无法挂证据')
          }
          const committed = await commitObjectEvidence(this.handle, {
            id: existing.id,
            contentType: object.contentType,
            byteSize: object.byteSize,
            digest: object.digest,
            payload: input.payload,
          })
          return committed ?? existing
        }
        if (object.status !== 'pending') {
          throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '待上传对象不可用')
        }

        const put = await this.putObject({
          runId: input.runId,
          body: input.body,
          contentType,
          objectId: object.id,
          retainUntil: input.retainUntil,
          maxBytes: limit,
        })
        if (this.options.afterObjectPut) await this.options.afterObjectPut()
        const committed = await commitObjectEvidence(this.handle, {
          id: existing.id,
          contentType: put.contentType,
          byteSize: put.byteSize,
          digest: put.digest,
          payload: input.payload,
        })
        return committed ?? existing
      } catch (error) {
        const attempts = await bumpEvidenceUploadAttempts(this.handle, existing.id)
        if (attempts >= maxAttempts) {
          const reason = missingReasonFor(error) ?? OBJECT_MISSING_REASONS.storeUnavailable
          await markEvidenceMissing(this.handle, { id: existing.id, reason })
          throw error
        }
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }
      }
    }
  }

  async settleExpiredEvidence(): Promise<{ marked: number }> {
    const result = await settleExpiredPendingEvidence(this.handle, {
      now: this.now(),
      pendingTtlSeconds: this.options.pendingTtlSeconds,
      maxUploadAttempts: this.options.uploadMaxAttempts ?? 3,
    })
    return { marked: result.marked + result.committed }
  }

  async purgeExpiredObjects(input: { limit?: number } = {}): Promise<{ purged: number }> {
    const limit = input.limit ?? 100
    const now = this.now()
    const candidates = await listPurgeCandidates(this.handle, {
      now,
      pendingTtlSeconds: this.options.pendingTtlSeconds,
      limit,
    })
    let purged = 0
    for (const candidate of candidates) {
      try {
        await this.store.delete(candidate.objectKey)
        const reason = candidate.deleteRequestedAt
          ? ('run_deleted' as const)
          : candidate.status === 'pending'
            ? ('upload_incomplete' as const)
            : ('expired' as const)
        const marked = await markStoredObjectPurged(this.handle, {
          id: candidate.id,
          expectedStatus: candidate.status,
          reason,
          now,
        })
        if (marked.updated) purged += 1
      } catch (error) {
        const attempts = await markStoredObjectPurgeFailed(this.handle, { id: candidate.id, now })
        const message = error instanceof Error ? error.message : String(error)
        if (attempts >= PURGE_ATTEMPT_WARN_AT) {
          this.logger.warn(
            { objectKey: candidate.objectKey, purgeAttempts: attempts },
            `对象删除持续失败：${message}`,
          )
        }
      }
    }
    // Independent bounded quota: recording uploads never consume Run evidence cleanup capacity.
    const recordings = await claimRecordingArtifactCleanup(this.handle, { now, limit: 10 })
    for (const candidate of recordings) {
      try {
        await this.store.delete(candidate.objectKey)
        await settleRecordingArtifactCleanup(this.handle, candidate.id, now)
      } catch {
        this.logger.warn({ generationId: candidate.id }, '录制附件清理失败，将按台账重试')
      }
    }
    return { purged }
  }

  private async requirePending(
    objectId: string,
    runId: string,
  ): Promise<{ id: string; objectKey: string }> {
    const row = await getStoredObjectById(this.handle, objectId)
    if (!row || row.runId !== runId || row.status !== 'pending') {
      throw new ObjectStoreError('OBJECT_NOT_AVAILABLE', '只能重试未提交的对象')
    }
    return { id: row.id, objectKey: row.objectKey }
  }
}

/**
 * 写失败证据时该记什么原因。
 * 挂指针阶段的失败不产生缺失证据——对象可能好好地在那儿，只是这条证据没挂上。
 */
function evidenceByteLimit(type: EvidenceType, options: ObjectServiceOptions): number {
  if (type === 'trace') return options.traceMaxBytes ?? options.maxBytes
  if (type === 'video') return options.videoMaxBytes ?? options.maxBytes
  return options.maxBytes
}

function evidenceRetainDays(type: EvidenceType, options: ObjectServiceOptions): number {
  if (type === 'video') return DEFAULT_VIDEO_RETAIN_DAYS
  if (type === 'trace') return DEFAULT_TRACE_RETAIN_DAYS
  return options.retainDays
}

function evidenceTooLargeReason(type: EvidenceType): string {
  if (type === 'trace') return OBJECT_MISSING_REASONS.traceTooLarge
  if (type === 'video') return OBJECT_MISSING_REASONS.videoTooLarge
  return OBJECT_MISSING_REASONS.storeUnavailable
}

function missingReasonFor(error: unknown): string | undefined {
  if (!isObjectStoreError(error)) return OBJECT_MISSING_REASONS.storeUnavailable
  switch (error.code) {
    case 'OBJECT_NOT_AVAILABLE':
    case 'OBJECT_KEY_INVALID':
      return undefined
    default:
      return OBJECT_MISSING_REASONS.storeUnavailable
  }
}
