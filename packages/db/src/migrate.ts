import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Pool } from 'pg'

export interface Migration {
  /** 文件名前缀，如 '0001' */
  prefix: string
  filename: string
  sql: string
}

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../migrations')
const FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/

/**
 * 读取并校验迁移文件。
 *
 * 前一代平台出现过两个 0005、两个 0018 和缺失的 0016——执行顺序由
 * 前缀之后的名字决定，任何新增同前缀文件都可能改变相对顺序。这里在
 * 运行时就拦住，CI 另有一份静态检查（tools/check-migrations.mjs）。
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  const seen = new Map<string, string>()
  const migrations: Migration[] = []

  for (const filename of files) {
    const match = FILENAME_PATTERN.exec(filename)
    if (!match) {
      throw new Error(`迁移文件名不合规范（应为 NNNN_name.sql）：${filename}`)
    }
    const prefix = match[1]!

    const duplicate = seen.get(prefix)
    if (duplicate) {
      throw new Error(`迁移前缀重复：${prefix} 同时出现在 ${duplicate} 与 ${filename}`)
    }
    seen.set(prefix, filename)

    migrations.push({ prefix, filename, sql: readFileSync(resolve(dir, filename), 'utf8') })
  }

  // 序号必须连续，缺号说明有迁移被删除或未合入，历史不完整
  migrations.forEach((m, i) => {
    const expected = String(i + 1).padStart(4, '0')
    if (m.prefix !== expected) {
      throw new Error(`迁移序号不连续：期望 ${expected}，实际 ${m.prefix}（${m.filename}）`)
    }
  })

  return migrations
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
}

/**
 * 执行未应用的迁移。
 *
 * 每个迁移在独立事务中执行，与记录写入同一事务——不存在
 * 「SQL 执行了但没记录」或反之的中间态。
 */
export async function migrate(
  pool: Pool,
  schema: string,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrateResult> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`schema 名不合法：${schema}`)
  }

  const migrations = loadMigrations(dir)
  const applied: string[] = []
  const skipped: string[] = []

  const client = await pool.connect()
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"._migrations (
        prefix      TEXT PRIMARY KEY,
        filename    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query<{ prefix: string }>(
      `SELECT prefix FROM "${schema}"._migrations`,
    )
    const done = new Set(rows.map((r) => r.prefix))

    for (const m of migrations) {
      if (done.has(m.prefix)) {
        skipped.push(m.filename)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(m.sql.replaceAll('__SCHEMA__', schema))
        await client.query(
          `INSERT INTO "${schema}"._migrations (prefix, filename) VALUES ($1, $2)`,
          [m.prefix, m.filename],
        )
        await client.query('COMMIT')
        applied.push(m.filename)
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`迁移 ${m.filename} 失败：${(error as Error).message}`, { cause: error })
      }
    }
  } finally {
    client.release()
  }

  return { applied, skipped }
}
