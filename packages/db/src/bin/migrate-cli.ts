import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { dbEnvSchema } from '@cairn/shared'
import { migrate } from '../migrate.js'

const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const env = dbEnvSchema.parse(process.env)
const pool = new Pool({
  host: env.CAIRN_DB_HOST,
  port: env.CAIRN_DB_PORT,
  database: env.CAIRN_DB_NAME,
  user: env.CAIRN_DB_USER,
  password: env.CAIRN_DB_PASSWORD,
})

try {
  const { applied, skipped } = await migrate(pool, env.CAIRN_DB_SCHEMA)
  for (const f of skipped) console.log(`  已应用，跳过  ${f}`)
  for (const f of applied) console.log(`  ✅ 已执行     ${f}`)
  console.log(
    applied.length
      ? `\n${env.CAIRN_DB_SCHEMA}: 新执行 ${applied.length} 个迁移`
      : `\n${env.CAIRN_DB_SCHEMA}: 已是最新`,
  )
} finally {
  await pool.end()
}
