import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ObjectStoreError } from '@cairn/shared'
import { sha256Digest } from './digest.js'
import { requireObjectKey, requireSize } from './keys.js'
import type { ObjectHead, ObjectStore, PutObjectInput } from './types.js'

export class LocalObjectStore implements ObjectStore {
  private resolvedRoot: string | undefined

  constructor(
    private readonly configuredRoot: string,
    private readonly maxBytes: number,
  ) {}

  async put(input: PutObjectInput): Promise<ObjectHead> {
    const key = requireObjectKey(input.key)
    requireSize(input.body, this.maxBytes)
    const digest = sha256Digest(input.body)
    const dest = await this.resolveKeyPath(key)

    try {
      const existing = toBytes(await readFile(dest))
      const existingDigest = sha256Digest(existing)
      if (existingDigest === digest) {
        return { key, byteSize: existing.byteLength, digest: existingDigest }
      }
      throw new ObjectStoreError('OBJECT_KEY_CONFLICT', '同键对象正文不一致，拒绝覆盖')
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof ObjectStoreError) throw error
        throw new ObjectStoreError('OBJECT_STORE_UNAVAILABLE', '本地对象读取失败', { cause: error })
      }
    }

    await mkdir(dirname(dest), { recursive: true })
    const tmp = `${dest}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(tmp, input.body)
      await rename(tmp, dest)
    } catch (error) {
      await unlink(tmp).catch(() => undefined)
      throw new ObjectStoreError('OBJECT_STORE_UNAVAILABLE', '本地对象写入失败', { cause: error })
    }
    return { key, byteSize: input.body.byteLength, digest }
  }

  async get(key: string): Promise<{ head: ObjectHead; body: Uint8Array }> {
    const parsed = requireObjectKey(key)
    const dest = await this.resolveKeyPath(parsed)
    try {
      const body = toBytes(await readFile(dest))
      const digest = sha256Digest(body)
      return { head: { key: parsed, byteSize: body.byteLength, digest }, body }
    } catch (error) {
      if (isNotFound(error)) {
        throw new ObjectStoreError('OBJECT_NOT_FOUND', '对象不存在')
      }
      throw new ObjectStoreError('OBJECT_STORE_UNAVAILABLE', '本地对象读取失败', { cause: error })
    }
  }

  async delete(key: string): Promise<void> {
    const parsed = requireObjectKey(key)
    const dest = await this.resolveKeyPath(parsed)
    try {
      await unlink(dest)
    } catch (error) {
      if (isNotFound(error)) return
      throw new ObjectStoreError('OBJECT_STORE_UNAVAILABLE', '本地对象删除失败', { cause: error })
    }
  }

  private async root(): Promise<string> {
    if (this.resolvedRoot) return this.resolvedRoot
    await mkdir(this.configuredRoot, { recursive: true })
    this.resolvedRoot = await realpath(this.configuredRoot)
    return this.resolvedRoot
  }

  private async resolveKeyPath(key: string): Promise<string> {
    const root = await this.root()
    const dest = join(root, ...key.split('/'))
    const relativeToRoot = relative(root, dest)
    if (relativeToRoot.startsWith('..') || relativeToRoot.startsWith(`..${sep}`)) {
      throw new ObjectStoreError('OBJECT_KEY_INVALID', '对象键越出本地根目录')
    }
    return dest
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function toBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value)
}
