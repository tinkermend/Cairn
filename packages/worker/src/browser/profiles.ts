import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { profileKeyFor, type SessionKey } from '@cairn/db'

const REVISION_FILE = '.cairn-profile-revision'

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

export function readProfileRevision(profileDir: string): number | null {
  const path = join(profileDir, REVISION_FILE)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { revision?: unknown }
    return typeof parsed.revision === 'number' && parsed.revision >= 1 ? parsed.revision : null
  } catch {
    return null
  }
}

export function writeProfileRevision(profileDir: string, revision: number): void {
  writeFileSync(join(profileDir, REVISION_FILE), JSON.stringify({ revision }), { mode: 0o600 })
}

/** 修订不符或亲和兜底时清空本地 Profile，再以空目录启动。 */
export function prepareProfileDir(
  root: string,
  key: SessionKey,
  expectedRevision: number,
  fallback = false,
): { profileKey: string; profileDir: string; wiped: boolean } {
  const ensured = ensureProfileDir(root, key)
  const stored = readProfileRevision(ensured.profileDir)
  const wipe = fallback || stored === null || stored !== expectedRevision
  if (wipe && existsSync(ensured.profileDir)) {
    rmSync(ensured.profileDir, { recursive: true, force: true })
    mkdirSync(ensured.profileDir, { recursive: true, mode: 0o700 })
  }
  writeProfileRevision(ensured.profileDir, expectedRevision)
  return { ...ensured, wiped: wipe }
}
