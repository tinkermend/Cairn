import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { profileKeyFor, type SessionKey } from '@cairn/db'

/** profile 目录规则：键入库，绝对路径不入库；目录 0700。 */
export function resolveProfileRoot(dir: string, repoRoot: () => string): string {
  if (isAbsolute(dir)) return dir
  return resolve(repoRoot(), dir)
}

export function profileDirFor(root: string, key: SessionKey): string {
  return join(root, key.targetId, key.targetAccountId)
}

export function ensureProfileDir(root: string, key: SessionKey): { profileKey: string; profileDir: string } {
  const profileKey = profileKeyFor(key)
  const profileDir = profileDirFor(root, key)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (existsSync(profileDir)) {
    try {
      chmodSync(profileDir, 0o700)
    } catch {
      // 部分 FS 不支持 chmod；不阻断启动
    }
  }
  return { profileKey, profileDir }
}
