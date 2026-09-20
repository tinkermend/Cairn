import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { ObjectStoreError } from '@cairn/shared'
import { createReadStream } from 'node:fs'
import { inspectUpload } from './file-upload.js'
import { sha256Digest } from './digest.js'
import { requireObjectKey, requireSize } from './keys.js'
import { isNotFound, mapS3Error } from './s3-errors.js'
import { probeObjectStore } from './probe.js'
import type {
  ObjectGetOptions,
  ObjectGetResult,
  ObjectHead,
  ObjectStore,
  ObjectStoreProbeResult,
  PutObjectInput,
} from './types.js'

export type S3Sender = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
    private readonly maxBytes: number,
  ) {}

  async put(input: PutObjectInput): Promise<ObjectHead> {
    const key = requireObjectKey(input.key)
    requireSize(input.body, this.maxBytes)
    const digest = sha256Digest(input.body)

    try {
      const head = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as { Metadata?: { digest?: string }; ContentLength?: number }
      const existing = head.Metadata?.digest
      if (existing === digest) {
        return { key, byteSize: Number(head.ContentLength ?? input.body.byteLength), digest }
      }
      throw new ObjectStoreError('OBJECT_KEY_CONFLICT', '同键对象正文不一致，拒绝覆盖')
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      if (!isNotFound(error)) throw mapS3Error(error, '对象存储不可用')
    }

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
          Metadata: { digest },
        }),
      )
    } catch (error) {
      throw mapS3Error(error, '对象写入失败')
    }
    return { key, byteSize: input.body.byteLength, digest }
  }

  async get(key: string, options?: ObjectGetOptions): Promise<ObjectGetResult> {
    const parsed = requireObjectKey(key)
    try {
      const range =
        options && (options.start != null || options.end != null)
          ? `bytes=${options.start ?? 0}-${options.end ?? ''}`
          : undefined
      const out = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: parsed, Range: range }),
      )) as {
        Body?: { transformToByteArray?: () => Promise<Uint8Array>; destroy?: () => void }
        ContentLength?: number
        ContentRange?: string
      }
      if (!out.Body?.transformToByteArray) {
        throw new ObjectStoreError('OBJECT_NOT_FOUND', '对象不存在')
      }
      if (range && options?.end != null && out.ContentLength != null && out.ContentLength > options.end - (options.start ?? 0) + 1) {
        out.Body.destroy?.()
        throw new ObjectStoreError('OBJECT_TOO_LARGE', '对象存储未遵守有界范围读取')
      }
      const body = await out.Body.transformToByteArray()
      const parsedRange = out.ContentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
      if (parsedRange) {
        return {
          head: { key: parsed, byteSize: Number(parsedRange[3]), digest: '' },
          body,
          range: { start: Number(parsedRange[1]), end: Number(parsedRange[2]), size: Number(parsedRange[3]) },
        }
      }
      const digest = sha256Digest(body)
      return { head: { key: parsed, byteSize: body.byteLength, digest }, body }
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw mapS3Error(error, '对象读取失败')
    }
  }

  async putFile(input: { key: string; path: string; contentType: string; maxBytes: number; signal?: AbortSignal }): Promise<ObjectHead> {
    const key = requireObjectKey(input.key)
    const head = await inspectUpload(input.path, input.maxBytes, input.signal)
    try {
      const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: input.signal }) as { Metadata?: { digest?: string }; ContentLength?: number }
      if (existing.Metadata?.digest !== head.digest) throw new ObjectStoreError('OBJECT_KEY_CONFLICT', '同键对象正文不一致，拒绝覆盖')
      return { key, ...head }
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      if (!isNotFound(error)) throw mapS3Error(error, '对象存储不可用')
    }
    const stream = createReadStream(input.path, { signal: input.signal })
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: stream, ContentLength: head.byteSize, ContentType: input.contentType, Metadata: { digest: head.digest }, IfNoneMatch: '*' }), { abortSignal: input.signal })
      return { key, ...head }
    } catch (error) {
      input.signal?.throwIfAborted()
      try {
        const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: input.signal }) as { Metadata?: { digest?: string } }
        if (existing.Metadata?.digest === head.digest) return { key, ...head }
      } catch { /* The original upload error remains authoritative. */ }
      throw mapS3Error(error, '派生文件上传失败')
    } finally { stream.destroy() }
  }

  probe(): Promise<ObjectStoreProbeResult> {
    return probeObjectStore(this)
  }

  async delete(key: string): Promise<void> {
    const parsed = requireObjectKey(key)
    try {
      const versioning = (await this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket }),
      )) as { Status?: string }
      if (versioning.Status === 'Enabled' || versioning.Status === 'Suspended') {
        const listed = (await this.client.send(
          new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: parsed }),
        )) as {
          Versions?: { Key?: string; VersionId?: string }[]
          DeleteMarkers?: { Key?: string; VersionId?: string }[]
        }
        const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].filter(
          (item) => item.Key === parsed && item.VersionId,
        )
        if (versions.length === 0) return
        for (const item of versions) {
          await this.client.send(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: parsed,
              VersionId: item.VersionId,
            }),
          )
        }
        return
      }
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: parsed }))
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      if (isNotFound(error)) return
      throw mapS3Error(error, '对象删除失败')
    }
  }
}
