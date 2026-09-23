import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveFixtureForRun, resolveRunObjectForUpload, type DbHandle } from '@cairn/db'
import {
  isObjectStoreError,
  runObjectIdFromKey,
  type ExecutionError,
  type RunFileHandle,
} from '@cairn/shared'

export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024

export type AuthorizedUploadObject = {
  objectKey: string
  byteSize: number
  digest: string
  mimeType: string
  name: string
}

type ObjectStoreLike = {
  get(key: string, range?: { start?: number; end?: number }): Promise<{
    head: { byteSize: number }
    body: Uint8Array
  }>
}

type UploadStore = { objectStore(): ObjectStoreLike }

export function uploadFailure(
  code: string,
  category: ExecutionError['category'],
  retryable: boolean,
  safeMessage: string,
): { ok: false; error: ExecutionError } {
  return { ok: false, error: { code, category, retryable, safeMessage } }
}

function domainCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}

function domainMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function mapFixtureResolveError(
  error: unknown,
  fixtureId: string,
): { ok: false; error: ExecutionError } {
  const code = domainCode(error) ?? 'FIXTURE_NOT_FOUND'
  if (code === 'FIXTURE_DIGEST_MISMATCH') {
    return uploadFailure('FIXTURE_DIGEST_MISMATCH', 'VALIDATION', false, domainMessage(error, '测试夹具摘要校验失败'))
  }
  if (code === 'FIXTURE_NOT_AVAILABLE') {
    return uploadFailure('FILE_OBJECT_UNAVAILABLE', 'INFRASTRUCTURE', true, domainMessage(error, '测试夹具文件不可用'))
  }
  return uploadFailure(
    'FIXTURE_NOT_FOUND',
    'VALIDATION',
    false,
    domainMessage(error, `测试夹具不存在或不属于当前 Target：${fixtureId}`),
  )
}

export async function authorizeFixtureHandle(
  handle: DbHandle,
  input: { targetId: string; file: RunFileHandle },
): Promise<{ ok: true; blob: AuthorizedUploadObject } | { ok: false; error: ExecutionError }> {
  if (!input.file.fixtureId) {
    return uploadFailure('FILE_HANDLE_INVALID', 'VALIDATION', false, '夹具句柄缺少 fixtureId')
  }
  try {
    const resolved = await resolveFixtureForRun(handle, {
      fixtureId: input.file.fixtureId,
      targetId: input.targetId,
      digest: input.file.digest,
    })
    return {
      ok: true,
      blob: {
        objectKey: resolved.objectKey,
        byteSize: resolved.byteSize,
        digest: resolved.digest,
        mimeType: resolved.mimeType,
        name: resolved.name,
      },
    }
  } catch (error) {
    return mapFixtureResolveError(error, input.file.fixtureId)
  }
}

