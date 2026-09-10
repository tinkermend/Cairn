import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { dbEnvSchema } from '@cairn/shared'
import { migrate } from '../migrate.js'

const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const parsed = dbEnvSchema.safeParse(process.env)

const S = `cairn_test_${Date.now().toString(36)}_m`

describe.skipIf(!parsed.success)('console 身份模型约束（集成）', () => {
  let pool: Pool
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)

  beforeAll(async () => {
    const env = parsed.data!
    pool = new Pool({
      host: env.CAIRN_DB_HOST, port: env.CAIRN_DB_PORT, database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER, password: env.CAIRN_DB_PASSWORD,
    })
    await migrate(pool, S)
    await q(`INSERT INTO "${S}".console_accounts (id, display_name, email) VALUES ('acc-1','运维甲','a@example.com')`)
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
    await pool?.end()
  })

  it('account 的 role 与 status 有默认值', async () => {
    const { rows } = await q(`SELECT role, status FROM "${S}".console_accounts WHERE id='acc-1'`)
    expect(rows[0]).toMatchObject({ role: 'operator', status: 'active' })
  })

  it('拒绝非法 role', async () => {
    await expect(
      q(`INSERT INTO "${S}".console_accounts (id, display_name, role) VALUES ('x','x','superuser')`),
    ).rejects.toThrow(/console_accounts_role_check/)
  })

  it('email 大小写不敏感地唯一', async () => {
    await expect(
      q(`INSERT INTO "${S}".console_accounts (id, display_name, email) VALUES ('acc-2','乙','A@Example.com')`),
    ).rejects.toThrow(/console_accounts_email_idx/)
  })

  it('local 身份必须带密码哈希', async () => {
    await expect(
      q(`INSERT INTO "${S}".console_identities (id, account_id, provider, subject)
         VALUES ('i-bad','acc-1','local','oper')`),
    ).rejects.toThrow(/console_identities_secret_check/)
  })

  it('外部 provider 不得存密码哈希', async () => {
    await expect(
      q(`INSERT INTO "${S}".console_identities (id, account_id, provider, subject, secret)
         VALUES ('i-bad2','acc-1','oidc','sub-1','should-not-be-here')`),
    ).rejects.toThrow(/console_identities_secret_check/)
  })

  it('同一 account 可同时持有本地密码与 SSO 身份', async () => {
    await q(`INSERT INTO "${S}".console_identities (id, account_id, provider, subject, secret)
             VALUES ('i-local','acc-1','local','oper','$argon2id$hash')`)
    await q(`INSERT INTO "${S}".console_identities (id, account_id, provider, subject)
             VALUES ('i-oidc','acc-1','oidc','sub-abc')`)

    const { rows } = await q(
      `SELECT provider FROM "${S}".console_identities WHERE account_id='acc-1' ORDER BY provider`,
    )
    expect(rows.map((r: { provider: string }) => r.provider)).toEqual(['local', 'oidc'])
  })

  it('(provider, subject) 全局唯一', async () => {
    await expect(
      q(`INSERT INTO "${S}".console_identities (id, account_id, provider, subject, secret)
         VALUES ('i-dup','acc-1','local','oper','$argon2id$hash')`),
    ).rejects.toThrow(/console_identities_provider_subject_idx/)
  })

  it('删除 account 级联删除其全部 identity', async () => {
    await q(`INSERT INTO "${S}".console_accounts (id, display_name) VALUES ('acc-3','丙')`)
    await q(`INSERT INTO "${S}".console_identities (id, account_id, provider, subject, secret)
             VALUES ('i-3','acc-3','local','bing','$argon2id$h')`)

    await q(`DELETE FROM "${S}".console_accounts WHERE id='acc-3'`)

    const { rows } = await q(`SELECT count(*)::int AS n FROM "${S}".console_identities WHERE account_id='acc-3'`)
    expect(rows[0]).toEqual({ n: 0 })
  })
})
