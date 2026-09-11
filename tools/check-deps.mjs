#!/usr/bin/env node
// CI 检查：包边界与依赖方向。
//
// 这张允许边表就是架构决定本身——改边界必须改脚本，等于强制留下一次显式
// 决定，而不是等下次有人 import 错之后才发现方向早就没了。
//
// 为什么值得一个脚本：shared / db 一旦反向依赖进程包，公共契约就被拖进
// Nest 与运行时的世界，Slice 1 的领域 schema 会跟着一起变脏；进程包互相
// 依赖则让「API 不执行 Scenario、Worker 不回写 API」这条宪法边界失效。
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 包名前缀 → 允许依赖的仓内包前缀。
 *
 * - 库只能向下依赖库；进程包之间不得互为库依赖。
 * - 进程包通过 PostgreSQL 与通知机制协作，不通过 import。
 * - 浏览器扩展在 packages/extension/<plugin>/，彼此不得互为依赖；
 *   正式执行仍在 worker，扩展只依赖 shared 契约。
 */
const ALLOWED_EDGES = {
  '@cairn/shared': [],
  '@cairn/storage': ['@cairn/shared'],
  '@cairn/secret': ['@cairn/shared'],
  '@cairn/db': ['@cairn/shared'],
  '@cairn/api': ['@cairn/db', '@cairn/secret', '@cairn/shared'],
  '@cairn/worker': ['@cairn/db', '@cairn/secret', '@cairn/shared', '@cairn/storage'],
  '@cairn/web': ['@cairn/shared'],
  '@cairn/extension-playwright-crx': ['@cairn/shared'],
}

/**
 * 声明之外还有一条绕过依赖表的路：跨包相对路径 import。
 *
 * `import '../../worker/src/x'` 不出现在任何 package.json 里，依赖表看不见它。
 * 目前 tsc 的 rootDir 顺带挡着这种写法，但那是编译配置的副作用——副作用可以
 * 在下一次调整 tsconfig 时消失，约束不该建立在它上面。
 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.vite'])
const SPECIFIER_PATTERN = /\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      yield* sourceFiles(full)
      continue
    }
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0 && SOURCE_EXTENSIONS.has(entry.name.slice(dot))) yield full
  }
}

function checkRelativeEscapes(packageDir, self, report) {
  const inside = packageDir + sep
  for (const file of sourceFiles(packageDir)) {
    const source = readFileSync(file, 'utf8')
    for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      if (target === packageDir || target.startsWith(inside)) continue
      report(
        `${self} 用相对路径引到了包外：${relative(root, file)} → ${specifier}（跨包只能走包名依赖）`,
      )
    }
  }
}

const PACKAGE_ROOTS = [resolve(root, 'packages'), resolve(root, 'packages/extension')]
const errors = []
let checked = 0

for (const packagesDir of PACKAGE_ROOTS) {
  if (!existsSync(packagesDir)) continue

  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const packageDir = resolve(packagesDir, dir.name)
    const manifestPath = resolve(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const self = manifest.name
    const rel = relative(root, packageDir)
    if (!(self in ALLOWED_EDGES)) {
      errors.push(`${rel} 的包名 ${self} 未登记在允许边表中——新增包必须显式决定其依赖方向`)
      continue
    }
    checked += 1

    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }
    const allowed = new Set(ALLOWED_EDGES[self])

    for (const dep of Object.keys(declared)) {
      if (!dep.startsWith('@cairn/')) continue
      if (dep === self) {
        errors.push(`${self} 依赖了自己`)
        continue
      }
      if (!(dep in ALLOWED_EDGES)) {
        errors.push(`${self} 依赖了未登记的仓内包 ${dep}`)
        continue
      }
      if (!allowed.has(dep)) {
        errors.push(`${self} 不得依赖 ${dep}（允许：${allowed.size ? [...allowed].join('、') : '无仓内依赖'}）`)
      }
    }

    checkRelativeEscapes(packageDir, self, (message) => errors.push(message))
  }
}

if (errors.length) {
  console.error('依赖方向检查未通过：')
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✅ 依赖方向检查通过（${checked} 个包）`)
