import { describe, expect, it } from 'vitest'
import { isManagedUserDataDir } from './browser-processes'

describe('托管浏览器进程计数', () => {
  it('user-data-dir 必须落在 profile 根下，不能只看前缀', () => {
    expect(isManagedUserDataDir('/tmp/profiles/acc-1', '/tmp/profiles')).toBe(true)
    expect(isManagedUserDataDir('/tmp/profiles', '/tmp/profiles')).toBe(true)
    expect(isManagedUserDataDir('/tmp/profiles-evil/acc-1', '/tmp/profiles')).toBe(false)
    expect(isManagedUserDataDir('/tmp/other/acc-1', '/tmp/profiles')).toBe(false)
  })
})
