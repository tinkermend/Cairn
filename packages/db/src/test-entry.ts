/** Native access is intentionally available only from @cairn/db/testing. */
export { newId } from './id.js'
export type { Db } from './client.js'
export type { DbHandle as NativeHandle } from './client.js'
export {
  requireReachableDb,
  openIsolatedDb,
  setupTestTemplateDatabase,
  teardownTestTemplateDatabase,
  type PgTestHandle as DbHandle,
} from './testing.js'
export { migrate, loadMigrations } from './migrate.js'
export { migrateDatabase, assertSchemaReady } from './migrate-native.js'
export { schemaFor, databaseNow, afterSeconds, updateRows, insertRows, clockNow, onCommit, atomic } from './native.js'
export { expose, registerFixture } from './database.js'
export { recordAudit } from './audit/record.js'
export { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
export * from './schema/index.js'
export * from './runs/index.js'
export * from './leases/index.js'
export * from './sessions/index.js'
export * from './objects/index.js'
export * from './observe/index.js'
export * from './recordings/index.js'
import { createDb as openNative } from './client.js'
import { registerFixture } from './database.js'
import type { DbEnv } from '@cairn/shared'
import type { PgTestHandle } from './testing.js'
export function createDb(env: DbEnv): PgTestHandle {
  if (env.CAIRN_DB_DRIVER !== 'postgres')
    throw new Error('Use openNativeDatabase for non-PG contract fixtures')
  return registerFixture(openNative(env)) as PgTestHandle
}
export const openNativeDatabase = (env: DbEnv) => registerFixture(openNative(env))

export { mapPgRestriction } from './runs/errors.js'

import { dbEnvSchema, type PostgresDbEnv } from '@cairn/shared'
import { z } from 'zod'
export const postgresEnvSchema = dbEnvSchema.pipe(
  z.custom<PostgresDbEnv>(
    (value) =>
      !!value &&
      typeof value === 'object' &&
      'CAIRN_DB_DRIVER' in value &&
      value.CAIRN_DB_DRIVER === 'postgres',
    'PG-specific test requires postgres',
  ),
)
