import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_OBJECT_MAX_BYTES,
  ObjectStoreError,
  objectKeyFor,
  workerEnvSchema,
} from '@cairn/shared'
import { createObjectStore } from '../create-store.js'
import { LocalObjectStore } from '../local-store.js'
import { findRepoRoot, resolveLocalObjectStoreDir } from '../repo-root.js'
import { S3ObjectStore } from '../s3-store.js'
import { CONTRACT_KEY, runObjectStoreContract } from './contract.js'
import { MemoryS3, s3Error } from './memory-s3.js'

const MAX = 1024

describe('LocalObjectStore 契约', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('put / get / delete 与幂等、冲突、非法键、超限', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-obj-'))
    dirs.push(dir)
    const store = new LocalObjectStore(dir, MAX)
    await runObjectStoreContract(store, {
      maxBytes: MAX,
      exists: async (key) => {
        try {
          await store.get(key)
          return true
        } catch {
          return false
        }
      },
    })
  })

  it('非法键不得在根目录外落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-obj-'))
    dirs.push(dir)
    const parent = dirname(dir)
    const before = new Set(await readdir(parent))
    const store = new LocalObjectStore(dir, MAX)
    const body = new TextEncoder().encode('escape')
    for (const key of ['../escape', '/abs/path', 'v1//x', 'a/b/']) {
      await expect(store.put({ key, body, contentType: 'text/plain' })).rejects.toMatchObject({
        code: 'OBJECT_KEY_INVALID',
      })
    }
    const createdOutside = (await readdir(parent)).filter((name) => !before.has(name))
    expect(createdOutside).toEqual([])
    expect(existsSync(join(parent, 'escape'))).toBe(false)
    expect(await readdir(dir, { recursive: true })).toEqual([])
  })
})

describe('S3ObjectStore 契约（mock）', () => {
  it('与 Local 同一套断言，且 Head / Put / Get / Delete 都会发出', async () => {
    const memory = new MemoryS3()
    const store = new S3ObjectStore(memory, 'cairn-evidence', MAX)
    await runObjectStoreContract(store, {
      maxBytes: MAX,
      exists: (key) => memory.objects.has(key),
    })
    expect(memory.commands).toContain('HeadObject')
    expect(memory.commands).toContain('PutObject')
    expect(memory.commands).toContain('GetObject')
    expect(memory.commands).toContain('DeleteObject')
  })

  it('NoSuchKey / 404 → OBJECT_NOT_FOUND；超时、5xx、403 → OBJECT_STORE_UNAVAILABLE', async () => {
    const memory = new MemoryS3()
    const store = new S3ObjectStore(memory, 'cairn-evidence', MAX)

    memory.failNext = s3Error('NoSuchKey', 404)
    await expect(store.get(CONTRACT_KEY)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })

    memory.failNext = s3Error('NotFound', 404)
    await expect(store.get(CONTRACT_KEY)).rejects.toBeInstanceOf(ObjectStoreError)

    memory.failNext = s3Error('TimeoutError', 0)
    await expect(store.get(CONTRACT_KEY)).rejects.toMatchObject({
      code: 'OBJECT_STORE_UNAVAILABLE',
    })

    memory.failNext = s3Error('InternalError', 500)
    await expect(store.get(CONTRACT_KEY)).rejects.toMatchObject({
      code: 'OBJECT_STORE_UNAVAILABLE',
    })

    memory.failNext = s3Error('AccessDenied', 403)
    await expect(store.get(CONTRACT_KEY)).rejects.toMatchObject({
      code: 'OBJECT_STORE_UNAVAILABLE',
    })

    await expect(store.get(CONTRACT_KEY)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
  })

  it('版本桶按 VersionId 清全部版本，不能只打删除标记', async () => {
    const memory = new MemoryS3()
    memory.versioning = 'Enabled'
    memory.putVersioned(CONTRACT_KEY, new TextEncoder().encode('v1'), 'd1')
    memory.putVersioned(CONTRACT_KEY, new TextEncoder().encode('v2'), 'd2')
    const store = new S3ObjectStore(memory, 'cairn-evidence', MAX)
    await store.delete(CONTRACT_KEY)
    expect(memory.versions.get(CONTRACT_KEY) ?? []).toEqual([])
    expect(memory.commands).toContain('GetBucketVersioning')
    expect(memory.commands).toContain('ListObjectVersions')
    expect(memory.commands.filter((name) => name === 'DeleteObject').length).toBeGreaterThan(1)
  })
})

