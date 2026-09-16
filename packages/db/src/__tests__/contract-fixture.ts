import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DbEnv } from '@cairn/shared'
import { createDb, type DbHandle } from '../client.js'
import { expose } from '../database.js'
import { migrateDatabase } from '../migrate-native.js'
import { openIsolatedDb, requireReachableDb } from '../testing.js'
import { newId } from '../id.js'

export const SUPPORTED_CONTRACT_DRIVERS = ['postgres', 'mysql'] as const
export type ContractDriver = (typeof SUPPORTED_CONTRACT_DRIVERS)[number]

function configuredContractDrivers(): ContractDriver[] {
  const configured = process.env.CAIRN_DB_CONTRACT_DRIVERS
  if (!configured) return ['postgres']
  const requested = configured.split(',').map((driver) => driver.trim()).filter(Boolean)
  const unsupported = requested.filter(
    (driver) => !SUPPORTED_CONTRACT_DRIVERS.includes(driver as ContractDriver),
  )
  if (unsupported.length) {
    throw new Error(
      `CAIRN_DB_CONTRACT_DRIVERS 只接受 ${SUPPORTED_CONTRACT_DRIVERS.join(',')}；收到 ${unsupported.join(',')}`,
    )
  }
  return [...new Set(requested as ContractDriver[])]
}

// 常规回归只跑 PostgreSQL；兼容性命令显式设置 PostgreSQL,MySQL。
export const DRIVERS: readonly ContractDriver[] = configuredContractDrivers()
export async function openContractDb(
  driver: ContractDriver,
  _label?: string,
): Promise<DbHandle & { env: DbEnv }> {
  const name = `cairn_port_${newId().replaceAll('-', '')}`
  if (driver === 'postgres') {
    const handle = await openIsolatedDb(name)
    return Object.assign(handle, { env: { ...(await requireReachableDb()), CAIRN_DB_NAME: name } })
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
