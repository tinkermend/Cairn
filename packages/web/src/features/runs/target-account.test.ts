import { describe, expect, it } from 'vitest'
import { passwordAccounts, preferredPasswordAccountId } from './target-account'

describe('preferredPasswordAccountId', () => {
  it('优先选择已启用且已保存口令的账号', () => {
    expect(
      preferredPasswordAccountId([
        { id: 'empty', status: 'active', hasPassword: false },
        { id: 'ready', status: 'active', hasPassword: true },
        { id: 'off', status: 'disabled', hasPassword: true },
      ]),
    ).toBe('ready')
  })

  it('没有可用口令账号时为空', () => {
    expect(preferredPasswordAccountId([{ id: 'empty', status: 'active', hasPassword: false }])).toBe('')
    expect(passwordAccounts([{ id: 'off', status: 'disabled', hasPassword: true }])).toEqual([])
  })
})
