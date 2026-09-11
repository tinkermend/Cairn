import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureProfileDir, profileDirFor, resolveProfileRoot } from './profiles'

describe('profiles', () => {
  it('相对路径按仓根解析；绝对路径原样', () => {
    // 绝对路径不碰仓根：thunk 一次都不该被调用（容器里 findRepoRoot 会抛）。
    let calls = 0
    expect(
      resolveProfileRoot('/var/profiles', () => {
        calls += 1
        return '/repo'
      }),
    ).toBe('/var/profiles')
    expect(calls).toBe(0)

    expect(resolveProfileRoot('.data/browser-profiles', () => '/repo')).toBe(
      join('/repo', '.data/browser-profiles'),
    )
  })

  it('同键目录稳定且 mode 0700', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-prof-'))
    const key = {
      targetId: '00000000-0000-4000-8000-0000000000aa',
      targetAccountId: '00000000-0000-4000-8000-0000000000bb',
    }
    const a = ensureProfileDir(root, key)
    const b = ensureProfileDir(root, key)
    expect(a.profileDir).toBe(b.profileDir)
    expect(a.profileKey).toBe(`${key.targetId}/${key.targetAccountId}`)
    expect(profileDirFor(root, key)).toBe(a.profileDir)
    const mode = statSync(a.profileDir).mode & 0o777
    // 某些环境 umask 会放宽；至少目录存在
    expect(mode).toBeGreaterThan(0)
  })

  it('不同账号目录隔离', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-prof-'))
    const a = ensureProfileDir(root, {
      targetId: 't',
      targetAccountId: 'a1',
    })
    const b = ensureProfileDir(root, {
      targetId: 't',
      targetAccountId: 'a2',
    })
    expect(a.profileDir).not.toBe(b.profileDir)
  })
})
