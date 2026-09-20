import type { DbEnv } from '@cairn/shared'
import { createDb as openNative, type Db, type DbHandle as NativeHandle } from './client.js'

export type PoolStats = {
  totalCount: number
  idleCount: number
  waitingCount: number
}

/** Business code owns lifecycle and passes this opaque handle to operations. */
export interface Database {
  readonly driver: 'postgres' | 'mysql' | 'sqlite'
  ping(): Promise<boolean>
  close(): Promise<void>
  /** PG 返回进程内池水位；MySQL 没有公开计数 API，如实 null。测试夹具可不实现。 */
  poolStats?(): PoolStats | null
}
const handles = new WeakMap<object, NativeHandle>()

function readPoolStats(handle: NativeHandle): PoolStats | null {
  if (handle.driver !== 'postgres' || !handle.pool) return null
  return {
    totalCount: handle.pool.totalCount,
    idleCount: handle.pool.idleCount,
    waitingCount: handle.pool.waitingCount,
  }
}

export function expose(handle: NativeHandle): Database {
  const database: Database = {
    driver: handle.driver,
    ping: () => handle.ping(),
    close: () => handle.close(),
    poolStats: () => readPoolStats(handle),
  }
  handles.set(database, handle)
  return database
}
/** Only internal repositories, administration and test fixtures can unwrap. */
export function nativeHandle(database: Database): NativeHandle {
  const handle = handles.get(database)
  if (!handle) throw new Error('Unknown database handle')
  return handle
}
export function connection(database: Database): Db {
  return nativeHandle(database).db
}
export function createDatabase(env: DbEnv): Database {
  return expose(openNative(env))
}
export function operation<A extends unknown[], R>(
  fn: (db: Db, ...args: A) => R,
): (database: Database, ...args: A) => R {
  return (database, ...args) => fn(connection(database), ...args)
}
/** Test entry registers native fixtures without exposing unwrapping to production. */
export function registerFixture<T extends NativeHandle>(handle: T): T {
  handles.set(handle, handle)
  return handle
}
