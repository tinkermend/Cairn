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
      'attempts',
      'browser_sessions',
      'console_account_roles',
      'console_accounts',
      'console_audit_events',
      'console_identities',
      'console_role_permissions',
      'console_roles',
      'evidences',
      'runs',
      'scenario_versions',
      'scenarios',
      'secrets',
      'session_leases',
      'step_runs',
      'stored_objects',
      'target_accounts',
      'targets',
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

  it('targets 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'targets' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'auth_method', is_nullable: 'NO' },
      { column_name: 'captcha_mode', is_nullable: 'NO' },
      { column_name: 'code', is_nullable: 'NO' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'entry_url', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'login_fields', is_nullable: 'YES' },
      { column_name: 'login_url', is_nullable: 'YES' },
      { column_name: 'name', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])
  })

  it('secrets 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'secrets' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'ciphertext', is_nullable: 'NO' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'provider', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])
  })

  it('target_accounts 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'target_accounts' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'display_name', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'secret_id', is_nullable: 'YES' },
      { column_name: 'secret_provider', is_nullable: 'YES' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'target_id', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
      { column_name: 'username', is_nullable: 'NO' },
    ])
  })

  it('scenarios 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'scenarios' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'created_by_console_account_id', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'name', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'target_id', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])
  })

  it('scenario_versions 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'scenario_versions' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'created_by_console_account_id', is_nullable: 'NO' },
      { column_name: 'definition', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'scenario_id', is_nullable: 'NO' },
      { column_name: 'version_no', is_nullable: 'NO' },
    ])
  })

  it('runs 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'runs' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'cancel_requested_at', is_nullable: 'YES' },
      { column_name: 'context', is_nullable: 'NO' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'created_by_console_account_id', is_nullable: 'NO' },
      { column_name: 'finished_at', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'idempotency_digest', is_nullable: 'YES' },
      { column_name: 'idempotency_key', is_nullable: 'YES' },
      { column_name: 'scenario_id', is_nullable: 'NO' },
      { column_name: 'scenario_version_id', is_nullable: 'NO' },
      { column_name: 'snapshot', is_nullable: 'NO' },
      { column_name: 'snapshot_digest', is_nullable: 'NO' },
      { column_name: 'started_at', is_nullable: 'YES' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'target_account_id', is_nullable: 'YES' },
      { column_name: 'target_id', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])
  })

  it('step_runs 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'step_runs' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'finished_at', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'ordinal', is_nullable: 'NO' },
      { column_name: 'run_id', is_nullable: 'NO' },
      { column_name: 'started_at', is_nullable: 'YES' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'step_id', is_nullable: 'NO' },
    ])
  })

  it('attempts 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'attempts' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'attempt_no', is_nullable: 'NO' },
      { column_name: 'error', is_nullable: 'YES' },
      { column_name: 'finished_at', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'output', is_nullable: 'YES' },
      { column_name: 'started_at', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'step_run_id', is_nullable: 'NO' },
    ])
  })

  it('evidences 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'evidences' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'attempt_id', is_nullable: 'YES' },
      { column_name: 'byte_size', is_nullable: 'YES' },
      { column_name: 'content_type', is_nullable: 'YES' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'digest', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'missing_reason', is_nullable: 'YES' },
      { column_name: 'object_key', is_nullable: 'YES' },
      { column_name: 'payload', is_nullable: 'YES' },
      { column_name: 'run_id', is_nullable: 'NO' },
      { column_name: 'schema_version', is_nullable: 'NO' },
      { column_name: 'step_run_id', is_nullable: 'YES' },
      { column_name: 'type', is_nullable: 'NO' },
    ])
  })

  it('stored_objects 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'stored_objects' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'available_at', is_nullable: 'YES' },
      { column_name: 'byte_size', is_nullable: 'YES' },
      { column_name: 'content_type', is_nullable: 'YES' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'digest', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'last_purge_error_at', is_nullable: 'YES' },
      { column_name: 'object_key', is_nullable: 'NO' },
      { column_name: 'purge_attempts', is_nullable: 'NO' },
      { column_name: 'purge_reason', is_nullable: 'YES' },
      { column_name: 'purged_at', is_nullable: 'YES' },
      { column_name: 'retain_until', is_nullable: 'NO' },
      { column_name: 'run_id', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
    ])
  })

  it('browser_sessions 的列与约束一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'browser_sessions' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'auth_hold_expires_at', is_nullable: 'YES' },
      { column_name: 'auth_hold_worker_id', is_nullable: 'YES' },
      { column_name: 'auth_state', is_nullable: 'NO' },
      { column_name: 'close_reason', is_nullable: 'YES' },
      { column_name: 'closed_at', is_nullable: 'YES' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'expires_at', is_nullable: 'NO' },
      { column_name: 'fencing_token', is_nullable: 'NO' },
      { column_name: 'generation', is_nullable: 'NO' },
      { column_name: 'health', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'idle_ttl_seconds', is_nullable: 'NO' },
      { column_name: 'last_used_at', is_nullable: 'NO' },
      { column_name: 'max_lifetime_seconds', is_nullable: 'NO' },
      { column_name: 'owner_worker_id', is_nullable: 'NO' },
      { column_name: 'profile_key', is_nullable: 'NO' },
      { column_name: 'reuse_policy', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'target_account_id', is_nullable: 'NO' },
      { column_name: 'target_id', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
      { column_name: 'version', is_nullable: 'NO' },
    ])

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'browser_sessions'
       ORDER BY indexname`,
      [TEST_SCHEMA],
    )
    expect(indexes.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'browser_sessions_key_live_idx',
        'browser_sessions_owner_idx',
        'browser_sessions_reap_idx',
      ]),
    )
  })

  it('session_leases 的列与 ACTIVE 唯一索引一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'session_leases' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'acquired_at', is_nullable: 'NO' },
      { column_name: 'expires_at', is_nullable: 'NO' },
      { column_name: 'heartbeat_at', is_nullable: 'NO' },
      { column_name: 'holder_worker_id', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'release_reason', is_nullable: 'YES' },
      { column_name: 'released_at', is_nullable: 'YES' },
      { column_name: 'run_fencing_token', is_nullable: 'YES' },
      { column_name: 'run_id', is_nullable: 'NO' },
      { column_name: 'session_fencing_token', is_nullable: 'NO' },
      { column_name: 'session_generation', is_nullable: 'NO' },
      { column_name: 'session_id', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
    ])

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'session_leases'
       ORDER BY indexname`,
      [TEST_SCHEMA],
    )
    expect(indexes.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['session_leases_active_idx', 'session_leases_reap_idx']),
    )
  })

  it('evidences.object_key 外键指向 stored_objects', async () => {
    const { rows } = await pool.query<{ referenced: string }>(
      `SELECT ccu.table_name AS referenced
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
         AND tc.table_name = 'evidences' AND kcu.column_name = 'object_key'`,
      [TEST_SCHEMA],
    )
    expect(rows.map((r) => r.referenced)).toEqual(['stored_objects'])
  })

  it('所有 id / *_id 列都是 uuid 类型（Worker 身份列除外）', async () => {
    const workerIdColumns = new Set([
      'owner_worker_id',
      'auth_hold_worker_id',
      'holder_worker_id',
    ])
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name <> '_migrations'
         AND (column_name = 'id' OR column_name LIKE '%\\_id')
       ORDER BY table_name, column_name`,
      [TEST_SCHEMA],
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.filter((r) => !workerIdColumns.has(r.column_name) && r.data_type !== 'uuid'),
    ).toEqual([])
    expect(rows.filter((r) => workerIdColumns.has(r.column_name)).every((r) => r.data_type === 'text')).toBe(
      true,
    )
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
    // session_id → browser_sessions：领域名用 session 而非 browser_session
    // target_id → target_accounts：复合外键 (target_account_id, target_id) 的第二列
    const allowed = new Set([
      'session_id→browser_sessions',
      'target_id→target_accounts',
    ])
    const violations = rows.filter((r) => {
      if (!r.column_name.endsWith('_id')) return false
      if (allowed.has(`${r.column_name}→${r.referenced}`)) return false
      return !r.column_name.endsWith(`${r.referenced.replace(/s$/, '')}_id`)
    })
    expect(violations).toEqual([])
  })

  it('重复执行迁移不产生副作用（幂等）', async () => {
    const second = await migrate(pool, TEST_SCHEMA)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual([
      '0001_initial.sql',
      '0002_rbac.sql',
      '0003_audit.sql',
      '0004_targets.sql',
      '0005_target_login_fields.sql',
      '0006_execution.sql',
      '0007_object_store.sql',
      '0008_browser_session.sql',
      '0009_session_dispose.sql',
    ])
  })
})
