import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DbEnv } from '@cairn/shared'
import { createDb, type DbHandle } from '../client.js'
import { expose } from '../database.js'
import { migrateDatabase } from '../migrate-native.js'
import { openIsolatedDb, requireReachableDb } from '../testing.js'
import { newId } from '../id.js'
export const DRIVERS = ['postgres', 'mysql', 'sqlite'] as const
export async function openContractDb(
  driver: (typeof DRIVERS)[number],
  _label?: string,
): Promise<DbHandle & { env: DbEnv }> {
  const name = `cairn_port_${newId().replaceAll('-', '')}`
  if (driver === 'postgres') {
    const handle = await openIsolatedDb(name)
    return Object.assign(handle, { env: { ...(await requireReachableDb()), CAIRN_DB_NAME: name } })
  }
  if (driver === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-port-'))
    const env: DbEnv = { CAIRN_DB_DRIVER: driver, CAIRN_DB_FILE: join(dir, 'cairn.sqlite') }
    const handle = createDb(env)
    try {
      await migrateDatabase(handle, env)
    } catch (e) {
      await handle.close()
      rmSync(dir, { recursive: true })
      throw e
    }
    return {
      ...handle,
      env,
      close: async () => {
        await handle.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }
  let password = process.env.CAIRN_TEST_MYSQL_PASSWORD
  if (!password) {
    const file =
      process.env.CAIRN_TEST_MYSQL_ENV_FILE ??
      resolve(import.meta.dirname, '../../../../.run/database-portability/mysql.env')
    password = readFileSync(file, 'utf8').match(/^MYSQL_ROOT_PASSWORD=(.+)$/m)?.[1]
  }
  if (!password) throw new Error('MySQL contract tests require CAIRN_TEST_MYSQL_PASSWORD')
  const env: DbEnv = {
    CAIRN_DB_DRIVER: driver,
    CAIRN_DB_HOST: process.env.CAIRN_TEST_MYSQL_HOST ?? '127.0.0.1',
    CAIRN_DB_PORT: Number(process.env.CAIRN_TEST_MYSQL_PORT ?? 3307),
    CAIRN_DB_USER: process.env.CAIRN_TEST_MYSQL_USER ?? 'root',
    CAIRN_DB_PASSWORD: password,
    CAIRN_DB_NAME: process.env.CAIRN_TEST_MYSQL_DATABASE ?? 'cairn_portability',
  }
  const admin = createDb(env)
  const targetEnv = { ...env, CAIRN_DB_NAME: name }
  await admin.raw(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
  const handle = createDb(targetEnv)
  const close = async () => {
    await handle.close()
    try {
      await admin.raw(`DROP DATABASE \`${name}\``)
    } finally {
      await admin.close()
    }
  }
  try {
    await migrateDatabase(handle, targetEnv)
  } catch (error) {
    await close()
    throw error
  }
  return { ...handle, env: targetEnv, close }
}