export async function authorizeRunHandle(
  handle: DbHandle,
  input: { runId: string; file: RunFileHandle },
): Promise<{ ok: true; blob: AuthorizedUploadObject } | { ok: false; error: ExecutionError }> {
  if (input.file.scope !== 'run' || input.file.runId !== input.runId || !runObjectIdFromKey(input.file.objectKey, input.runId)) {
    return uploadFailure(
      'FILE_HANDLE_FOREIGN_RUN',
      'VALIDATION',
      false,
      '文件句柄的对象键不属于当前 Run',
    )
  }
  try {
    const resolved = await resolveRunObjectForUpload(handle, {
      runId: input.runId,
      objectKey: input.file.objectKey,
      digest: input.file.digest,
    })
    return {
      ok: true,
      blob: {
        objectKey: resolved.objectKey,
        byteSize: resolved.byteSize,
        digest: resolved.digest,
        mimeType: resolved.contentType,
        name: input.file.name,
      },
    }
  } catch (error) {
    const code = domainCode(error)
    if (code === 'FILE_HANDLE_FOREIGN_RUN' || code === 'FILE_HANDLE_INVALID' || code === 'FILE_OBJECT_UNAVAILABLE') {
      return uploadFailure(code, code === 'FILE_OBJECT_UNAVAILABLE' ? 'INFRASTRUCTURE' : 'VALIDATION', code === 'FILE_OBJECT_UNAVAILABLE', domainMessage(error, '文件对象不可用'))
    }
    return uploadFailure('FILE_HANDLE_INVALID', 'VALIDATION', false, '文件句柄无法对上当前 Run 的对象账本')
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** 同名文件不能代替授权对象。只有摘要和账本体积都对得上才复用本地副本。 */
async function findDigestBoundLocal(input: {
  localPath: string
  downloadDir: string
  cleanName: string
  digest: string
  byteSize: number
}): Promise<string | undefined> {
  const candidates = [input.localPath]
  const downloaded = await readdir(input.downloadDir).catch(() => [] as string[])
  for (const name of downloaded) {
    if (name === input.cleanName || name.endsWith(`-${input.cleanName}`)) {
      candidates.push(join(input.downloadDir, name))
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const info = await stat(path).catch(() => undefined)
    if (!info || info.size !== input.byteSize) continue
    if ((await sha256File(path)) === input.digest) return path
  }
  return undefined
}

async function probeStoredByteSize(store: ObjectStoreLike, key: string): Promise<number> {
  try {
    const probe = await store.get(key, { start: 0, end: 0 })
    return probe.head.byteSize
  } catch (error) {
    if (isObjectStoreError(error) && error.code === 'OBJECT_NOT_FOUND' && error.message.includes('范围')) {
      return 0
    }
    throw error
  }
}

/**
 * 先看账本体积，再用范围读取确认存储大小，通过后才读全文。
 * 无对象存储时写空占位，只给没有接线存储的测试用；体积仍来自账本。
 */
export async function materializeAuthorizedObject(input: {
  objects?: UploadStore
  blob: AuthorizedUploadObject
  localPath: string
  downloadDir: string
  cleanName: string
  maxBytes: number
}): Promise<{ ok: true; localPath: string } | { ok: false; error: ExecutionError }> {
  if (input.blob.byteSize > input.maxBytes) {
    return uploadFailure(
      'UPLOAD_PAYLOAD_TOO_LARGE',
      'VALIDATION',
      false,
      `上传文件总大小 ${input.blob.byteSize} 超过 64MB 限制`,
    )
  }
  const reused = await findDigestBoundLocal({
    localPath: input.localPath,
    downloadDir: input.downloadDir,
    cleanName: input.cleanName,
    digest: input.blob.digest,
    byteSize: input.blob.byteSize,
  })
  if (reused) return { ok: true, localPath: reused }

  if (!input.objects) {
    await writeFile(input.localPath, Buffer.alloc(0))
    return { ok: true, localPath: input.localPath }
  }

  const store = input.objects.objectStore()
  let storedSize: number
  try {
    storedSize = await probeStoredByteSize(store, input.blob.objectKey)
  } catch (error) {
    return uploadFailure(
      'FILE_OBJECT_UNAVAILABLE',
      'INFRASTRUCTURE',
      true,
      `获取文件对象失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (storedSize > input.maxBytes) {
    return uploadFailure(
      'UPLOAD_PAYLOAD_TOO_LARGE',
      'VALIDATION',
      false,
      `上传文件总大小 ${storedSize} 超过 64MB 限制`,
    )
  }
  if (storedSize !== input.blob.byteSize) {
    return uploadFailure('FILE_OBJECT_UNAVAILABLE', 'INFRASTRUCTURE', true, '文件对象大小与账本不一致')
  }
  if (storedSize === 0) {
    const emptyDigest = `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`
    if (emptyDigest !== input.blob.digest) {
      return uploadFailure('FILE_OBJECT_UNAVAILABLE', 'INFRASTRUCTURE', true, '文件对象摘要与账本不一致')
    }
    await writeFile(input.localPath, Buffer.alloc(0))
    return { ok: true, localPath: input.localPath }
  }

  try {
    const got = await store.get(input.blob.objectKey)
    if (got.body.byteLength > input.maxBytes || got.body.byteLength !== input.blob.byteSize) {
      await rm(input.localPath, { force: true }).catch(() => undefined)
      return uploadFailure(
        got.body.byteLength > input.maxBytes ? 'UPLOAD_PAYLOAD_TOO_LARGE' : 'FILE_OBJECT_UNAVAILABLE',
        got.body.byteLength > input.maxBytes ? 'VALIDATION' : 'INFRASTRUCTURE',
        got.body.byteLength > input.maxBytes ? false : true,
        got.body.byteLength > input.maxBytes
          ? `上传文件总大小 ${got.body.byteLength} 超过 64MB 限制`
          : '文件对象大小与账本不一致',
      )
    }
    const actual = `sha256:${createHash('sha256').update(got.body).digest('hex')}`
    if (actual !== input.blob.digest) {
      await rm(input.localPath, { force: true }).catch(() => undefined)
      return uploadFailure('FILE_OBJECT_UNAVAILABLE', 'INFRASTRUCTURE', true, '文件对象摘要与账本不一致')
    }
    await writeFile(input.localPath, got.body)
    return { ok: true, localPath: input.localPath }
  } catch (error) {
    await rm(input.localPath, { force: true }).catch(() => undefined)
    return uploadFailure(
      'FILE_OBJECT_UNAVAILABLE',
      'INFRASTRUCTURE',
      true,
      `获取文件对象失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
