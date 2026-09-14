import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditListResponse } from '@cairn/shared'
import { OperationsAuditPanel } from './operations'

const mocks = vi.hoisted(() => ({
  fetchOperationAudit: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => mocks)
const list: AuditListResponse = {
  items: [
    {
      id: 'evt-1',
      action: 'account.create',
      resource: 'account',
      resourceId: 'acc-1',
      summary: '创建账号 审计员',
      actor: { id: 'acc-admin', displayName: '管理员', email: 'admin' },
      createdAt: '2026-09-13T04:00:00.000Z',
    },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <OperationsAuditPanel />
    </QueryClientProvider>,
  )
}

describe('操作记录', () => {
  beforeEach(() => {
    mocks.fetchOperationAudit.mockResolvedValue(list)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('列出操作者、中文动作和摘要', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('管理员')).toBeVisible()
    await expect.element(screen.getByText('account.create')).toBeVisible()
    await expect.element(screen.getByText('创建账号 审计员')).toBeVisible()
  })

  it('空列表显示还没有操作记录', async () => {
    mocks.fetchOperationAudit.mockResolvedValueOnce({ items: [] })
    const screen = await renderPage()
    await expect.element(screen.getByText('还没有操作记录')).toBeVisible()
  })

  it('筛选、表格和分页在同一张卡片里', async () => {
    const screen = await renderPage()
    const card = screen.getByRole('region', { name: '操作记录' })
    await expect.element(card.getByText('创建账号 审计员')).toBeVisible()
    await expect.element(card.getByRole('combobox', { name: '动作' })).toBeVisible()
    await expect.element(card.getByRole('button', { name: '时间' })).toBeVisible()
    await expect.element(card.getByText('每页行数')).toBeVisible()
  })

  it('有下一页时翻页带上游标', async () => {
    mocks.fetchOperationAudit
      .mockResolvedValueOnce({
        items: [list.items[0]],
        nextCursor: 'next-1',
      })
      .mockResolvedValueOnce({
        items: [
          {
            ...list.items[0],
            id: 'evt-2',
            summary: '第二页记录',
          },
        ],
      })
    const screen = await renderPage()
    await expect.element(screen.getByText('第 1 页')).toBeVisible()
    await screen.getByRole('button', { name: '下一页' }).click()
    await expect.element(screen.getByText('第二页记录')).toBeVisible()
    expect(mocks.fetchOperationAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next-1', limit: 20 }),
    )
  })
})
