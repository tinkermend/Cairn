import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginAuditListResponse } from '@cairn/shared'
import { LoginsAuditPanel } from './logins'

const mocks = vi.hoisted(() => ({
  fetchLoginAudit: vi.fn(),
}))

vi.mock('@/lib/rbac-api', () => mocks)
const list: LoginAuditListResponse = {
  items: [
    {
      id: 'login-1',
      loginIdentifier: 'admin',
      outcome: 'failure',
      failureReason: 'invalid_password',
      actor: { id: 'acc-admin', displayName: '管理员', email: 'admin' },
      clientIp: '203.0.113.10',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      clientKind: 'web',
      createdAt: '2026-09-13T04:00:00.000Z',
    },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LoginsAuditPanel />
    </QueryClientProvider>,
  )
}

describe('登录记录', () => {
  beforeEach(() => {
    mocks.fetchLoginAudit.mockResolvedValue(list)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('列出账户、失败原因和 IP', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('admin')).toBeVisible()
    await expect.element(screen.getByText('密码不正确')).toBeVisible()
    await expect.element(screen.getByText('203.0.113.10')).toBeVisible()
    await expect.element(screen.getByText('失败', { exact: true })).toBeVisible()
  })

  it('空列表显示还没有登录记录', async () => {
    mocks.fetchLoginAudit.mockResolvedValueOnce({ items: [] })
    const screen = await renderPage()
    await expect.element(screen.getByText('还没有登录记录')).toBeVisible()
  })

  it('筛选、表格和分页在同一张卡片里', async () => {
    const screen = await renderPage()
    const card = screen.getByRole('region', { name: '登录记录' })
    await expect.element(card.getByText('admin')).toBeVisible()
    await expect.element(card.getByRole('combobox', { name: '结果' })).toBeVisible()
    await expect.element(card.getByRole('textbox', { name: '账户' })).toBeVisible()
    await expect.element(card.getByText('每页行数')).toBeVisible()
  })

  it('时间用范围选择器而不是两个日期框', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByRole('button', { name: '时间' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '从' }).query()).toBeNull()
    expect(screen.getByRole('textbox', { name: '到' }).query()).toBeNull()
  })

  it('User-Agent 过长时悬停展示全文', async () => {
    const screen = await renderPage()
    const trigger = screen.getByRole('button', { name: /Mozilla\/5.0/ })
    await expect.element(trigger).toBeVisible()
    await trigger.hover()
    await expect.element(screen.getByRole('tooltip')).toBeVisible()
    await expect
      .element(screen.getByRole('tooltip'))
      .toHaveTextContent('AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')
  })
})
