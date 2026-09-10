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

export function resolveLocalObjectStoreDir(dir: string, repoRoot: string): string {
  if (isAbsolute(dir)) return dir
  return resolve(repoRoot, dir)
}
