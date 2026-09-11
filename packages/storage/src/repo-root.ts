import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 沿目录向上找 `pnpm-workspace.yaml`，与 CWD 无关。 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('未找到仓根（缺少 pnpm-workspace.yaml）')
    }
    dir = parent
  }
}

/**
 * 相对目录才需要仓根。repoRoot 传 thunk 而不是字符串：s3 驱动与绝对路径
 * 配置根本用不到它，而 findRepoRoot 在仓外会抛——容器里跑 dist 时，
 * 提前求值会让一个用不上的值挡住整个进程启动。
 */
export function resolveLocalObjectStoreDir(dir: string, repoRoot: () => string): string {
  if (isAbsolute(dir)) return dir
  return resolve(repoRoot(), dir)
}
