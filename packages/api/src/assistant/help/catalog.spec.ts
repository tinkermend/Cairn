import { describe, expect, it } from 'vitest'
import {
  PUBLISHED_HELP_CATALOG,
  retrieveHelpSnippets,
} from './catalog.js'

describe('Help Catalog & Retrieval (P0-B / CQ-06)', () => {
  it('has verified published help catalog entries covering all primary categories', () => {
    expect(PUBLISHED_HELP_CATALOG.length).toBeGreaterThanOrEqual(8)
    const categories = new Set(PUBLISHED_HELP_CATALOG.map((i) => i.category))
    expect(categories.has('studio')).toBe(true)
    expect(categories.has('run')).toBe(true)
    expect(categories.has('target')).toBe(true)
    expect(categories.has('session')).toBe(true)
    expect(categories.has('schedule')).toBe(true)
    expect(categories.has('dataset')).toBe(true)
    expect(categories.has('platform')).toBe(true)
  })

  it('retrieves relevant help snippets for retry query with top-3 cap', () => {
    const snippets = retrieveHelpSnippets('如何配置重试策略？')
    expect(snippets.length).toBeGreaterThan(0)
    expect(snippets.length).toBeLessThanOrEqual(3)
    expect(snippets[0].id).toBe('help:studio-retry')
    expect(snippets[0].title).toContain('重试')
    expect(snippets[0].pageRoute).toBe('/scenarios')
    expect(snippets[0].content.length).toBeLessThanOrEqual(500)
  })

  it('retrieves relevant snippets for session lease query', () => {
    const snippets = retrieveHelpSnippets('受管会话的租约规则是什么？')
    expect(snippets.length).toBeGreaterThan(0)
    expect(snippets[0].id).toBe('help:session-lease')
    expect(snippets[0].content).toContain('租约')
  })

  it('enforces topK and maxChars constraints', () => {
    const snippets = retrieveHelpSnippets('运行 状态 诊断', { topK: 1, maxChars: 50 })
    expect(snippets.length).toBe(1)
    expect(snippets[0].content.length).toBeLessThanOrEqual(53) // 50 + '...'
  })

  it('filters out snippets when actor lacks required permissions', () => {
    // help:run-review requires 'run:read'
    const withPerm = retrieveHelpSnippets('运行复盘三轴状态', {
      permissions: ['ai:assist', 'run:read'],
    })
    expect(withPerm.some((s) => s.id === 'help:run-review')).toBe(true)

    const withoutPerm = retrieveHelpSnippets('运行复盘三轴状态', {
      permissions: ['ai:assist'], // lacks run:read
    })
    expect(withoutPerm.some((s) => s.id === 'help:run-review')).toBe(false)
  })

  it('returns empty array for empty or unmatched queries', () => {
    expect(retrieveHelpSnippets('')).toEqual([])
    expect(retrieveHelpSnippets('   ')).toEqual([])
    expect(retrieveHelpSnippets('xyz123456789abc不存在的内容')).toEqual([])
  })
})
