import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { DbEnv } from '@cairn/shared'
import { createDb, type DbHandle } from '../client.js'
import { loadMigrations } from '../migrate.js'
import { newId } from '../id.js'

const mysqlPassword =
  process.env.CAIRN_TEST_MYSQL_PASSWORD ??
  (() => {
    try {
      const file =
        process.env.CAIRN_TEST_MYSQL_ENV_FILE ??
        resolve(import.meta.dirname, '../../../../.run/database-portability/mysql.env')
      return readFileSync(file, 'utf8').match(/^MYSQL_ROOT_PASSWORD=(.+)$/m)?.[1]
    } catch {
      return undefined
    }
  })()

const mysqlRequested = (process.env.CAIRN_DB_CONTRACT_DRIVERS ?? '')
  .split(',')
  .map((item) => item.trim())
  .includes('mysql')

async function applyMysqlMigrations(handle: DbHandle, throughPrefix: string): Promise<string[]> {
  const dir = resolve(import.meta.dirname, '../../migrations/mysql')
  const migrations = loadMigrations(dir)
  await handle.raw(
    `CREATE TABLE IF NOT EXISTS _migrations (prefix VARCHAR(4) PRIMARY KEY, filename VARCHAR(128) NOT NULL, checksum VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL)`,
  )
  const records = await handle.raw('SELECT prefix FROM _migrations')
  const done = new Set(records.map((row) => String(row.prefix)))
  const applied: string[] = []
  for (const migration of migrations) {
    if (migration.prefix > throughPrefix) break
    if (done.has(migration.prefix)) continue
    const checksum = createHash('sha256').update(migration.sql).digest('hex')
    await handle.raw(
      'INSERT INTO _migrations (prefix, filename, checksum, state) VALUES (?, ?, ?, ?)',
      [migration.prefix, migration.filename, checksum, 'running'],
    )
    const statements = migration.sql
      .replace(/^--.*$/gm, '')
      .split(/;\s*(?:\n|$)/)
      .map((item) => item.trim())
      .filter(Boolean)
    for (const statement of statements) await handle.raw(statement)
    await handle.raw("UPDATE _migrations SET state = 'complete' WHERE prefix = ?", [migration.prefix])
    applied.push(migration.filename)
  }
  return applied
}

describe.skipIf(!mysqlRequested || !mysqlPassword)('MySQL 存量库重放 0039 → 0040', () => {
  const name = `cairn_ah40_${newId().replaceAll('-', '').slice(0, 16)}`
  let admin: DbHandle
  let handle: DbHandle

  afterAll(async () => {
    await handle?.close()
    if (admin) {
      try {
        await admin.raw(`DROP DATABASE \`${name}\``)
      } finally {
        await admin.close()
      }
    }
  })

  it('先外键再约束索引再列，存量会话行仍在且 auth_hold 列已摘除', async () => {
    const env: DbEnv = {
      CAIRN_DB_DRIVER: 'mysql',
      CAIRN_DB_HOST: process.env.CAIRN_TEST_MYSQL_HOST ?? '127.0.0.1',
      CAIRN_DB_PORT: Number(process.env.CAIRN_TEST_MYSQL_PORT ?? 3307),
      CAIRN_DB_USER: process.env.CAIRN_TEST_MYSQL_USER ?? 'root',
      CAIRN_DB_PASSWORD: mysqlPassword!,
      CAIRN_DB_NAME: process.env.CAIRN_TEST_MYSQL_DATABASE ?? 'cairn_portability',
    }
    admin = createDb(env)
    await admin.raw(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
    handle = createDb({ ...env, CAIRN_DB_NAME: name })
    const through = await applyMysqlMigrations(handle, '0039')
    expect(through.at(-1)).toBe('0039_session_auth_driven_retention.sql')

    const actorId = newId()
    const targetId = newId()
    const accountId = newId()
    const sessionId = newId()
    await handle.raw(
      `INSERT INTO console_accounts (id, display_name, email, status) VALUES (?, 'AH-40', ?, 'active')`,
      [actorId, `ah40-${actorId}@example.com`],
    )
    await handle.raw(
      `INSERT INTO targets (id, code, name, entry_url) VALUES (?, ?, 'AH-40', 'https://example.com')`,
      [targetId, `ah40-${targetId.slice(0, 8)}`],
    )
    await handle.raw(
      `INSERT INTO target_accounts (id, target_id, display_name, username) VALUES (?, ?, 'AH-40', ?)`,
      [accountId, targetId, `u-${accountId.slice(0, 8)}`],
    )
    await handle.raw(
      `INSERT INTO browser_sessions
         (id, target_id, target_account_id, status, health, owner_worker_id, generation,
          fencing_token, profile_key, reuse_policy, idle_ttl_seconds, max_lifetime_seconds, expires_at)
       VALUES (?, ?, ?, 'OPEN', 'HEALTHY', 'ah40-worker', 1, 1, ?, 'REUSE_PAGE', 600, 3600, DATE_ADD(NOW(3), INTERVAL 1 HOUR))`,
      [sessionId, targetId, accountId, `p/${sessionId.slice(0, 8)}`],
    )
    const occupied = await handle.raw(
      'SELECT count(*) AS n FROM browser_sessions WHERE auth_hold_worker_id IS NOT NULL',
    )
    expect(Number(occupied[0]?.n ?? occupied[0]?.['count(*)'])).toBe(0)

    const dropped = await applyMysqlMigrations(handle, '0040')
    expect(dropped).toEqual(['0040_drop_legacy_auth_hold.sql'])
    const leftover = await handle.raw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'browser_sessions' AND column_name LIKE 'auth_hold_%'`,
      [name],
    )
    expect(leftover).toEqual([])
    const rows = await handle.raw('SELECT id, status FROM browser_sessions WHERE id = ?', [sessionId])
    expect(rows).toEqual([{ id: sessionId, status: 'OPEN' }])
  })
})
