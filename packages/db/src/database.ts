import type { DbEnv } from '@cairn/shared'
import { createDb as openNative, type Db, type DbHandle as NativeHandle } from './client.js'

/** Business code owns lifecycle and passes this opaque handle to operations. */
export interface Database {
  readonly driver: 'postgres' | 'mysql' | 'sqlite'
  ping(): Promise<boolean>
  close(): Promise<void>
}
const handles = new WeakMap<object, NativeHandle>()
export function expose(handle: NativeHandle): Database {
  const database: Database = {
    driver: handle.driver,
    ping: () => handle.ping(),
    close: () => handle.close(),
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
