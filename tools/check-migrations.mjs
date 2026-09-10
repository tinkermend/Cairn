#!/usr/bin/env node
// CI 检查：迁移文件名规范、前缀唯一、序号连续。
// 前一代平台出现过两个 0005、两个 0018 和缺失的 0016——执行顺序由
// 前缀之后的名字决定，同前缀文件会让顺序变得不可预测。
import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/db/migrations')
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const errors = []
const seen = new Map()

files.forEach((f, i) => {
  const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f)
  if (!m) return errors.push(`文件名不合规范（应为 NNNN_name.sql）：${f}`)
  const prefix = m[1]
  if (seen.has(prefix)) errors.push(`前缀重复：${prefix} → ${seen.get(prefix)} 与 ${f}`)
  seen.set(prefix, f)
  const expected = String(i + 1).padStart(4, '0')
  if (prefix !== expected) errors.push(`序号不连续：期望 ${expected}，实际 ${prefix}（${f}）`)
})

if (errors.length) {
  console.error('迁移文件检查未通过：')
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✅ 迁移文件检查通过（${files.length} 个）`)
