import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearMidsceneRunDir, configureMidsceneRunDir } from './run-dir.js'

const workerId = `spec-run-dir-${process.pid}`
let dir: string | undefined

afterEach(() => {
  if (dir) clearMidsceneRunDir(dir)
  dir = undefined
})

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
})
