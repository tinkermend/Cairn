import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep } from 'node:path'

const execFileAsync = promisify(execFile)

export function isManagedUserDataDir(dir: string, profileRoot: string): boolean {
  const resolved = resolve(dir)
  const root = resolve(profileRoot)
  return resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep)
}

export type ManagedProcessStats = {
  pids: number[]
  rootPids: number[]
  rssBytes: number
  count: number
}

/**
 * 扫描并汇总受管 Chromium 进程树（按 --cairn-host= 标记与 Profile 根目录双重识别）
 */
export async function scanManagedBrowserProcesses(options: {
  profileDir?: string
  workerId?: string
}): Promise<ManagedProcessStats | null> {
  try {
    const root = options.profileDir ? resolve(options.profileDir) : undefined
    const workerMarker = options.workerId ? `--cairn-host=${options.workerId}/` : '--cairn-host='

    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,command='], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    })

    const pidMap = new Map<number, { ppid: number; rssKb: number; command: string }>()
    const rootPids: number[] = []

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      if (!match) continue

      const pid = Number(match[1])
      const ppid = Number(match[2])
      const rssKb = Number(match[3])
      const command = match[4]!

      if (!/(chrome|chromium)/i.test(command)) continue

      pidMap.set(pid, { ppid, rssKb, command })

      let isRoot = false
      if (command.includes(workerMarker)) {
        isRoot = true
      } else if (root && command.includes('--user-data-dir=')) {
        const marker = '--user-data-dir='
        const index = command.indexOf(marker)
        const rest = command.slice(index + marker.length)
        const dir = rest.startsWith('"') ? rest.slice(1, Math.max(1, rest.indexOf('"', 1))) : rest.split(/\s/, 1)[0]
        if (dir && isManagedUserDataDir(dir, root)) {
          isRoot = true
        }
      }

      if (isRoot) {
        rootPids.push(pid)
      }
    }

    // 展开所有子孙进程树 (GPU, Renderer, Network 等)
    const treePids = new Set<number>(rootPids)
    let added = true
    while (added) {
      added = false
      for (const [pid, info] of pidMap.entries()) {
        if (!treePids.has(pid) && treePids.has(info.ppid)) {
          treePids.add(pid)
          added = true
        }
      }
    }

    let totalRssKb = 0
    for (const pid of treePids) {
      totalRssKb += pidMap.get(pid)?.rssKb ?? 0
    }

    return {
      pids: [...treePids],
      rootPids,
      rssBytes: totalRssKb * 1024,
      count: treePids.size,
    }
  } catch {
    return null
  }
}

export async function countManagedBrowserProcesses(
  profileDir?: string,
  workerId?: string,
): Promise<number | null> {
  const stats = await scanManagedBrowserProcesses({ profileDir, workerId })
  return stats ? stats.count : null
}

export async function getManagedBrowserRssBytes(
  profileDir?: string,
  workerId?: string,
): Promise<number | null> {
  const stats = await scanManagedBrowserProcesses({ profileDir, workerId })
  return stats ? stats.rssBytes : null
}

/**
 * 清理残留孤儿进程（属于本 workerId 但不属于当前活跃进程集合）
 */
export async function cleanupOrphanBrowserProcesses(
  workerId: string,
  knownActivePids: Set<number>,
): Promise<number> {
  try {
    const stats = await scanManagedBrowserProcesses({ workerId })
    if (!stats) return 0
    let killed = 0
    for (const pid of stats.rootPids) {
      if (!knownActivePids.has(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
          killed += 1
        } catch {
          // already exited
        }
      }
    }
    return killed
  } catch {
    return 0
  }
}

/**
 * 强制结束卡死宿主进程
 */
export async function killHostBrowserProcess(
  workerId: string,
  hostId: string,
): Promise<boolean> {
  try {
    const targetMarker = `--cairn-host=${workerId}/${hostId}`
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
      timeout: 3_000,
    })
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (line.includes(targetMarker) && /(chrome|chromium)/i.test(line)) {
        const pid = Number(line.split(/\s+/)[0])
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
            return true
          } catch {
            return false
          }
        }
      }
    }
    return false
  } catch {
    return false
  }
}
