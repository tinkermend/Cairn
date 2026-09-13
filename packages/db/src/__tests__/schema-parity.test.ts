import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { postgresEnvSchema as dbEnvSchema } from '../test-entry.js'
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
      'recording_drafts',
      'run_leases',
      'runs',
      'scenario_drafts',
      'scenario_versions',
      'scenarios',
      'secrets',
      'session_leases',
      'step_runs',
      'stored_objects',
      'target_accounts',
      'targets',
      'workers',
    ])
  })

  it('recording_drafts 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'recording_drafts' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'created_by_console_account_id', is_nullable: 'NO' },
      { column_name: 'diagnostics', is_nullable: 'NO' },
      { column_name: 'event_count', is_nullable: 'NO' },
      { column_name: 'events', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'idempotency_key', is_nullable: 'NO' },
      { column_name: 'item_count', is_nullable: 'NO' },
      { column_name: 'items', is_nullable: 'NO' },
      { column_name: 'name', is_nullable: 'NO' },
      { column_name: 'payload_digest', is_nullable: 'NO' },
      { column_name: 'recording_id', is_nullable: 'NO' },
      { column_name: 'source_version', is_nullable: 'NO' },
      { column_name: 'target_id', is_nullable: 'NO' },
      { column_name: 'unresolved_count', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
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
      { column_name: 'category', is_nullable: 'NO' },
      { column_name: 'client_ip', is_nullable: 'YES' },
      { column_name: 'client_kind', is_nullable: 'YES' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'failure_reason', is_nullable: 'YES' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'login_identifier', is_nullable: 'YES' },
      { column_name: 'outcome', is_nullable: 'YES' },
      { column_name: 'resource', is_nullable: 'NO' },
      { column_name: 'resource_id', is_nullable: 'YES' },
      { column_name: 'summary', is_nullable: 'NO' },
      { column_name: 'user_agent', is_nullable: 'YES' },
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
      { column_name: 'compiler_version', is_nullable: 'NO' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'created_by_console_account_id', is_nullable: 'NO' },
      { column_name: 'definition', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'kind', is_nullable: 'NO' },
      { column_name: 'scenario_id', is_nullable: 'NO' },
      { column_name: 'source_digest', is_nullable: 'NO' },
      { column_name: 'version_no', is_nullable: 'YES' },
    ])
  })

  it('scenario_drafts 的列与 Drizzle 定义一致', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'scenario_drafts' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(rows).toEqual([
      { column_name: 'document', is_nullable: 'NO' },
      { column_name: 'revision', is_nullable: 'NO' },
      { column_name: 'scenario_id', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
      { column_name: 'updated_by_console_account_id', is_nullable: 'NO' },
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
      { column_name: 'evidence_status', is_nullable: 'NO' },
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
      { column_name: 'object_id', is_nullable: 'YES' },
      { column_name: 'object_key', is_nullable: 'YES' },
      { column_name: 'payload', is_nullable: 'YES' },
      { column_name: 'run_id', is_nullable: 'NO' },
      { column_name: 'schema_version', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'step_run_id', is_nullable: 'YES' },
      { column_name: 'type', is_nullable: 'NO' },
      { column_name: 'upload_attempts', is_nullable: 'NO' },
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

  it('workers / run_leases 的列与部分唯一索引一致', async () => {
    const { rows: workerCols } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'workers' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(workerCols).toEqual([
      { column_name: 'capacity', is_nullable: 'NO' },
      { column_name: 'heartbeat_at', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'instance_id', is_nullable: 'NO' },
      { column_name: 'max_sessions', is_nullable: 'NO' },
      { column_name: 'started_at', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'stopped_at', is_nullable: 'YES' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ])

    const { rows: workerChecks } = await pool.query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'workers' AND c.contype = 'c'`,
      [TEST_SCHEMA],
    )
    expect(workerChecks.map((row) => row.conname)).toEqual(
      expect.arrayContaining(['workers_capacity_check', 'workers_max_sessions_check']),
    )

    const { rows: leaseCols } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'run_leases' ORDER BY column_name`,
      [TEST_SCHEMA],
    )
    expect(leaseCols).toEqual([
      { column_name: 'acquired_at', is_nullable: 'NO' },
      { column_name: 'expires_at', is_nullable: 'NO' },
      { column_name: 'fencing_token', is_nullable: 'NO' },
      { column_name: 'heartbeat_at', is_nullable: 'NO' },
      { column_name: 'holder_worker_id', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'release_reason', is_nullable: 'YES' },
      { column_name: 'released_at', is_nullable: 'YES' },
      { column_name: 'run_id', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
    ])

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename IN ('run_leases', 'workers')
       ORDER BY indexname`,
      [TEST_SCHEMA],
    )
    expect(indexes.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['run_leases_active_idx', 'run_leases_token_idx', 'run_leases_holder_idx', 'run_leases_reap_idx']),
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
    const textIdExceptions = new Set(['workers.id'])
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name <> '_migrations'
         AND (column_name = 'id' OR column_name LIKE '%\\_id')
       ORDER BY table_name, column_name`,
      [TEST_SCHEMA],
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.filter(
        (r) =>
          !workerIdColumns.has(r.column_name) &&
          !textIdExceptions.has(`${r.table_name}.${r.column_name}`) &&
          r.data_type !== 'uuid',
      ),
    ).toEqual([])
    expect(
      rows
        .filter(
          (r) =>
            workerIdColumns.has(r.column_name) || textIdExceptions.has(`${r.table_name}.${r.column_name}`),
        )
        .every((r) => r.data_type === 'text'),
    ).toBe(true)
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
      'object_id→stored_objects',
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
      '0010_admin_login_account.sql',
      '0011_run_lease.sql',
      '0012_session_affinity.sql',
      '0013_evidence_status.sql',
      '0014_recording_drafts.sql',
      '0015_scenario_drafts.sql',
      '0016_audit_login.sql',
      '0017_ai_execute.sql',
      '0018_product_roles.sql',
    ])
  })
})

