import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { dbEnvSchema } from '@cairn/shared'
import { migrate } from '../migrate.js'

const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const parsed = dbEnvSchema.safeParse(process.env)

// 每次跑用独立 schema，互不干扰且可重复执行
const TEST_SCHEMA = `cairn_test_${Date.now().toString(36)}`

describe.skipIf(!parsed.success)('迁移与 Drizzle schema 一致性（集成）', () => {
  let pool: Pool

  beforeAll(async () => {
    const env = parsed.data!
    pool = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
    })
    await migrate(pool, TEST_SCHEMA)
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
    await pool?.end()
  })

  it('两张表都已建立', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [TEST_SCHEMA],
    )
    expect(rows.map((r) => r.table_name)).toEqual([
      '_migrations',
      'console_account_roles',
      'console_accounts',
      'console_audit_events',
      'console_identities',
      'console_role_permissions',
      'console_roles',
    ])
  })

  it('console_accounts 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'console_accounts' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'display_name', is_nullable: 'NO' },
      { column_name: 'email', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])
  })

  it('console_identities 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'console_identities' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'console_account_id', is_nullable: 'NO' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'last_used_at', is_nullable: 'YES' },
      { column_name: 'provider', is_nullable: 'NO' },
      { column_name: 'secret', is_nullable: 'YES' },
      { column_name: 'subject', is_nullable: 'NO' },
    ])
  })

  it('console_roles 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'console_roles' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'description', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'key', is_nullable: 'NO' },
      { column_name: 'kind', is_nullable: 'NO' },
      { column_name: 'name', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])
  })

  it('console_role_permissions 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'console_role_permissions' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'console_role_id', is_nullable: 'NO' },
      { column_name: 'permission', is_nullable: 'NO' },
    ])
  })

  it('console_account_roles 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'console_account_roles' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'assigned_at', is_nullable: 'NO' },
      { column_name: 'assigned_by_console_account_id', is_nullable: 'YES' },
      { column_name: 'console_account_id', is_nullable: 'NO' },
      { column_name: 'console_role_id', is_nullable: 'NO' },
    ])
  })

  it('console_audit_events 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'console_audit_events' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'action', is_nullable: 'NO' },
      { column_name: 'actor_console_account_id', is_nullable: 'YES' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'resource', is_nullable: 'NO' },
      { column_name: 'resource_id', is_nullable: 'YES' },
      { column_name: 'summary', is_nullable: 'NO' },
    ])
  })

  it('所有 id / *_id 列都是 uuid 类型', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name <> '_migrations'
         AND (column_name = 'id' OR column_name LIKE '%\\_id')
       ORDER BY table_name, column_name`,
      [TEST_SCHEMA],
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.data_type !== 'uuid')).toEqual([])
  })

  it('外键列名以「被引用表名单数形 + _id」结尾', async () => {
    const { rows } = await pool.query<{ column_name: string; referenced: string }>(
      `SELECT kcu.column_name, ccu.table_name AS referenced
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [TEST_SCHEMA],
    )
    expect(rows.length).toBeGreaterThan(0)
    const violations = rows.filter(
      (r) => !r.column_name.endsWith(`${r.referenced.replace(/s$/, '')}_id`),
    )
    expect(violations).toEqual([])
  })

  it('重复执行迁移不产生副作用（幂等）', async () => {
    const second = await migrate(pool, TEST_SCHEMA)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(['0001_initial.sql', '0002_rbac.sql', '0003_audit.sql'])
  })
})
