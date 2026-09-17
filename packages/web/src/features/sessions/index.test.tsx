import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PERMISSIONS } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import { SessionsPage } from './index'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchSessionSystemOverview: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
vi.mock('./use-session-observation', () => ({ useSessionObservation: () => ({ connected: true, eventSeq: 1 }) }))
vi.mock('@/lib/sessions-api', () => ({
  fetchSessionSystemOverview: mocks.fetchSessionSystemOverview,
}))

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: [...PERMISSIONS],
  })
}

describe('SessionsPage', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    sessionStorage.clear()
    await page.viewport(1440, 900)
    signIn()
    mocks.fetchSessionSystemOverview.mockResolvedValue({
      items: [
        {
          targetId: TARGET_ID,
          targetName: '智慧运维管理平台',
          targetCode: 'ops-platform',
          targetStatus: 'active',
          accountTotal: 8,
          readyCount: 1,
          problemCount: 2,
          unpreparedCount: 5,
          busyCount: 0,
          retainedCount: 0,
          worstStatus: 'lost',
        },
      ],
      summary: {
        systems: 12,
        readyAccounts: 1,
        problemAccounts: 2,
        unpreparedAccounts: 17,
      },
      asOf: '2026-09-17T00:00:00.000Z',
    })
  })

  it('sessionStorage 里的空游标不会阻止加载系统总览', async () => {
    sessionStorage.setItem(
      'sessions-systems-list',
      JSON.stringify({ pageIndex: 0, cursors: [null], pageSize: 20 }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionsPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('智慧运维管理平台')).toBeInTheDocument()
    expect(mocks.fetchSessionSystemOverview).toHaveBeenCalledWith({
      search: undefined,
      filter: undefined,
      limit: 20,
      cursor: undefined,
    })
  })

  it('按系统归类，就绪账号卡不切换已就绪筛选', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionsPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('智慧运维管理平台')).toBeInTheDocument()
    await expect.element(screen.getByText('ops-platform')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '已就绪' })).toBeInTheDocument()
    await expect.element(screen.getByText('就绪账号')).toBeInTheDocument()
    expect(document.querySelector('button') && [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('就绪账号'))).toBe(false)
    await screen.getByLabelText('系统会话筛选').getByRole('button', { name: '有问题' }).click()
    expect(mocks.fetchSessionSystemOverview).toHaveBeenCalledWith({
      search: undefined,
      filter: 'problem',
      limit: 20,
      cursor: undefined,
    })
    await expect.element(screen.getByRole('cell', { name: /失联/ })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('准备会话')
    expect(document.body.textContent).not.toContain('删除')
    await page.viewport(390, 900)
    await expect.element(screen.getByText(/就绪 1 · 有问题 2 · 未准备 5/)).toBeInTheDocument()
  })
})
