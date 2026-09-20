import { postgresEnvSchema as dbEnvSchema } from '@cairn/db/testing'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { PERMISSIONS, SYSTEM_ROLE_DEFINITIONS, SYSTEM_ROLE_KEYS } from '@cairn/shared'
import { newId } from '../id.js'
import { loadMigrations, migrate } from '../migrate.js'

const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const parsed = dbEnvSchema.safeParse(process.env)

const S = `cairn_test_${Date.now().toString(36)}_rbac`

describe.skipIf(!parsed.success)('RBAC 模型约束（集成）', () => {
  let pool: Pool
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)

  /** 系统角色的 id 是 seed 时生成的 UUID，稳定标识只有 key */
  const roleIdOf = async (key: string): Promise<string> => {
    const { rows } = await q(`SELECT id FROM "${S}".console_roles WHERE key=$1`, [key])
    return (rows[0] as { id: string }).id
  }

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
    for (const key of SYSTEM_ROLE_KEYS) {
      const id = await roleIdOf(key)
      for (const permission of SYSTEM_ROLE_DEFINITIONS[key].permissions) {
        await q(
          `INSERT INTO "${S}".console_role_permissions (console_role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, permission],
        )
      }
    }
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
    await pool?.end()
  })

  it('四个系统角色已种子化，id 是 UUID 而非可读值', async () => {
    const { rows } = await q(`SELECT id, key, kind, name FROM "${S}".console_roles ORDER BY key`)
    expect(rows.map((r: { key: string; kind: string; name: string }) => [r.key, r.kind, r.name])).toEqual([
      ['admin', 'system', '管理员'],
      ['author', 'system', '编写者'],
      ['operator', 'system', '执行者'],
      ['viewer', 'system', '只读'],
    ])
    for (const row of rows as { id: string }[]) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
  })

  it('存量只绑 operator 的账号不会自动获得 author', async () => {
    const acc = newId()
    const operatorId = await roleIdOf('operator')
    await q(`INSERT INTO "${S}".console_accounts (id, display_name) VALUES ('${acc}','旧运维')`)
    await q(
      `INSERT INTO "${S}".console_account_roles (console_account_id, console_role_id) VALUES ('${acc}',$1)`,
      [operatorId],
    )
    const { rows } = await q(
      `SELECT r.key FROM "${S}".console_account_roles b
       JOIN "${S}".console_roles r ON r.id = b.console_role_id
       WHERE b.console_account_id='${acc}'
       ORDER BY r.key`,
    )
    expect(rows.map((r: { key: string }) => r.key)).toEqual(['operator'])
  })

  it('系统角色的权限集与 @cairn/shared 一致', async () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      const { rows } = await q(
        `SELECT permission FROM "${S}".console_role_permissions WHERE console_role_id=$1 ORDER BY permission`,
        [await roleIdOf(key)],
      )
      const actual = rows.map((r: { permission: string }) => r.permission)
      expect(actual).toEqual([...SYSTEM_ROLE_DEFINITIONS[key].permissions].sort())
    }
  })

  it('admin 的权限覆盖整个目录', async () => {
    const { rows } = await q(
      `SELECT permission FROM "${S}".console_role_permissions WHERE console_role_id=$1`,
      [await roleIdOf('admin')],
    )
    expect(rows.map((r: { permission: string }) => r.permission).sort()).toEqual([...PERMISSIONS].sort())
  })

  it('拒绝非法 kind', async () => {
    await expect(
      q(`INSERT INTO "${S}".console_roles (id, key, name, kind) VALUES ('${newId()}','x','x','super')`),
    ).rejects.toThrow(/console_roles_kind_check/)
  })

  it('角色 key 全局唯一', async () => {
    await q(
      `INSERT INTO "${S}".console_roles (id, key, name, kind) VALUES ('${newId()}','qa_lead','QA','custom')`,
    )
    await expect(
      q(`INSERT INTO "${S}".console_roles (id, key, name, kind) VALUES ('${newId()}','qa_lead','QA2','custom')`),
    ).rejects.toThrow(/console_roles_key_idx/)
  })

  it('同一角色不能重复授予同一权限', async () => {
    await expect(
      q(
        `INSERT INTO "${S}".console_role_permissions (console_role_id, permission) VALUES ($1,'target:read')`,
        [await roleIdOf('viewer')],
      ),
    ).rejects.toThrow()
  })

  it('旧 accounts.role 列迁入绑定表后被删除', async () => {
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='console_accounts' AND column_name='role'`,
      [S],
    )
    expect(rows).toEqual([])
  })

  it('新建账号不会自动绑角色——默认角色由应用层赋予', async () => {
    const acc = newId()
    await q(`INSERT INTO "${S}".console_accounts (id, display_name) VALUES ('${acc}','运维')`)
    const { rows } = await q(
      `SELECT console_role_id FROM "${S}".console_account_roles WHERE console_account_id='${acc}'`,
    )
    expect(rows).toEqual([])
  })

  it('删除账号级联删除其角色绑定，不删除角色本身', async () => {
    const acc = newId()
    const viewerId = await roleIdOf('viewer')
    await q(`INSERT INTO "${S}".console_accounts (id, display_name) VALUES ('${acc}','临时')`)
    await q(
      `INSERT INTO "${S}".console_account_roles (console_account_id, console_role_id) VALUES ('${acc}',$1)`,
      [viewerId],
    )
    await q(`DELETE FROM "${S}".console_accounts WHERE id='${acc}'`)

    const { rows: binds } = await q(
      `SELECT count(*)::int AS n FROM "${S}".console_account_roles WHERE console_account_id='${acc}'`,
    )
    expect(binds[0]).toEqual({ n: 0 })
    const { rows: role } = await q(`SELECT key FROM "${S}".console_roles WHERE id=$1`, [viewerId])
    expect(role).toHaveLength(1)
  })

  it('仍被账号引用的角色不能删（RESTRICT）', async () => {
    const acc = newId()
    const role = newId()
    await q(`INSERT INTO "${S}".console_accounts (id, display_name) VALUES ('${acc}','留')`)
    await q(
      `INSERT INTO "${S}".console_roles (id, key, name, kind) VALUES ('${role}','tmp_role','Tmp','custom')`,
    )
    await q(
      `INSERT INTO "${S}".console_account_roles (console_account_id, console_role_id) VALUES ('${acc}','${role}')`,
    )
    await expect(q(`DELETE FROM "${S}".console_roles WHERE id='${role}'`)).rejects.toThrow()
  })

  it('删除角色级联删除其权限行', async () => {
    const role = newId()
    await q(
      `INSERT INTO "${S}".console_roles (id, key, name, kind) VALUES ('${role}','gone','Gone','custom')`,
    )
    await q(
      `INSERT INTO "${S}".console_role_permissions (console_role_id, permission) VALUES ('${role}','audit:read')`,
    )
    await q(`DELETE FROM "${S}".console_roles WHERE id='${role}'`)
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM "${S}".console_role_permissions WHERE console_role_id='${role}'`,
    )
    expect(rows[0]).toEqual({ n: 0 })
  })

  it('自定义 author 角色会使 0018 失败，且不把它提升为系统角色', async () => {
    const schema = `cairn_test_${Date.now().toString(36)}_authc`
    const client = await pool.connect()
    try {
      const migrations = loadMigrations()
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      await client.query(`
        CREATE TABLE IF NOT EXISTS "${schema}"._migrations (
          prefix TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      for (const migration of migrations) {
        if (migration.prefix === '0018') break
        await client.query('BEGIN')
        await client.query(migration.sql.replaceAll('__SCHEMA__', schema))
        await client.query(`INSERT INTO "${schema}"._migrations (prefix, filename) VALUES ($1, $2)`, [
          migration.prefix,
          migration.filename,
        ])
        await client.query('COMMIT')
      }
      const customId = newId()
      await client.query(
        `INSERT INTO "${schema}".console_roles (id, key, name, kind) VALUES ($1,'author','自定义作者','custom')`,
        [customId],
      )
      const product = migrations.find((item) => item.prefix === '0018')
      if (!product) throw new Error('缺少 0018_product_roles.sql')
      await expect(client.query(product.sql.replaceAll('__SCHEMA__', schema))).rejects.toThrow(/author/)
      const { rows } = await client.query<{ kind: string }>(
        `SELECT kind FROM "${schema}".console_roles WHERE key='author'`,
      )
      expect(rows).toEqual([{ kind: 'custom' }])
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      client.release()
    }
  })
})
