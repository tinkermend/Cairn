import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleInPageGuidance, isTargetPageEntryQuestion } from './in-page-guidance.handler.js'
import { authorizeTargetRequest, getTargetKnowledgeContext } from '@cairn/db'
import { requireVisibleTarget } from './common.js'

vi.mock('@cairn/db', () => ({
  authorizeTargetRequest: vi.fn(),
  getTargetKnowledgeContext: vi.fn(),
}))
vi.mock('./common.js', () => ({ requireVisibleTarget: vi.fn() }))

describe('in-page guidance target knowledge scope', () => {
  beforeEach(() => vi.clearAllMocks())

  it('known account-health prompt locates the assistant panel without querying the target map', async () => {
    const completeJson = vi.fn()
    const question = '这个目标页面里的「账号健康度」按钮在哪？'
    const answer = await handleInPageGuidance({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'target-a' } },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance' })
    if (answer.kind !== 'in_page_guidance') throw new Error('wrong result kind')
    expect(answer.directAnswer).toContain('右侧「识途助手」面板')
    expect(answer.directAnswer).toContain('「场景推荐」')
    expect(completeJson).not.toHaveBeenCalled()
    expect(getTargetKnowledgeContext).not.toHaveBeenCalled()
  })

  it('unregistered export button reports missing landmarks without inventing a location', async () => {
    const completeJson = vi.fn()
    const question = '这个目标页面里的「导出账号健康报告」按钮在哪？'
    const answer = await handleInPageGuidance({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'target-a' } },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance' })
    if (answer.kind !== 'in_page_guidance') throw new Error('wrong result kind')
    expect(answer.directAnswer).toContain('已登记界面地标')
    expect(answer.directAnswer).toContain('无法确认')
    expect(completeJson).not.toHaveBeenCalled()
  })

  it('answers a target page entrance only from an observed route', async () => {
    const overview = {
      menuTree: [{ entryId: 'menu-1', name: '数据库', pageKeys: ['p-1', 'p-2'] }],
      pages: [{ title: '告警分析', menuPath: ['告警中心'], urlPattern: 'https://example.test/front/alerts' }],
      truncated: true,
    }
    const scoped = {
      menuTree: overview.menuTree,
      pages: [{ title: '数据库实例_系统', menuPath: ['数据库', '数据库实例'], urlPattern: 'https://example.test/front/database/dbInstance' }],
      truncated: false,
    }
    vi.mocked(getTargetKnowledgeContext).mockResolvedValueOnce(overview as never).mockResolvedValueOnce(scoped as never)
    const completeJson = vi.fn()
    const answer = await handleInPageGuidance({
      question: '这个系统的数据库实例列表入口在哪里？',
      body: { question: '这个系统的数据库实例列表入口在哪里？', pageContext: { page: 'target', targetId: 'target-a' } },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson },
    } as never)
    expect(answer).toMatchObject({
      kind: 'in_page_guidance',
      directAnswer: expect.stringContaining('/front/database/dbInstance'),
    })
    expect(getTargetKnowledgeContext).toHaveBeenLastCalledWith(expect.anything(), 'target-a', {
      intent: '这个系统的数据库实例列表入口在哪里？', menuPath: ['数据库'], maxPages: 10, include: [],
    })
    expect(completeJson).not.toHaveBeenCalled()
  })

  it('uses an explicitly named target instead of the different target open on the page', async () => {
    const question = '请问modelapi中转站的数据库实例列表入口在哪里？'
    expect(isTargetPageEntryQuestion('target', question)).toBe(true)
    vi.mocked(requireVisibleTarget).mockResolvedValue({ name: 'modelapi中转站' } as never)
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      menuTree: [{ entryId: 'database', name: '数据库', pageKeys: ['instances'] }],
      pages: [{ title: '数据库实例', menuPath: ['数据库', '数据库实例'], urlPattern: '/a/database/instances' }],
      truncated: false,
    } as never)
    const slots: Record<string, unknown> = { targetId: 'target-b', page: 'target' }
    const answer = await handleInPageGuidance({
      question, body: { question, pageContext: { page: 'target', targetId: 'target-b' } },
      slots, actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: { listTargets: vi.fn().mockResolvedValue({
        items: [{ id: 'target-a', name: 'modelapi中转站' }], nextCursor: null,
      }) }, session: { completeJson: vi.fn() },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance',
      directAnswer: expect.stringContaining('目标系统「modelapi中转站」') })
    if (answer.kind !== 'in_page_guidance') throw new Error('wrong result kind')
    expect(answer.directAnswer).toContain('/a/database/instances')
    expect(slots.targetId).toBe('target-a')
    expect(getTargetKnowledgeContext).toHaveBeenCalledWith(expect.anything(), 'target-a', expect.anything())
    expect(getTargetKnowledgeContext).not.toHaveBeenCalledWith(expect.anything(), 'target-b', expect.anything())
  })

  it('does not fall back to the page target when a named target is not visible', async () => {
    const question = 'modelapi中转站的数据库实例列表入口在哪里？'
    const slots: Record<string, unknown> = { targetId: 'target-b', page: 'target' }
    const answer = await handleInPageGuidance({
      question, body: { question, pageContext: { page: 'target', targetId: 'target-b' } },
      slots, actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: { listTargets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
      session: { completeJson: vi.fn() },
    } as never)
    expect(answer).toMatchObject({ kind: 'clarify',
      question: expect.stringContaining('未定位到匹配名称'), missingFields: ['targetId'] })
    expect(slots).not.toHaveProperty('targetId')
    expect(getTargetKnowledgeContext).not.toHaveBeenCalled()
  })

  it('does not claim a page is absent from a truncated map sample', async () => {
    vi.mocked(getTargetKnowledgeContext).mockResolvedValueOnce({
      menuTree: [{ entryId: 'menu-1', name: '数据库', pageKeys: ['p-1'] }],
      pages: [{ title: '数据库实例', menuPath: ['数据库'], urlPattern: 'https://example.test/front/database' }],
      truncated: true,
    } as never)
    const completeJson = vi.fn()
    const answer = await handleInPageGuidance({
      question: '这个系统的订单页入口在哪里？',
      body: { question: '这个系统的订单页入口在哪里？', pageContext: { page: 'target', targetId: 'target-a' } },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance' })
    if (answer.kind !== 'in_page_guidance') throw new Error('wrong result kind')
    expect(answer.directAnswer).toContain('不能据此判断页面不存在')
    expect(answer.directAnswer).toContain('检索结果有截断')
    expect(completeJson).not.toHaveBeenCalled()
  })

  it('resolves a generic page name only when one observed page matches', async () => {
    const map = {
      menuTree: [{ entryId: 'order-menu', name: '订单管理', pageKeys: ['orders'] }],
      pages: [{ title: '订单查询', menuPath: ['订单管理', '订单查询'],
        urlPattern: 'https://example.test/orders/search' }],
      truncated: false,
    }
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue(map as never)
    const question = '这个系统的订单页入口在哪里？'
    const answer = await handleInPageGuidance({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'target-a' } },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson: vi.fn() },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance',
      directAnswer: expect.stringContaining('/orders/search') })
  })

  it('asks for the page name when multiple observed order pages match', async () => {
    vi.mocked(getTargetKnowledgeContext).mockResolvedValue({
      menuTree: [{ entryId: 'order-menu', name: '订单管理', pageKeys: ['orders', 'returns'] }],
      pages: [
        { title: '订单查询', menuPath: ['订单管理', '订单查询'], urlPattern: '/orders/search' },
        { title: '订单详情', menuPath: ['订单管理', '订单详情'], urlPattern: '/orders/detail' },
      ],
      truncated: false,
    } as never)
    const question = '这个系统的订单页入口在哪里？'
    const answer = await handleInPageGuidance({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'target-a' } },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson: vi.fn() },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance',
      directAnswer: expect.stringContaining('多个可能的页面') })
    if (answer.kind !== 'in_page_guidance') throw new Error('wrong result kind')
    expect(answer.directAnswer).not.toContain('/orders/search')
  })

  it('unmatched platform button guidance does not read a denied target map', async () => {
    vi.mocked(authorizeTargetRequest).mockRejectedValue(new Error('TARGET_NOT_FOUND'))
    const completeJson = vi.fn()
    const answer = await handleInPageGuidance({
      question: 'zz-unmatched-page-question',
      body: {
        question: 'zz-unmatched-page-question',
        pageContext: { page: 'studio', targetId: 'target-b' },
      },
      actor: { id: 'actor-a', permissions: ['ai:assist', 'target:read', 'map:read'] },
      db: {}, targets: {}, session: { completeJson },
    } as never)
    expect(answer).toMatchObject({ kind: 'in_page_guidance',
      directAnswer: expect.stringContaining('已登记界面地标') })
    expect(authorizeTargetRequest).not.toHaveBeenCalled()
    expect(getTargetKnowledgeContext).not.toHaveBeenCalled()
    expect(completeJson).not.toHaveBeenCalled()
  })
})
