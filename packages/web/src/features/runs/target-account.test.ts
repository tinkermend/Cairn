import { describe, expect, it } from 'vitest'
import {
  passwordAccounts,
  preferredPasswordAccountId,
  unusableAccountCopy,
  unusableAccountReason,
} from './target-account'

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

describe('unusableAccountReason', () => {
  it('有可用账号时不给原因', () => {
    expect(unusableAccountReason([{ id: 'a', status: 'active', hasPassword: true }])).toBeUndefined()
  })

  it('区分没有账号、全停用、全仅采集与混合', () => {
    expect(unusableAccountReason([])).toBe('none')
    expect(unusableAccountReason([{ id: 'a', status: 'disabled', hasPassword: true }])).toBe('disabled')
    expect(
      unusableAccountReason([{ id: 'a', status: 'active', hasPassword: true, usage: 'map' }]),
    ).toBe('map_only')
    expect(
      unusableAccountReason([
        { id: 'a', status: 'disabled', hasPassword: true },
        { id: 'b', status: 'active', hasPassword: true, usage: 'map' },
      ]),
    ).toBe('mixed')
  })

  it('停用与仅采集的说明不是同一句话', () => {
    expect(unusableAccountCopy('disabled')).not.toBe(unusableAccountCopy('map_only'))
    expect(unusableAccountCopy('map_only')).toContain('仅知识采集')
    expect(unusableAccountCopy('disabled')).toContain('已停用')
  })
})
