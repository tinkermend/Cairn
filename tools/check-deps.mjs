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
  '@cairn/api': ['@cairn/db', '@cairn/secret', '@cairn/shared', '@cairn/storage'],
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
const AI_SDK_PATTERN = /(?:midscene|page-agent|@midscene\/|@page-agent\/)/i
const WORKER_SRC = resolve(root, 'packages/worker/src')
const ENGINE_SRC = resolve(WORKER_SRC, 'engine')
const AI_SRC = resolve(WORKER_SRC, 'ai')

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

function checkWorkerAiIsolation(report) {
  if (!existsSync(WORKER_SRC)) return
  for (const file of sourceFiles(WORKER_SRC)) {
    if (file.startsWith(AI_SRC + sep)) continue
    const source = readFileSync(file, 'utf8')
    for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
      if (!AI_SDK_PATTERN.test(specifier)) continue
      const rel = relative(root, file)
      if (file.startsWith(ENGINE_SRC + sep)) {
        report(`Engine 不得引用 Midscene / page-agent：${rel} → ${specifier}`)
      } else {
        report(`Worker 生产路径不得引用 Midscene / page-agent（只允许 src/ai/）：${rel} → ${specifier}`)
      }
    }
  }
}

const FORBIDDEN_AI_DEPS = /^(?:@midscene\/|@page-agent\/|page-agent)/

function checkManifestAiDeps(self, declared, report) {
  if (self === '@cairn/worker') return
  for (const dep of Object.keys(declared)) {
    if (!FORBIDDEN_AI_DEPS.test(dep)) continue
    report(`${self} 不得声明 ${dep}（仅 @cairn/worker 可依赖 Midscene / page-agent）`)
  }
}

const NON_WORKER_SRC_ROOTS = [
  resolve(root, 'packages/shared/src'),
  resolve(root, 'packages/api/src'),
  resolve(root, 'packages/web/src'),
  resolve(root, 'packages/db/src'),
  resolve(root, 'packages/secret/src'),
  resolve(root, 'packages/storage/src'),
  resolve(root, 'packages/extension'),
]

function checkOtherPackagesAiIsolation(report) {
  for (const dir of NON_WORKER_SRC_ROOTS) {
    if (!existsSync(dir)) continue
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, 'utf8')
      for (const [, specifier] of source.matchAll(SPECIFIER_PATTERN)) {
        if (!AI_SDK_PATTERN.test(specifier)) continue
        report(`非 Worker 包不得引用 Midscene / page-agent：${relative(root, file)} → ${specifier}`)
      }
    }
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

/*
 * 必须全仓同版本的依赖。
 *
 * playwright 的每个版本钉死自己的 chromium revision（1.55 → 1187、1.63 → 1243），
 * 两个包各写一个版本就是两台机器上各下一份浏览器：谁跑一次 browser:install 就多拉
 * 一份，且 worker 的浏览器测试在没装对应 revision 的机器上静默 skip（CI 只装了 web
 * 那一份，于是这条测试从来没在 CI 上跑过）。同版本是「装一次、跑两处」的前提。
 *
 * 不用 pnpm catalog 是因为 knip 的 findFile 只看 cwd，而 knip 按包运行、cwd 在
 * packages/web —— 它读不到仓根的 pnpm-workspace.yaml，会把 catalog: 报成
 * unresolved。约束落在这里：脚本已经在 CI（pnpm check）里卡着。
 */
const SHARED_VERSION_DEPS = ['playwright']

/** dep → (声明版本 → 声明它的包)。循环里收集，循环后判定。 */
const versionsByDep = new Map()

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
    checkManifestAiDeps(self, declared, (message) => errors.push(message))
    if (self === '@cairn/worker') checkWorkerAiIsolation((message) => errors.push(message))

    for (const dep of SHARED_VERSION_DEPS) {
      const spec = declared[dep]
      if (!spec) continue
      const seen = versionsByDep.get(dep) ?? new Map()
      if (!seen.has(spec)) seen.set(spec, [])
      seen.get(spec).push(self)
      versionsByDep.set(dep, seen)
    }
  }
}

checkOtherPackagesAiIsolation((message) => errors.push(message))

for (const dep of SHARED_VERSION_DEPS) {
  const seen = versionsByDep.get(dep)
  if (seen && seen.size > 1) {
    const detail = [...seen]
      .map(([spec, pkgs]) => `${spec}（${[...new Set(pkgs)].join('、')}）`)
      .join(' vs ')
    errors.push(`${dep} 全仓必须同版本，当前分叉：${detail}——每个版本会各拉一份浏览器`)
  }
}

if (errors.length) {
  console.error('依赖方向检查未通过：')
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log(`✅ 依赖方向检查通过（${checked} 个包）`)
