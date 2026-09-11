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

  /**
   * 空闲连接出错（网络抖动、PG 重启、被 DBA 断开）时，pg 把错误抛在 Pool 上。
   * 没有监听者，它就是 EventEmitter 的未处理 'error'——整个 api / worker 进程被掀掉。
   *
   * 池子自己会摘掉坏连接并继续服务，所以这里只记录不重抛。真正的失败仍会在
   * 具体查询上抛出来，由调用方处理；执行事实的真相在库里（宪法 §11），
   * 进程崩不掉比崩掉更容易恢复。
   */
  pool.on('error', (error) => {
    console.error(`[db] 空闲连接错误：${error instanceof Error ? error.message : error}`)
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