describe('仓根解析', () => {
  it('从仓根与 packages/worker 解析出同一绝对路径', () => {
    const repo = findRepoRoot(import.meta.dirname)
    const fromWorker = findRepoRoot(join(repo, 'packages/worker'))
    expect(fromWorker).toBe(repo)
    expect(resolveLocalObjectStoreDir('.data/object-store', () => repo)).toBe(
      resolveLocalObjectStoreDir('.data/object-store', () => fromWorker),
    )
    expect(resolveLocalObjectStoreDir('.data/object-store', () => repo)).toBe(
      join(repo, '.data/object-store'),
    )

    // 绝对路径不碰仓根：thunk 一次都不该被调用。
    let calls = 0
    expect(
      resolveLocalObjectStoreDir('/var/cairn/objects', () => {
        calls += 1
        return repo
      }),
    ).toBe('/var/cairn/objects')
    expect(calls).toBe(0)
  })
})

describe('createObjectStore', () => {
  it('local 驱动构造 LocalObjectStore，即使配了 S3 变量', () => {
    const env = workerEnvSchema.parse({
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_S3_BUCKET: 'ignored',
      CAIRN_S3_ACCESS_KEY: 'ignored',
      CAIRN_S3_SECRET_KEY: 'ignored',
    })
    const store = createObjectStore(env, { repoRoot: () => findRepoRoot(import.meta.dirname) })
    expect(store).toBeInstanceOf(LocalObjectStore)
    expect(env.CAIRN_OBJECT_MAX_BYTES).toBe(DEFAULT_OBJECT_MAX_BYTES)
  })

  it('s3 驱动不求值仓根：容器里跑 dist 也能起来', () => {
    const env = workerEnvSchema.parse({
      CAIRN_OBJECT_STORE: 's3',
      CAIRN_S3_BUCKET: 'cairn-evidence',
      CAIRN_S3_ACCESS_KEY: 'key',
      CAIRN_S3_SECRET_KEY: 'secret',
    })
    const store = createObjectStore(env, {
      repoRoot: () => {
        throw new Error('未找到仓根（缺少 pnpm-workspace.yaml）')
      },
    })
    expect(store).toBeInstanceOf(S3ObjectStore)
  })

  it('local + 绝对路径同样不求值仓根', () => {
    const env = workerEnvSchema.parse({
      CAIRN_OBJECT_STORE: 'local',
      CAIRN_OBJECT_STORE_DIR: '/var/cairn/objects',
    })
    const store = createObjectStore(env, {
      repoRoot: () => {
        throw new Error('未找到仓根（缺少 pnpm-workspace.yaml）')
      },
    })
    expect(store).toBeInstanceOf(LocalObjectStore)
  })
})

function loadConfiguredS3Env() {
  const envFile = join(findRepoRoot(import.meta.dirname), '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  if (!process.env.CAIRN_S3_BUCKET || !process.env.CAIRN_S3_ACCESS_KEY || !process.env.CAIRN_S3_SECRET_KEY) {
    return null
  }
  const parsed = workerEnvSchema.safeParse({
    ...process.env,
    CAIRN_OBJECT_STORE: 's3',
  })
  if (!parsed.success) {
    throw new Error(
      `已配置 S3 变量但校验失败：${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    )
  }
  return parsed.data
}

function testEntityId(): string {
  return `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`
}

describe.skipIf(!loadConfiguredS3Env())('S3ObjectStore 真端点', { timeout: 30_000 }, () => {
  it('put / get / 同正文幂等 / 冲突 / delete，并清掉测试键', async () => {
    const env = loadConfiguredS3Env()
    if (!env) throw new Error('S3 变量在用例开始后消失')
    const store = createObjectStore(env, { repoRoot: () => findRepoRoot(import.meta.dirname) })
    expect(store).toBeInstanceOf(S3ObjectStore)

    const key = objectKeyFor(testEntityId(), testEntityId())
    const body = new TextEncoder().encode(`cairn-live-${key}`)
    try {
      const first = await store.put({ key, body, contentType: 'text/plain' })
      expect(first).toEqual({ key, byteSize: body.byteLength, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })

      const again = await store.put({ key, body, contentType: 'application/octet-stream' })
      expect(again).toEqual(first)

      const got = await store.get(key)
      expect(got.head).toEqual(first)
      expect(got.body).toEqual(body)

      await expect(
        store.put({ key, body: new TextEncoder().encode('different-live'), contentType: 'text/plain' }),
      ).rejects.toMatchObject({ code: 'OBJECT_KEY_CONFLICT' })
      expect((await store.get(key)).body).toEqual(body)

      await store.delete(key)
      await expect(store.get(key)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
      await store.delete(key)
    } finally {
      await store.delete(key).catch(() => undefined)
    }
  })
})