/**
 * 带存量数据的升级路径。
 *
 * 空库全量迁移证明不了升级成立：0011 给 session_leases 加的是校验型 CHECK，
 * PostgreSQL 会扫全表，而 0008 时代写下的 ACTIVE 租约 run_fencing_token 一律是 NULL。
 * 少了迁移里那条补数据语句，这一步就会报 23514 并回滚整份 0011，
 * 任何跑过浏览器会话的库都再也升不上来。
 */
describe.skipIf(!parsed.success)('带存量数据的 0010 → 0011 升级（集成）', () => {
  const SCHEMA = `${TEST_SCHEMA}_upgrade`
  const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')
  let pool: Pool
  let throughDir: string
  let staleLeaseId: string
  let runId: string
  let sessionId: string

  beforeAll(async () => {
    const env = parsed.data!
    pool = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
    })

    // 只装到 0010：migrate 要求序号连续，所以把前十份复制进临时目录
    throughDir = mkdtempSync(join(tmpdir(), 'cairn-mig-0010-'))
    for (const filename of readdirSync(MIGRATIONS_DIR).sort().slice(0, 10)) {
      copyFileSync(resolve(MIGRATIONS_DIR, filename), resolve(throughDir, filename))
    }
    const through = await migrate(pool, SCHEMA, throughDir)
    expect(through.applied).toHaveLength(10)
    expect(through.applied.at(-1)).toBe('0010_admin_login_account.sql')

    // 0008 形状的存量现场：Worker 被 kill 后没人回收的 ACTIVE 租约，run_fencing_token 为 NULL
    const actorId = randomUUID()
    const targetId = randomUUID()
    const accountId = randomUUID()
    const scenarioId = randomUUID()
    const versionId = randomUUID()
    runId = randomUUID()
    sessionId = randomUUID()
    staleLeaseId = randomUUID()

    await pool.query(
      `INSERT INTO "${SCHEMA}".console_accounts (id, display_name, email, status)
       VALUES ($1, '升级夹具', $2, 'active')`,
      [actorId, `upgrade-${actorId}@example.com`],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".targets (id, code, name, entry_url)
       VALUES ($1, $2, '升级夹具', 'https://example.com')`,
      [targetId, `upgrade-${targetId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".target_accounts (id, target_id, display_name, username)
       VALUES ($1, $2, '升级账号', $3)`,
      [accountId, targetId, `u-${accountId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".scenarios (id, target_id, name, created_by_console_account_id)
       VALUES ($1, $2, '升级场景', $3)`,
      [scenarioId, targetId, actorId],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".scenario_versions
         (id, scenario_id, version_no, definition, created_by_console_account_id)
       VALUES ($1, $2, 1, '{"steps":[]}'::jsonb, $3)`,
      [versionId, scenarioId, actorId],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".runs
         (id, target_id, scenario_id, scenario_version_id, created_by_console_account_id,
          status, snapshot, snapshot_digest, context)
       VALUES ($1, $2, $3, $4, $5, 'RUNNING', '{}'::jsonb, 'digest', '{}'::jsonb)`,
      [runId, targetId, scenarioId, versionId, actorId],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".browser_sessions
         (id, target_id, target_account_id, status, health, owner_worker_id, generation,
          fencing_token, profile_key, reuse_policy, idle_ttl_seconds, max_lifetime_seconds, expires_at)
       VALUES ($1, $2, $3, 'OPEN', 'HEALTHY', 'killed-worker', 1, 1, $4,
               'REUSE_PAGE', 600, 3600, now() + interval '1 hour')`,
      [sessionId, targetId, accountId, `p/${sessionId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".session_leases
         (id, session_id, session_generation, session_fencing_token, run_id, run_fencing_token,
          holder_worker_id, status, expires_at)
       VALUES ($1, $2, 1, 1, $3, NULL, 'killed-worker', 'ACTIVE', now() + interval '30 seconds')`,
      [staleLeaseId, sessionId, runId],
    )
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await pool?.end()
    if (throughDir) rmSync(throughDir, { recursive: true, force: true })
  })

  it('0011 装得上，并把缺 run_fencing 的存量 ACTIVE 租约撤销', async () => {
    const up = await migrate(pool, SCHEMA)
    expect(up.applied).toEqual([
      '0011_run_lease.sql',
      '0012_session_affinity.sql',
      '0013_evidence_status.sql',
      '0014_recording_drafts.sql',
      '0015_scenario_drafts.sql',
      '0016_audit_login.sql',
      '0017_ai_execute.sql',
      '0018_product_roles.sql',
    ])

    const { rows } = await pool.query<{ status: string; release_reason: string; released_at: Date }>(
      `SELECT status, release_reason, released_at FROM "${SCHEMA}".session_leases WHERE id = $1`,
      [staleLeaseId],
    )
    expect(rows[0]?.status).toBe('REVOKED')
    expect(rows[0]?.release_reason).toBe('pre_0011_missing_run_fencing')
    expect(rows[0]?.released_at).not.toBeNull()
  })

  it('装完之后新的 ACTIVE 租约仍必须带 run_fencing', async () => {
    await expect(
      pool.query(
        `INSERT INTO "${SCHEMA}".session_leases
           (id, session_id, session_generation, session_fencing_token, run_id, run_fencing_token,
            holder_worker_id, status, expires_at)
         VALUES ($1, $2, 1, 2, $3, NULL, 'w', 'ACTIVE', now() + interval '30 seconds')`,
        [randomUUID(), sessionId, runId],
      ),
    ).rejects.toThrow(/session_leases_run_fencing_active_check/)
  })
})

describe.skipIf(!parsed.success)('带存量数据的 0012 → 0013 升级（集成）', () => {
  const SCHEMA = `${TEST_SCHEMA}_ev13`
  const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../migrations')
  let pool: Pool
  let throughDir: string
  let succeededRunId: string
  let runningRunId: string
  let reviewRunId: string
  let availableEvidenceId: string
  let missingEvidenceId: string

  beforeAll(async () => {
    const env = parsed.data!
    pool = new Pool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
    })
    throughDir = mkdtempSync(join(tmpdir(), 'cairn-mig-0012-'))
    for (const filename of readdirSync(MIGRATIONS_DIR).sort().slice(0, 12)) {
      copyFileSync(resolve(MIGRATIONS_DIR, filename), resolve(throughDir, filename))
    }
    const through = await migrate(pool, SCHEMA, throughDir)
    expect(through.applied).toHaveLength(12)
    expect(through.applied.at(-1)).toBe('0012_session_affinity.sql')

    const actorId = randomUUID()
    const targetId = randomUUID()
    const scenarioId = randomUUID()
    const versionId = randomUUID()
    succeededRunId = randomUUID()
    runningRunId = randomUUID()
    reviewRunId = randomUUID()
    availableEvidenceId = randomUUID()
    missingEvidenceId = randomUUID()

    await pool.query(
      `INSERT INTO "${SCHEMA}".console_accounts (id, display_name, email, status)
       VALUES ($1, '升级夹具', $2, 'active')`,
      [actorId, `ev13-${actorId}@example.com`],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".targets (id, code, name, entry_url)
       VALUES ($1, $2, '升级夹具', 'https://example.com')`,
      [targetId, `ev13-${targetId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".scenarios (id, target_id, name, created_by_console_account_id)
       VALUES ($1, $2, '升级场景', $3)`,
      [scenarioId, targetId, actorId],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".scenario_versions
         (id, scenario_id, version_no, definition, created_by_console_account_id)
       VALUES ($1, $2, 1, '{"steps":[]}'::jsonb, $3)`,
      [versionId, scenarioId, actorId],
    )
    for (const [id, status] of [
      [succeededRunId, 'SUCCEEDED'],
      [runningRunId, 'RUNNING'],
      [reviewRunId, 'NEEDS_REVIEW'],
    ] as const) {
      await pool.query(
        `INSERT INTO "${SCHEMA}".runs
           (id, target_id, scenario_id, scenario_version_id, created_by_console_account_id,
            status, snapshot, snapshot_digest, context)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'digest', '{}'::jsonb)`,
        [id, targetId, scenarioId, versionId, actorId, status],
      )
    }
    await pool.query(
      `INSERT INTO "${SCHEMA}".evidences (id, run_id, type, payload)
       VALUES ($1, $2, 'output', '{"ok":true}'::jsonb)`,
      [availableEvidenceId, succeededRunId],
    )
    await pool.query(
      `INSERT INTO "${SCHEMA}".evidences (id, run_id, type, missing_reason)
       VALUES ($1, $2, 'screenshot', 'object_store_unavailable')`,
      [missingEvidenceId, succeededRunId],
    )
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await pool?.end()
    if (throughDir) rmSync(throughDir, { recursive: true, force: true })
  })

  it('0013 装得上，回填不产生 status 与 missing_reason 矛盾行', async () => {
    const up = await migrate(pool, SCHEMA)
    expect(up.applied).toEqual([
      '0013_evidence_status.sql',
      '0014_recording_drafts.sql',
      '0015_scenario_drafts.sql',
      '0016_audit_login.sql',
      '0017_ai_execute.sql',
      '0018_product_roles.sql',
    ])

    const { rows: runRows } = await pool.query<{ id: string; evidence_status: string }>(
      `SELECT id, evidence_status FROM "${SCHEMA}".runs WHERE id = ANY($1::uuid[])`,
      [[succeededRunId, runningRunId, reviewRunId]],
    )
    const byId = Object.fromEntries(runRows.map((row) => [row.id, row.evidence_status]))
    expect(byId[succeededRunId]).toBe('COMPLETE')
    expect(byId[runningRunId]).toBe('PENDING')
    expect(byId[reviewRunId]).toBe('PENDING')

    const { rows: evidenceRows } = await pool.query<{ id: string; status: string; missing_reason: string | null }>(
      `SELECT id, status, missing_reason FROM "${SCHEMA}".evidences WHERE id = ANY($1::uuid[])`,
      [[availableEvidenceId, missingEvidenceId]],
    )
    const evidenceById = Object.fromEntries(evidenceRows.map((row) => [row.id, row]))
    expect(evidenceById[availableEvidenceId]).toMatchObject({ status: 'available', missing_reason: null })
    expect(evidenceById[missingEvidenceId]).toMatchObject({
      status: 'missing',
      missing_reason: 'object_store_unavailable',
    })

    const { rows: contradictions } = await pool.query(
      `SELECT id FROM "${SCHEMA}".evidences
       WHERE (status = 'missing') <> (missing_reason IS NOT NULL)`,
    )
    expect(contradictions).toEqual([])
  })

  it('CHECK 拒绝 available + missing_reason', async () => {
    await expect(
      pool.query(
        `INSERT INTO "${SCHEMA}".evidences (id, run_id, type, status, missing_reason)
         VALUES ($1, $2, 'log', 'available', 'object_purged')`,
        [randomUUID(), succeededRunId],
      ),
    ).rejects.toThrow(/evidences_status_missing_reason_check/)
  })
})
