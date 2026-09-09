import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import type { DbEnv } from '@cairn/shared'

export type Db = NodePgDatabase<Record<string, never>>

export interface DbHandle {
  db: Db
  pool: Pool
  /** `select 1` 探活。连接不可用时抛错。 */
  ping: () => Promise<boolean>
  close: () => Promise<void>
}

/**
 * 建立连接池。api 与 worker 共用这一份——它们是两个进程，
 * 但只通过 PostgreSQL 通信，不共享内存状态。
 */
export function createDb(env: DbEnv): DbHandle {
  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    // migration 内用 "__SCHEMA__" 占位，运行时由此指定实际 schema
    options: `-c search_path=${env.CAIRN_DB_SCHEMA},public`,
  })

  const db = drizzle(pool)

  return {
    db,
    pool,
    ping: async () => {
      const result = await db.execute(sql`select 1 as ok`)
      return result.rows.length === 1
    },
    close: () => pool.end(),
  }
}
