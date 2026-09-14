import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { DbEnv } from '@cairn/shared'
import type { DbHandle } from './client.js'
import { loadMigrations, migrate, type MigrateResult } from './migrate.js'

async function assertBackendSupported(handle: DbHandle): Promise<void> {
  if (handle.driver === 'postgres') {
    const rows = await handle.raw('SHOW server_version_num')
    if (Number(rows[0]!.server_version_num) < 160000) throw new Error('PostgreSQL 16+ required')
  } else if (handle.driver === 'mysql') {
    const rows = await handle.raw('SELECT VERSION() AS version')
    if (!/^8\.(?:[4-9]|[1-9][0-9])\./.test(String(rows[0]!.version)))
      throw new Error('MySQL 8.4+ (8.x) required')
  } else {
    const rows = await handle.raw('SELECT sqlite_version() AS version')
    const [major, minor] = String(rows[0]!.version).split('.').map(Number)
    if (major !== 3 || minor! < 45) throw new Error('SQLite 3.45+ required')
  }
}

export async function migrateDatabase(handle: DbHandle, env: DbEnv): Promise<MigrateResult> {
  await assertBackendSupported(handle)
  if (env.CAIRN_DB_DRIVER === 'postgres') return migrate(handle.pool!, env.CAIRN_DB_SCHEMA)
  const dir = resolve(import.meta.dirname, '../migrations', env.CAIRN_DB_DRIVER)
  const migrations = loadMigrations(dir)
  await handle.raw(
    `CREATE TABLE IF NOT EXISTS _migrations (prefix VARCHAR(4) PRIMARY KEY, filename VARCHAR(128) NOT NULL, checksum VARCHAR(64) NOT NULL, state VARCHAR(16) NOT NULL)`,
  )
  const records = await handle.raw('SELECT * FROM _migrations')
  const known = new Set(migrations.map((m) => m.prefix))
  if (records.some((r) => !known.has(String(r.prefix))))
    throw new Error('Unknown database schema version')
  const applied: string[] = [],
    skipped: string[] = []
  for (const m of migrations) {
    const checksum = createHash('sha256').update(m.sql).digest('hex')
    const existing = records.find((r) => r.prefix === m.prefix)
    if (existing) {
      if (
        existing.state !== 'complete' ||
        existing.checksum !== checksum ||
        existing.filename !== m.filename
      ) {
        throw new Error(
          `Migration ${m.filename} is incomplete or changed; restore a verified backup or recreate this isolated target before retrying`,
        )
      }
      skipped.push(m.filename)
      continue
    }
    // MySQL DDL commits implicitly. A durable running marker deliberately blocks
    // startup after interruption; never pretend this migration can roll back.
    await handle.raw(
      'INSERT INTO _migrations (prefix, filename, checksum, state) VALUES (?, ?, ?, ?)',
      [m.prefix, m.filename, checksum, 'running'],
    )
    const statements = m.sql
      .replace(/^--.*$/gm, '')
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean)
    try {
      for (const statement of statements) await handle.raw(statement)
      if (handle.driver === 'sqlite' && (await handle.raw('PRAGMA foreign_key_check')).length) throw new Error('Migration produced foreign key violations')
      await handle.raw("UPDATE _migrations SET state = 'complete' WHERE prefix = ?", [m.prefix])
      applied.push(m.filename)
    } catch (cause) {
      throw new Error(`Migration ${m.filename} failed; target remains blocked`, { cause })
    }
  }
  return { applied, skipped }
}

export async function assertSchemaReady(handle: DbHandle, env: DbEnv): Promise<void> {
  await assertBackendSupported(handle)
  const dir =
    env.CAIRN_DB_DRIVER === 'postgres'
      ? undefined
      : resolve(import.meta.dirname, '../migrations', env.CAIRN_DB_DRIVER)
  const migrations = loadMigrations(dir)
  const table =
    env.CAIRN_DB_DRIVER === 'postgres' ? `"${env.CAIRN_DB_SCHEMA}"._migrations` : '_migrations'
  const records = await handle.raw(`SELECT * FROM ${table}`)
  if (
    records.length !== migrations.length ||
    migrations.some(
      (m) =>
        !records.some(
          (r) =>
            r.prefix === m.prefix &&
            r.filename === m.filename &&
            (env.CAIRN_DB_DRIVER === 'postgres' ||
              (r.state === 'complete' &&
                r.checksum === createHash('sha256').update(m.sql).digest('hex'))),
        ),
    )
  )
    throw new Error(
      'Database schema is missing, incomplete or incompatible; run the matching migration CLI',
    )
}
