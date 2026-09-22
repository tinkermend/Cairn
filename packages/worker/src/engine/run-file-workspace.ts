import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, opendir, rm, stat } from 'node:fs/promises'

export function runFileWorkspaceDir(runId: string): string {
  return join(tmpdir(), `cairn-runfiles-${runId}`)
}

export function runFileWorkspaceFixtureDir(runId: string): string {
  return join(runFileWorkspaceDir(runId), 'fixtures')
}

export function runFileWorkspaceContextDir(runId: string): string {
  return join(runFileWorkspaceDir(runId), 'context')
}

export function runFileWorkspaceDownloadDir(runId: string): string {
  return join(runFileWorkspaceDir(runId), 'downloads')
}

export async function ensureWorkspaceDirs(runId: string): Promise<{
  workDir: string
  fixtureDir: string
  contextDir: string
  downloadDir: string
}> {
  const workDir = runFileWorkspaceDir(runId)
  const fixtureDir = runFileWorkspaceFixtureDir(runId)
  const contextDir = runFileWorkspaceContextDir(runId)
  const downloadDir = runFileWorkspaceDownloadDir(runId)
  await mkdir(fixtureDir, { recursive: true })
  await mkdir(contextDir, { recursive: true })
  await mkdir(downloadDir, { recursive: true })
  return { workDir, fixtureDir, contextDir, downloadDir }
}

export async function cleanupRunFileWorkspace(runId: string): Promise<void> {
  const dir = runFileWorkspaceDir(runId)
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

/** 进程侧兜底：扫描 cairn-runfiles-* 并按 mtime 删除超期目录，覆盖进程崩溃跑不到 finally 的情况。 */
export async function cleanupRunFileWorkspaces(root = tmpdir(), now = Date.now(), maxAgeMs = 3600_000): Promise<number> {
  let inspected = 0
  let removed = 0
  try {
    const directory = await opendir(root)
    for await (const entry of directory) {
      if (++inspected > 1000) break
      if (!entry.isDirectory() || !entry.name.startsWith('cairn-runfiles-')) continue
      const path = join(root, entry.name)
      try {
        const stats = await stat(path)
        if (now - stats.mtimeMs > maxAgeMs) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined)
          removed++
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
  } catch {
    // ignore opendir failure if tmpdir inaccessible
  }
  return removed
}
