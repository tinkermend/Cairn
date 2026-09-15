import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beginMidsceneLogScope, clearMidsceneRunDir, configureMidsceneRunDir } from './run-dir.js'

const workerId = `spec-run-dir-${process.pid}`
let dir: string | undefined

afterEach(() => {
  if (dir) clearMidsceneRunDir(dir)
  dir = undefined
})

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

describe('SDK 落盘目录', () => {
  it('指到 Worker 自己的临时目录，并清掉上一轮残留', async () => {
    dir = await configureMidsceneRunDir(workerId)
    expect(dir).not.toContain('midscene_run')
    expect(existsSync(join(dir, 'log'))).toBe(true)

    const stale = join(dir, 'log', 'stale.log')
    writeFileSync(stale, '上一轮的页面内容')
    expect(existsSync(stale)).toBe(true)

    dir = await configureMidsceneRunDir(workerId)
    expect(existsSync(stale)).toBe(false)

    const { getMidsceneRunDir } = await import('@midscene/shared/common')
    expect(getMidsceneRunDir()).toBe(dir)
  })

  it('清理后目录不留下来', async () => {
    const created = await configureMidsceneRunDir(workerId)
    clearMidsceneRunDir(created)
    expect(existsSync(created)).toBe(false)
  })

  it('Agent 全部结束后轮换日志：旧代连同页面内容一起删掉', async () => {
    dir = await configureMidsceneRunDir(workerId)
    const { getDebug } = await import('@midscene/shared/logger')
    const log = getDebug('cairn-rotation-idle')
    const firstLog = join(dir, 'log', '0', 'cairn-rotation-idle.log')

    const end = beginMidsceneLogScope()
    log('页面描述：订单 SO-1001')
    await waitFor(() => sizeOf(firstLog) > 0, firstLog)
    end()
    end()
    expect(existsSync(join(dir, 'log', '0'))).toBe(false)

    log('下一代')
    const nextLog = join(dir, 'log', '1', 'cairn-rotation-idle.log')
    await waitFor(() => sizeOf(nextLog) > 0, nextLog)
  })

  it('仍有 Agent 在途时不轮换，单代超过上限才轮换', async () => {
    dir = await configureMidsceneRunDir(workerId, { maxLogBytes: 256 })
    const { getDebug } = await import('@midscene/shared/logger')
    const log = getDebug('cairn-rotation-cap')
    const firstLog = join(dir, 'log', '0', 'cairn-rotation-cap.log')

    const outer = beginMidsceneLogScope()
    const inner = beginMidsceneLogScope()
    log('短')
    await waitFor(() => sizeOf(firstLog) > 0, firstLog)
    inner()
    expect(existsSync(join(dir, 'log', '0'))).toBe(true)

    log('x'.repeat(512))
    await waitFor(() => sizeOf(firstLog) > 256, `${firstLog} 超过 256 字节`)
    beginMidsceneLogScope()()
    expect(existsSync(join(dir, 'log', '0'))).toBe(false)
    outer()
  })
})
