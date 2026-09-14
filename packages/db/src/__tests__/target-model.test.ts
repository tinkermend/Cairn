import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { postgresEnvSchema as dbEnvSchema } from '../test-entry.js'
import { newId } from '../id.js'
import { migrate } from '../migrate.js'

const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const parsed = dbEnvSchema.safeParse(process.env)

const S = `cairn_test_${Date.now().toString(36)}_tgt`

describe.skipIf(!parsed.success)('目标系统模型约束（集成）', () => {
  let pool: Pool
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)

  beforeAll(async () => {
    const env = parsed.data!
    pool = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
    })
    await migrate(pool, S)
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
    await pool?.end()
  })

  it('code 全局唯一', async () => {
    const id = newId()
    await q(
      `INSERT INTO "${S}".targets (id, code, name, entry_url) VALUES ($1,'dup-code','甲','https://a.example')`,
      [id],
    )
    await expect(
      q(
        `INSERT INTO "${S}".targets (id, code, name, entry_url) VALUES ($1,'dup-code','乙','https://b.example')`,
        [newId()],
      ),
    ).rejects.toThrow(/targets_code_idx/)
  })

  it('同系统 username 唯一，跨系统可同名', async () => {
    const a = newId()
    const b = newId()
    await q(
      `INSERT INTO "${S}".targets (id, code, name, entry_url) VALUES ($1,'sys-a','A','https://a.example')`,
      [a],
    )
    await q(
      `INSERT INTO "${S}".targets (id, code, name, entry_url) VALUES ($1,'sys-b','B','https://b.example')`,
      [b],
    )
    await q(
      `INSERT INTO "${S}".target_accounts (id, target_id, display_name, username)
       VALUES ($1,$2,'运维','ops')`,
      [newId(), a],
    )
    await expect(
      q(
        `INSERT INTO "${S}".target_accounts (id, target_id, display_name, username)
         VALUES ($1,$2,'运维2','ops')`,
        [newId(), a],
      ),
    ).rejects.toThrow(/target_accounts_target_username_idx/)
    await expect(
      q(
        `INSERT INTO "${S}".target_accounts (id, target_id, display_name, username)
         VALUES ($1,$2,'运维','ops')`,
        [newId(), b],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('secret_id 与 secret_provider 必须同有或同无', async () => {
    const targetId = newId()
    await q(
      `INSERT INTO "${S}".targets (id, code, name, entry_url) VALUES ($1,'pair-sys','P','https://p.example')`,
      [targetId],
    )
    await expect(
      q(
        `INSERT INTO "${S}".target_accounts (id, target_id, display_name, username, secret_provider)
         VALUES ($1,$2,'甲','alice','local')`,
        [newId(), targetId],
      ),
    ).rejects.toThrow(/secret_ref_pair/)
  })

  it('login_fields 必须是 object 或 null', async () => {
    const id = newId()
    await expect(
      q(
        `INSERT INTO "${S}".targets (id, code, name, entry_url, login_fields)
         VALUES ($1,'bad-json','X','https://x.example','[]')`,
        [id],
      ),
    ).rejects.toThrow(/login_fields_object/)
    await expect(
      q(
        `INSERT INTO "${S}".targets (id, code, name, entry_url, login_fields)
         VALUES ($1,'ok-json','Y','https://y.example','{"username":{"by":"id","value":"username"}}')`,
        [newId()],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('有账号时不能删目标系统', async () => {
    const targetId = newId()
    await q(
      `INSERT INTO "${S}".targets (id, code, name, entry_url) VALUES ($1,'has-acc','H','https://h.example')`,
      [targetId],
    )
    await q(
      `INSERT INTO "${S}".target_accounts (id, target_id, display_name, username)
       VALUES ($1,$2,'甲','bob')`,
      [newId(), targetId],
    )
    await expect(q(`DELETE FROM "${S}".targets WHERE id=$1`, [targetId])).rejects.toThrow()
  })
})
