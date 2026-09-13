import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDb } from '../client.js'
import { dbEnvSchema, formatEnvIssues } from '@cairn/shared'
import { migrateDatabase } from '../migrate-native.js'

const envFile = resolve(import.meta.dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

// 配置错误以逐行「变量名: 原因」结束，不把 zod 的 issue 结构甩给执行迁移的人
const parsed = dbEnvSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('cairn-db-migrate 配置校验失败，进程拒绝启动：')
  for (const line of formatEnvIssues(parsed.error)) console.error(`  ✗ ${line}`)
  process.exit(1)
}
const env = parsed.data

const handle = createDb(env)

try {
  const { applied, skipped } = await migrateDatabase(handle, env)
  for (const f of skipped) console.log(`  已应用，跳过  ${f}`)
  for (const f of applied) console.log(`  ✅ 已执行     ${f}`)
  console.log(
    applied.length
      ? `\n${env.CAIRN_DB_DRIVER}: 新执行 ${applied.length} 个迁移`
      : `\n${env.CAIRN_DB_DRIVER}: 已是最新`,
  )
} finally {
  await handle.close()
}
