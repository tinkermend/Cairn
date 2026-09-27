import { describe, expect, it } from 'vitest'
import { mapConditionSnapshot } from '@cairn/shared'
import { assetConditionMatchesAccount, deriveLocatorStability, scoreKnowledgePage } from './knowledge-context.js'

const byTestId = { framePath: [], candidates: [{ by: 'testId', value: 'token-name' }] }
const byRole = { framePath: [], candidates: [{ by: 'role', value: 'textbox', name: '令牌名称' }] }

describe('采集定位稳定度', () => {
  it('需要连续且唯一的跨作业命中才给 high', () => {
    expect(deriveLocatorStability({ verified: false, observations: [
      { locator: byTestId, locatorUnique: true },
      { locator: byTestId, locatorUnique: true },
      { locator: byTestId, locatorUnique: true },
    ] })).toBe('high')
    expect(deriveLocatorStability({ verified: false, observations: [
      { locator: byTestId, locatorUnique: false },
      { locator: byTestId, locatorUnique: true },
      { locator: byTestId, locatorUnique: true },
    ] })).toBe('medium')
  })

  it('定位漂移或只有重复文本时不会误判稳定', () => {
    expect(deriveLocatorStability({ verified: false, observations: [
      { locator: byTestId }, { locator: byTestId }, { locator: byTestId },
    ] })).toBe('low')
    expect(deriveLocatorStability({ verified: false, observations: [
      { locator: byTestId, locatorUnique: true },
      { locator: byRole, locatorUnique: true },
    ] })).toBe('medium')
  })

  it('已验证资产证据的权重高于单次采集', () => {
    expect(deriveLocatorStability({ verified: true, observations: [
      { locator: byRole, locatorUnique: true },
    ] })).toBe('high')
    expect(deriveLocatorStability({ verified: true, observations: [
      { locator: byRole, locatorUnique: false },
    ] })).toBe('low')
  })
})

describe('知识页面检索', () => {
  it('优先命中页面身份与内容列，不让每页共有的侧栏菜单压过目标页', () => {
    const sharedNavigation = [{ name: 'API Keys', category: 'navigation' as const }]
    const query = 'API Keys API Key'
    const accounts = scoreKnowledgePage({ title: 'Account Management - Console',
      urlPattern: 'https://example.test/admin/accounts', menuPath: ['Accounts'],
      elements: sharedNavigation, intent: query })
    const keys = scoreKnowledgePage({ title: 'API Keys - Console',
      urlPattern: 'https://example.test/keys', menuPath: ['API Keys'],
      elements: [...sharedNavigation, { name: 'API Key', category: 'table_column' }], intent: query })
    expect(keys).toBeGreaterThan(accounts)
  })
})

describe('知识资产的账号边界', () => {
  it('只把当前账号条件的投影资产引用附到该账号页面', () => {
    const targetId = '00000000-0000-4000-8000-000000000001'
    const firstAccount = '00000000-0000-4000-8000-000000000002'
    const secondAccount = '00000000-0000-4000-8000-000000000003'
    const condition = mapConditionSnapshot({ targetId, targetAccountId: firstAccount })
    expect(assetConditionMatchesAccount(condition, firstAccount)).toBe(true)
    expect(assetConditionMatchesAccount(condition, secondAccount)).toBe(false)
    expect(assetConditionMatchesAccount(null, firstAccount)).toBe(false)
  })
})
