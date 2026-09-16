#!/usr/bin/env node
// 在锁内领取 PostgreSQL / MySQL 的下一号并立刻落盘。占号就是文件本身，避免并发任务扫到同一个最大号。
import { allocateMigration } from './lib/migrations.mjs'

const name = process.argv[2]
if (!name || name.startsWith('-')) {
  console.error('用法：pnpm db:new-migration <name>')
  console.error('name 仅为小写字母开头的 [a-z0-9_]+，例如 map_facts')
  process.exit(2)
}

try {
  const result = await allocateMigration({ name })
  console.log('已领取：')
  for (const file of result.files) {
    console.log(`  ${file.backend.padEnd(8)} ${file.filename}`)
  }
  console.log(`logicalVersion 现为 ${result.logicalVersion}（随 PG 最新前缀，不必手改 transfer.ts）`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
