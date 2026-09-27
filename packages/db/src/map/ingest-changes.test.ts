import { describe, expect, it } from 'vitest'
import { diffMapIngestPages } from './ingest-changes.js'

const item = (fingerprint: string, name: string, locator = 'Submit', options?: string[]) => ({
  fingerprint, category: 'action_button' as const, role: 'button', name,
  locator: { framePath: [], candidates: [{ by: 'role' as const, value: 'button', name: locator }] },
  ...(options ? { options } : {}),
})

describe('采集变化对比', () => {
  const before = [{ pageKey: 'page:A', viewStateKey: 'view:A', elements: [
    item('fingerprint-1', '状态', '状态', ['启用', '停用']),
    item('fingerprint-2', '旧按钮'),
  ] }]
  const after = [{ pageKey: 'page:A', viewStateKey: 'view:A', elements: [
    item('fingerprint-1', '状态', '选择状态', ['启用', '停用', '待审核']),
    item('fingerprint-3', '新按钮'),
  ] }]

  it('识别定位和选项变化，partial 不生成消失事件', () => {
    const result = diffMapIngestPages(before, after, false)
    expect(result.changes.map(change => change.kind)).toEqual([
      'locator_changed', 'options_changed', 'element_added',
    ])
  })

  it('完整同范围采集才产生消失事件', () => {
    const result = diffMapIngestPages(before, after, true)
    expect(result.changes.some(change => change.kind === 'element_removed')).toBe(true)
  })
})
