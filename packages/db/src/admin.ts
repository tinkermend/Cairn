/** Explicit administration entry; unavailable to API/Worker business modules. */
import type { DbEnv } from '@cairn/shared'
import { nativeHandle, type Database } from './database.js'
import { migrateDatabase, assertSchemaReady } from './migrate-native.js'
export const migrate = (database: Database, env: DbEnv) =>
  migrateDatabase(nativeHandle(database), env)
export const assertReady = (database: Database, env: DbEnv) =>
  assertSchemaReady(nativeHandle(database), env)
export {
  exportDatabase,
  importDatabase,
  type DatabaseBundle,
  type TransferOptions,
  type ObjectToVerify,
} from './transfer.js'
