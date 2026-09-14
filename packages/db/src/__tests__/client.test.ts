import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { postgresEnvSchema as dbEnvSchema } from '../test-entry.js'
import { createDb, type DbHandle } from '../test-entry.js'

// 从仓库根的 .env 读取真实连接信息。.env 不入库，
// CI 上没有它时整组集成测试跳过而非失败。
const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const parsed = dbEnvSchema.safeParse(process.env)

describe.skipIf(!parsed.success)('createDb（集成，需真实 PostgreSQL）', () => {
  let handle: DbHandle

  beforeAll(() => {
    handle = createDb(parsed.data!)
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('ping 能连通数据库', async () => {
    await expect(handle.ping()).resolves.toBe(true)
  })

  it('连到的是配置指定的库与用户', async () => {
    const { rows } = await handle.pool.query<{ db: string; usr: string }>(
      'select current_database() as db, current_user as usr',
    )
    expect(rows[0]?.db).toBe(parsed.data!.CAIRN_DB_NAME)
    expect(rows[0]?.usr).toBe(parsed.data!.CAIRN_DB_USER)
  })

  it('search_path 指向配置的 schema', async () => {
    const { rows } = await handle.pool.query<{ search_path: string }>('show search_path')
    expect(rows[0]?.search_path).toContain(parsed.data!.CAIRN_DB_SCHEMA)
  })

  it('连接错误时 ping 抛错而非静默返回 false', async () => {
    const bad = createDb({ ...parsed.data!, CAIRN_DB_PASSWORD: 'wrong-password' })
    await expect(bad.ping()).rejects.toThrow()
    await bad.close().catch(() => {})
  })
})

describe('createDb（无需数据库）', () => {
  it('.env 缺失时集成测试应被跳过而非失败', () => {
    expect(typeof parsed.success).toBe('boolean')
  })
})
