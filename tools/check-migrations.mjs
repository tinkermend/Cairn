#!/usr/bin/env node
// CI 检查：迁移文件名规范、前缀唯一、序号连续；导出版本必须跟目录走。
// 前一代平台出现过两个 0005、两个 0018 和缺失的 0016——执行顺序由
// 前缀之后的名字决定，同前缀文件会让顺序变得不可预测。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertTransferUsesDerivedVersion,
  defaultMigrationsRoot,
  inspectMigrations,
} from './lib/migrations.mjs'

const root = defaultMigrationsRoot()
const { errors, total } = inspectMigrations(root)
const transfer = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../packages/db/src/transfer.ts'),
  'utf8',
)
const transferError = assertTransferUsesDerivedVersion(transfer)
if (transferError) errors.push(transferError)

if (errors.length) {
  console.error('迁移文件检查未通过：')
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✅ 迁移文件检查通过（PostgreSQL / MySQL 共 ${total} 个）`)
