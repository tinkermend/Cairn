import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { dbEnvSchema, formatEnvIssues, type DbEnv } from '@cairn/shared'

/** 仓库根 `.env`。与 api / worker 的读取路径同源：本地读它，CI 由环境变量提供。 */
const ENV_FILE = resolve(import.meta.dirname, '../../../.env')

/** 连不上时要快速失败，不能让「网络黑洞」把整个测试挂住。 */
const CONNECT_TIMEOUT_MS = 10_000

/**
 * 集成测试的库前置条件：**连不上就失败，不跳过**。
 *
 * 判据必须是「库能不能连上」，而不是「配置看起来有没有」。原先各集成测试用
 * `describe.skipIf(!parsed.success)` 判环境变量在不在，于是干净检出、CI 漏配或
 * 临时离线时整包变绿而一条都没跑——实测 db 包 `3 passed | 4 skipped`、退出码 0，
 * 「测试通过」这句话因此没有含义。
 *
 * 由 vitest 的 `globalSetup` 在跑用例之前调用，库不可用时整个包失败。
 * 失败信息只带 host / port / database 与配置项名，不带口令。
 */
export async function requireReachableDb(): Promise<DbEnv> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = formatEnvIssues(parsed.error)
      .map((line) => `  ✗ ${line}`)
      .join('\n')
    throw new Error(
      `集成测试需要可用的 PostgreSQL，但配置不完整（${ENV_FILE} 或环境变量）：\n${lines}\n` +
        '集成测试不会因为缺配置而跳过。',
    )
  }

  const env = parsed.data
  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c search_path=${env.CAIRN_DB_SCHEMA},public`,
  })

  try {
    await pool.query('select 1')
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `集成测试需要可用的 PostgreSQL，但连接 ` +
        `${env.CAIRN_DB_HOST}:${env.CAIRN_DB_PORT}/${env.CAIRN_DB_NAME} 失败：${reason}\n` +
        '库不可用时集成测试失败，不跳过。',
    )
  } finally {
    await pool.end()
  }

  return env
}
