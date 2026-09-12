import { describe, expect, it } from 'vitest'
import {
  OBJECT_MISSING_REASONS,
  OBJECT_STORE_ERROR_CODES,
  ObjectStoreError,
  isAbsoluteFsPath,
  objectDigestSchema,
  objectKeyFor,
  objectKeySchema,
} from '../object-store.js'

const runId = '00000000-0000-4000-8000-0000000000a1'
const objectId = '00000000-0000-4000-8000-0000000000a2'

describe('objectKeySchema', () => {
  it('接受平台分配键与既有证据示例键', () => {
    expect(objectKeySchema.parse('v1/runs/00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000a2'))
      .toBeTruthy()
    expect(objectKeySchema.parse('cairn-evidence/run/attempt/shot.png')).toBe(
      'cairn-evidence/run/attempt/shot.png',
    )
  })

  it('拒绝越权、绝对路径与空段', () => {
    expect(() => objectKeySchema.parse('../escape')).toThrow()
    expect(() => objectKeySchema.parse('/abs/path')).toThrow()
    expect(() => objectKeySchema.parse('v1//x')).toThrow()
    expect(() => objectKeySchema.parse('a/b/')).toThrow()
    expect(() => objectKeySchema.parse('has space')).toThrow()
  })
})

describe('objectKeyFor', () => {
  it('钉死 v1/runs/{runId}/{objectId}', () => {
    expect(objectKeyFor(runId, objectId)).toBe(`v1/runs/${runId}/${objectId}`)
  })

  it('拒绝非 UUID', () => {
    expect(() => objectKeyFor('not-a-uuid', objectId)).toThrow()
  })
})

describe('objectDigestSchema', () => {
  it('只接受 sha256: + 64 位小写 hex', () => {
    const digest = `sha256:${'ab'.repeat(32)}`
    expect(objectDigestSchema.parse(digest)).toBe(digest)
    expect(() => objectDigestSchema.parse(`sha256:${'AB'.repeat(32)}`)).toThrow()
    expect(() => objectDigestSchema.parse('sha256:short')).toThrow()
    expect(() => objectDigestSchema.parse('md5:abc')).toThrow()
  })
})

describe('OBJECT_STORE_ERROR_CODES / missing reasons', () => {
  it('词表闭合', () => {
    expect(OBJECT_STORE_ERROR_CODES).toEqual([
      'OBJECT_NOT_FOUND',
      'OBJECT_KEY_INVALID',
      'OBJECT_KEY_CONFLICT',
      'OBJECT_TOO_LARGE',
      'OBJECT_DIGEST_MISMATCH',
      'OBJECT_NOT_AVAILABLE',
      'OBJECT_STORE_UNAVAILABLE',
    ])
    expect(OBJECT_MISSING_REASONS).toEqual({
      storeUnavailable: 'object_store_unavailable',
      purged: 'object_purged',
      uploadIncomplete: 'upload_incomplete',
      workerLost: 'worker_lost',
      traceTooLarge: 'trace_too_large',
      captureFailed: 'capture_failed',
    })
  })

  it('ObjectStoreError 带领域码', () => {
    const error = new ObjectStoreError('OBJECT_NOT_FOUND', '对象不存在')
    expect(error.code).toBe('OBJECT_NOT_FOUND')
    expect(error.name).toBe('ObjectStoreError')
  })
})

describe('isAbsoluteFsPath', () => {
  it('识别 POSIX 与 Windows 盘符', () => {
    expect(isAbsoluteFsPath('/var/objects')).toBe(true)
    expect(isAbsoluteFsPath('C:\\data')).toBe(true)
    expect(isAbsoluteFsPath('.data/object-store')).toBe(false)
    expect(isAbsoluteFsPath('object-store')).toBe(false)
  })
})
