import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep } from 'node:path'

const execFileAsync = promisify(execFile)

export function isManagedUserDataDir(dir: string, profileRoot: string): boolean {
  const resolved = resolve(dir)
  const root = resolve(profileRoot)
  return resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep)
}

export async function countManagedBrowserProcesses(profileDir: string): Promise<number | null> {
  try {
    const root = resolve(profileDir)
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'command='], {
      timeout: 3_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    let count = 0
    for (const line of stdout.split('\n')) {
      if (!/(chrome|chromium)/i.test(line)) continue
      const marker = '--user-data-dir='
      const index = line.indexOf(marker)
      if (index < 0) continue
      const rest = line.slice(index + marker.length)
      const dir = rest.startsWith('"') ? rest.slice(1, Math.max(1, rest.indexOf('"', 1))) : rest.split(/\s/, 1)[0]
      if (dir && isManagedUserDataDir(dir, root)) count += 1
    }
    return count
  } catch {
    return null
  }
}
