import { readdir, stat, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export type DiskSample = {
  profileBytes: number | null
  profileCount: number | null
  profileDiskFreeBytes: number | null
  diskTotalBytes: number | null
  diskUsagePercent: number | null
  midsceneBytes: number | null
  sampledAt: Date
}

export async function sampleProfileDisk(profileDir: string, workerId: string): Promise<DiskSample> {
  const sampledAt = new Date()
  const root = resolve(profileDir)
  const [usage, disk, midscene] = await Promise.all([
    directoryStats(root),
    diskStats(root),
    directoryBytes(join(tmpdir(), `cairn-midscene-${workerId}`)).catch(() => null),
  ])
  return {
    profileBytes: usage.bytes,
    profileCount: usage.count,
    profileDiskFreeBytes: disk.freeBytes,
    diskTotalBytes: disk.totalBytes,
    diskUsagePercent: disk.usagePercent,
    midsceneBytes: midscene,
    sampledAt,
  }
}

async function directoryStats(root: string): Promise<{ bytes: number | null; count: number | null }> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const count = entries.filter((entry) => entry.isDirectory()).length
    const bytes = await directoryBytes(root)
    return { bytes, count }
  } catch {
    return { bytes: null, count: null }
  }
}

async function directoryBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const path = join(root, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await directoryBytes(path)
      } else if (entry.isFile()) {
        total += (await stat(path)).size
      }
    } catch {
      // 单个文件失败不把整树写成 0
    }
  }
  return total
}

async function diskStats(root: string): Promise<{ freeBytes: number | null; totalBytes: number | null; usagePercent: number | null }> {
  try {
    const info = await statfs(root)
    const bsize = Number(info.bsize)
    const totalBytes = Number(info.blocks) * bsize
    const freeBytes = Number(info.bavail) * bsize
    const usagePercent =
      totalBytes > 0
        ? Math.min(100, Math.max(0, Math.round(((totalBytes - freeBytes) / totalBytes) * 100)))
        : null
    return { freeBytes, totalBytes, usagePercent }
  } catch {
    return { freeBytes: null, totalBytes: null, usagePercent: null }
  }
}
