import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { ObjectStoreError } from '@cairn/shared'
import { sha256Digest } from './digest.js'
import { requireObjectKey, requireSize } from './keys.js'
import { isNotFound, mapS3Error } from './s3-errors.js'
import type { ObjectHead, ObjectStore, PutObjectInput } from './types.js'

export type S3Sender = {
  send(command: unknown): Promise<unknown>
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

  async get(key: string): Promise<{ head: ObjectHead; body: Uint8Array }> {
    const parsed = requireObjectKey(key)
    try {
      const out = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: parsed }),
      )) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } }
      if (!out.Body?.transformToByteArray) {
        throw new ObjectStoreError('OBJECT_NOT_FOUND', '对象不存在')
      }
      const body = await out.Body.transformToByteArray()
      const digest = sha256Digest(body)
      return { head: { key: parsed, byteSize: body.byteLength, digest }, body }
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error
      throw mapS3Error(error, '对象读取失败')
    }
  }

  async delete(key: string): Promise<void> {
    const parsed = requireObjectKey(key)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: parsed }))
    } catch (error) {
      if (isNotFound(error)) return
      throw mapS3Error(error, '对象删除失败')
    }
  }
}
