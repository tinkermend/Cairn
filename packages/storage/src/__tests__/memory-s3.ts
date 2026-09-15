import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { S3Sender } from '../s3-store.js'

type VersionedObject = {
  versionId: string
  body: Uint8Array
  digest: string
  contentType?: string
  deleteMarker?: boolean
}

export class MemoryS3 implements S3Sender {
  readonly objects = new Map<string, { body: Uint8Array; contentType?: string; digest: string }>()
  readonly versions = new Map<string, VersionedObject[]>()
  readonly commands: string[] = []
  failDelete = false
  failNext: Error | undefined
  versioning: 'Disabled' | 'Enabled' = 'Disabled'
  private nextVersion = 1

  async send(command: unknown): Promise<unknown> {
    if (this.failNext) {
      const error = this.failNext
      this.failNext = undefined
      throw error
    }
    if (command instanceof HeadObjectCommand) {
      this.commands.push('HeadObject')
      const key = command.input.Key ?? ''
      const obj = this.objects.get(key)
      if (!obj) throw s3Error('NotFound', 404)
      return { ContentLength: obj.body.byteLength, Metadata: { digest: obj.digest } }
    }
    if (command instanceof PutObjectCommand) {
      this.commands.push('PutObject')
      const key = command.input.Key ?? ''
      const raw = command.input.Body
      const body = raw instanceof Uint8Array ? raw : new Uint8Array()
      this.objects.set(key, {
        body,
        contentType: command.input.ContentType,
        digest: command.input.Metadata?.digest ?? '',
      })
      return {}
    }
    if (command instanceof GetObjectCommand) {
      this.commands.push('GetObject')
      const key = command.input.Key ?? ''
      const obj = this.objects.get(key)
      if (!obj) throw s3Error('NoSuchKey', 404)
      return {
        Body: {
          transformToByteArray: async () => obj.body,
        },
      }
    }
    if (command instanceof GetBucketVersioningCommand) {
      this.commands.push('GetBucketVersioning')
      return this.versioning === 'Enabled' ? { Status: 'Enabled' } : {}
    }
    if (command instanceof ListObjectVersionsCommand) {
      this.commands.push('ListObjectVersions')
      const prefix = command.input.Prefix ?? ''
      const versions: { Key: string; VersionId: string }[] = []
      const deleteMarkers: { Key: string; VersionId: string }[] = []
      for (const [key, items] of this.versions) {
        if (!key.startsWith(prefix)) continue
        for (const item of items) {
          if (item.deleteMarker) deleteMarkers.push({ Key: key, VersionId: item.versionId })
          else versions.push({ Key: key, VersionId: item.versionId })
        }
      }
      return { Versions: versions, DeleteMarkers: deleteMarkers }
    }
    if (command instanceof DeleteObjectCommand) {
      this.commands.push('DeleteObject')
      if (this.failDelete) throw s3Error('InternalError', 500)
      const key = command.input.Key ?? ''
      const versionId = command.input.VersionId
      if (this.versioning === 'Enabled') {
        const items = this.versions.get(key) ?? []
        if (versionId) {
          this.versions.set(
            key,
            items.filter((item) => item.versionId !== versionId),
          )
          if ((this.versions.get(key) ?? []).length === 0) {
            this.versions.delete(key)
            this.objects.delete(key)
          }
          return {}
        }
        items.push({
          versionId: `v${this.nextVersion++}`,
          body: new Uint8Array(),
          digest: '',
          deleteMarker: true,
        })
        this.versions.set(key, items)
        return {}
      }
      this.objects.delete(key)
      return {}
    }
    throw new Error(`unexpected command ${command?.constructor?.name}`)
  }

  putVersioned(key: string, body: Uint8Array, digest: string) {
    const items = this.versions.get(key) ?? []
    items.push({ versionId: `v${this.nextVersion++}`, body, digest })
    this.versions.set(key, items)
    this.objects.set(key, { body, digest })
  }
}

export function s3Error(name: string, status: number): Error {
  const error = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } }
  error.name = name
  error.$metadata = { httpStatusCode: status }
  return error
}
