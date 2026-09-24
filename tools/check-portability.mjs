#!/usr/bin/env node
// 数据库可移植检查：新 PG 迁移不得使用专有特性；@cairn/db 适配层以外的运行时代码，方言写法只许减少不许增加。
// 规则与理由见 tools/lib/portability.mjs；`--update-baseline` 仅在命中确实减少后用来收紧基线。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODE_ADAPTER_FILES,
  MIGRATION_CHECK_AFTER,
  checkMigrationSql,
  compareWithBaseline,
  countCodeHits,
} from './lib/portability.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = resolve(root, 'packages/db/migrations')
const srcDir = resolve(root, 'packages/db/src')
const baselinePath = resolve(root, 'tools/portability-baseline.json')

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'fixtures' || entry.name.startsWith('.')) continue
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name)) yield full
  }
}

const errors = []

const migrations = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) > MIGRATION_CHECK_AFTER)
  .sort()
for (const filename of migrations) {
  for (const issue of checkMigrationSql(filename, readFileSync(resolve(migrationsDir, filename), 'utf8'))) {
    errors.push(`migrations/${issue.file} [${issue.rule}]：${issue.message}`)
  }
}

const current = {}
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file).split(sep).join('/')
  if (CODE_ADAPTER_FILES.has(rel)) continue
  const counts = countCodeHits(readFileSync(file, 'utf8'))
  if (Object.keys(counts).length) current[rel] = counts
}

if (process.argv.includes('--update-baseline')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`已写入基线：${Object.keys(sorted).length} 个文件`)
  process.exit(0)
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
const { errors: codeErrors, shrunk } = compareWithBaseline(current, baseline)
errors.push(...codeErrors.map((e) => `packages/db/src/${e}`))

if (errors.length) {
  console.error('数据库可移植检查未通过（平台设计不得绑定某个数据库的专有特性，见 deploy/database-backends.md）：')
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error('确属必要的迁移语句可在该语句内加 `-- portability-exception: <原因>`；运行时代码的方言写法应移入 native.ts 适配层。')
  process.exit(1)
}
if (shrunk.length) {
  console.log(`ℹ 方言写法已减少，可运行 node tools/check-portability.mjs --update-baseline 收紧基线：\n  ${shrunk.join('\n  ')}`)
}
console.log(`✅ 数据库可移植检查通过（新迁移 ${migrations.length} 个，基线内存量 ${Object.keys(baseline).length} 个文件）`)
