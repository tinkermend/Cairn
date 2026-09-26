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
  fetchSessionOverview: vi.fn(),
  fetchAccountSession: vi.fn(),
  fetchAccountSessionEvents: vi.fn(),
  fetchSessionOperation: vi.fn(),
  fetchManagedBrowser: vi.fn(),
  acquireAuthControl: vi.fn(),
  heartbeatAuthControl: vi.fn(),
  inputAuthControl: vi.fn(),
  releaseAuthControl: vi.fn(),
  resumeRunAuth: vi.fn(),
  subscribeBrowserFrames: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    getRouteApi: () => ({
      useParams: () => ({ targetId: TARGET_ID, accountId: 'acc-1' }),
    }),
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
vi.mock('@/lib/workers-api', () => ({ disposeWorkerSession: vi.fn() }))
vi.mock('./use-session-observation', () => ({ useSessionObservation: () => ({ connected: true, eventSeq: 1 }) }))
vi.mock('@/lib/sessions-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sessions-api')>()
  return {
    ...actual,
    fetchSessionSystemOverview: mocks.fetchSessionSystemOverview,
    fetchSessionOverview: mocks.fetchSessionOverview,
    fetchAccountSession: mocks.fetchAccountSession,
    fetchAccountSessionEvents: mocks.fetchAccountSessionEvents,
    fetchSessionOperation: mocks.fetchSessionOperation,
    sessionBrowserTransport: () => mocks,
  }
})

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
    mocks.fetchSessionOverview.mockResolvedValue({
      items: [
        {
          targetId: TARGET_ID,
          targetName: '智慧运维管理平台',
          targetCode: 'ops-platform',
          targetAccountId: 'acc-1',
          accountDisplayName: '巡检账号',
          accountUsername: 'patrol',
          accountStatus: 'active',
          status: 'needs_login',
          retained: false,
          sessionId: 'sess-1',
          generation: 1,
          instanceStatus: 'OPEN',
          authState: 'UNAUTHENTICATED',
          identityState: null,
          observedTier: null,
          occupyingRunId: null,
          occupyingOperationId: null,
          retainUntil: null,
          lastAuthCheckedAt: null,
          lastAuthSuccessAt: null,
          ownerWorkerId: 'worker-1',
          primaryAction: 'LOGIN',
          liveCount: 1,
          effectiveCap: 1,
        },
      ],
      summary: {
        total: 1,
        available: 0,
        needsCheck: 0,
        needsLogin: 1,
        identityMismatch: 0,
        maintenance: 0,
        executing: 0,
        lost: 0,
        unprepared: 0,
        retained: 0,
      },
      asOf: '2026-09-17T00:00:00.000Z',
    })
    mocks.fetchAccountSession.mockResolvedValue({
      targetId: TARGET_ID,
      targetName: '智慧运维管理平台',
      targetAccountId: 'acc-1',
      accountDisplayName: '巡检账号',
      accountUsername: 'patrol',
      accountStatus: 'active',
      hasPassword: false,
      status: 'needs_login',
      retained: false,
      authCapability: 'LOGIN_VERIFIED',
      expectedIdentity: null,
      lastAuthError: null,
      session: null,
      actions: [{ kind: 'LOGIN', enabled: true }],
      asOf: '2026-09-17T00:00:00.000Z',
    })
    mocks.fetchAccountSessionEvents.mockResolvedValue({ items: [], nextCursor: null })
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
    sessionStorage.setItem('sessions-active-view', 'systems')
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

  it('默认进入待办与会话流，展示待办卡片并支持直接唤起抽屉工作台', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionsPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('待办与会话流')).toBeInTheDocument()
    await expect.element(screen.getByText(/需要人工介入/)).toBeInTheDocument()
    await expect.element(screen.getByText('巡检账号', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '处理登录' })).toBeInTheDocument()

    // 点击处理登录按钮，唤起侧滑抽屉工作台
    await screen.getByRole('button', { name: '处理登录' }).click()
    // 抽屉被展开
    await expect.element(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('可以在待办会话流与按目标系统视图之间无缝切换', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionsPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('待办与会话流')).toBeInTheDocument()
    // 切换到按目标系统
    await screen.getByRole('button', { name: '按目标系统' }).click()
    await expect.element(screen.getByText('智慧运维管理平台')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('系统会话筛选')).toBeInTheDocument()
  })
})


