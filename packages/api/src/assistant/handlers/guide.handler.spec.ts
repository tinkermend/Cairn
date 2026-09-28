import { describe, expect, it } from 'vitest'
import { SYSTEM_ROLE_DEFINITIONS } from '@cairn/shared'
import { buildPlatformGuideForQuestion } from './guide.handler.js'

const question = '在识途平台中，如何从零录制并编排一个新场景？'

describe('录制上手指引的实际权限', () => {
  it('作者能看到录制、保存和试跑路径', () => {
    const guide = buildPlatformGuideForQuestion(SYSTEM_ROLE_DEFINITIONS.author.permissions, 'scenarios', question)
    expect(guide.kind).toBe('guide')
    if (guide.kind !== 'guide') return
    expect(guide.items.map((item) => item.href)).toEqual(['/recordings', '/scenarios'])
    expect(guide.items.map((item) => item.steps).join(' ')).toContain('试跑当前草稿')
  })

  it('只读用户不会被指向不可用的录制入口或保存操作', () => {
    const guide = buildPlatformGuideForQuestion(SYSTEM_ROLE_DEFINITIONS.viewer.permissions, 'scenarios', question)
    expect(guide.kind).toBe('guide')
    if (guide.kind !== 'guide') return
    expect(guide.items[0]).toMatchObject({ href: null, availability: 'forbidden' })
    expect(guide.items.map((item) => item.href)).not.toContain('/recordings')
    expect(guide.items.map((item) => item.steps).join(' ')).toContain('缺少场景编写权限')
    expect(guide.items.map((item) => item.steps).join(' ')).not.toContain('点击「试跑当前草稿」')
  })

  it('可编写但不可执行的账号明确说明无法试跑', () => {
    const permissions = ['ai:assist', 'target:read', 'workflow:read', 'workflow:write', 'run:read']
    const guide = buildPlatformGuideForQuestion(permissions, 'scenarios', question)
    expect(guide.kind).toBe('guide')
    if (guide.kind !== 'guide') return
    expect(guide.items.map((item) => item.href)).toEqual(['/recordings', '/scenarios'])
    expect(guide.items.map((item) => item.steps).join(' ')).toContain('缺少运行执行权限，不能完成试跑')
    expect(guide.items.map((item) => item.steps).join(' ')).not.toContain('点击「试跑当前草稿」')
  })
})
