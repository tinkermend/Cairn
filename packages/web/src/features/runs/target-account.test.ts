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

  it('没有口令时仍可选中已启用账号', () => {
    expect(preferredPasswordAccountId([{ id: 'empty', status: 'active', hasPassword: false }])).toBe('empty')
    expect(passwordAccounts([{ id: 'off', status: 'disabled', hasPassword: true }])).toEqual([])
    expect(passwordAccounts([{ id: 'empty', status: 'active', hasPassword: false }])).toEqual([
      { id: 'empty', status: 'active', hasPassword: false },
    ])
  })
})
