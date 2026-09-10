import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { S3Sender } from '../s3-store.js'

export class MemoryS3 implements S3Sender {
  readonly objects = new Map<string, { body: Uint8Array; contentType?: string; digest: string }>()
  readonly commands: string[] = []
  failDelete = false
  failNext: Error | undefined

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
    if (command instanceof DeleteObjectCommand) {
      this.commands.push('DeleteObject')
      if (this.failDelete) throw s3Error('InternalError', 500)
      this.objects.delete(command.input.Key ?? '')
      return {}
    }
    throw new Error(`unexpected command ${command?.constructor?.name}`)
  }
}

export function s3Error(name: string, status: number): Error {
  const error = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } }
  error.name = name
  error.$metadata = { httpStatusCode: status }
  return error
}
