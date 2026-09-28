// 仓库源码扫描的共用口径：遍历哪些文件、什么算测试文件、怎么取 import 说明符。
// check-deps 与 check-invariants 共用这一份，避免同一条规则在两个脚本里按不同范围生效。
import { existsSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
export const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.vite'])

export function* sourceFiles(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
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

/** 测试文件：*.spec / *.test，以及 __tests__/、testing/ 目录（测试夹具与替身，不进生产路径）。 */
export function isTestFile(file) {
  return (
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file) ||
    file.includes(`${sep}__tests__${sep}`) ||
    file.includes(`${sep}testing${sep}`)
  )
}

/** 去掉注释，免得注释里提到的模块名被当成 import。`://` 不当作行注释起点。 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SPECIFIER_PATTERN = /\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

/** 静态 import、export-from、动态 import() 与 require() 的模块说明符。 */
export function importSpecifiers(source) {
  return [...stripComments(source).matchAll(SPECIFIER_PATTERN)].map((match) => match[1])
}
