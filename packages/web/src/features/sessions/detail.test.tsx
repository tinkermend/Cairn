import '@/styles/index.css'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PERMISSIONS } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import { SessionDetailPage } from './detail'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  fetchAccountSession: vi.fn(),
  fetchSessionEvents: vi.fn(),
  fetchSessionOperation: vi.fn(),
  cancelSessionOperation: vi.fn(),
  fetchManagedBrowser: vi.fn(),
  acquireAuthControl: vi.fn(),
  heartbeatAuthControl: vi.fn(),
  inputAuthControl: vi.fn(),
  releaseAuthControl: vi.fn(),
  resumeRunAuth: vi.fn(),
  subscribeBrowserFrames: vi.fn(),
  requestAccountSessionOperation: vi.fn(),
  setAccountSessionRetention: vi.fn(),
}))

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@/lib/workers-api', () => ({ disposeWorkerSession: vi.fn() }))
vi.mock('./use-session-observation', () => ({
  useSessionObservation: () => ({ connected: true, eventSeq: 1 }),
}))
vi.mock('@/lib/sessions-api', () => ({
  fetchAccountSession: mocks.fetchAccountSession,
  fetchAccountSessionEvents: mocks.fetchSessionEvents,
  fetchSessionOperation: mocks.fetchSessionOperation,
  cancelSessionOperation: mocks.cancelSessionOperation,
  sessionBrowserTransport: () => mocks,
  requestAccountSessionOperation: mocks.requestAccountSessionOperation,
  setAccountSessionRetention: mocks.setAccountSessionRetention,
  newSessionIdempotencyKey: () => 'session-VERIFY-test-key',
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    getRouteApi: () => ({
      useParams: () => ({ targetId: TARGET_ID, accountId: ACCOUNT_ID }),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
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

describe('SessionDetailPage', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    await page.viewport(1440, 900)
    signIn()
    mocks.fetchAccountSession.mockResolvedValue({
      targetId: TARGET_ID,
      targetName: '演示系统',
      targetAccountId: ACCOUNT_ID,
      accountDisplayName: '值班',
      accountUsername: 'ops',
      accountStatus: 'active',
      hasPassword: false,
      status: 'ready',
      retained: false,
      authCapability: 'LOGIN_VERIFIED',
      expectedIdentity: null,
      session: {
        id: '33333333-3333-4333-8333-333333333333',
        generation: 1,
        status: 'OPEN',
        ownerWorkerId: 'worker-a',
        authState: 'AUTHENTICATED',
        identityState: 'UNVERIFIED',
        observedTier: 'LOGIN_VERIFIED',
        lastAuthCheckedAt: '2026-09-16T00:00:00.000Z',
        lastAuthSuccessAt: '2026-09-16T00:00:00.000Z',
        authValidUntil: null,
        lastExpectedIdentity: null,
        retainUntil: null,
      },
      occupancy: null,
      retention: null,
      currentOperation: null,
      actions: ['CLOSE', 'RESTART', 'RESET_PROFILE'].map((kind) => ({
        kind,
        enabled: true,
        disabledReason: null,
      })),
      asOf: '2026-09-16T00:00:00.000Z',
    })
    mocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op',
      reusedRunId: null,
      created: true,
    })
    mocks.fetchSessionOperation.mockResolvedValue({ id: 'op', kind: 'PREPARE', status: 'WAITING_FOR_AUTH' })
    mocks.fetchManagedBrowser.mockResolvedValue({
      runStatus: 'WAITING_FOR_AUTH',
      pages: [],
      currentPage: null,
      framesAvailable: false,
      capabilities: {},
      authControl: null,
    })
    mocks.acquireAuthControl.mockResolvedValue({
      token: 't'.repeat(32),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      pageRef: { pageId: 'p' },
      meta: {
        runStatus: 'WAITING_FOR_AUTH',
        pages: [],
        currentPage: null,
        framesAvailable: false,
        capabilities: {},
        authControl: null,
      },
    })
    mocks.releaseAuthControl.mockResolvedValue({ released: true })
    mocks.resumeRunAuth.mockResolvedValue({ ok: true })
    mocks.fetchSessionEvents.mockResolvedValue({ items: [], nextCursor: null })
  })

  it('展示账号会话并允许设置保留与破坏性操作', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('演示系统 / 值班')).toBeInTheDocument()
    await expect.element(screen.getByText('就绪')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '检查登录' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '设置保留' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '更多' })).toBeInTheDocument()
  })
  it('独立操作可以领取控制权、完成认证及取消，三个宽度无横向溢出', async () => {
    const base = await mocks.fetchAccountSession()
    mocks.fetchAccountSession.mockResolvedValue({
      ...base,
      status: 'maintenance',
      currentOperation: { id: 'op', kind: 'PREPARE', status: 'WAITING_FOR_AUTH', reusedRunId: null },
      occupancy: { purpose: 'AUTH_WAIT', occupyingRunId: null, occupyingOperationId: 'op' },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('准备会话 · 等待人工认证')).toBeInTheDocument()
    await screen.getByRole('button', { name: '处理登录' }).click()
    await expect.element(screen.getByRole('button', { name: '完成认证' })).toBeInTheDocument()
    for (const width of [1440, 1024, 390]) {
      await page.viewport(width, 900)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      await page.screenshot({ path: `/Users/tinker/src/singe/Cairn/.run/session-c-fixes/认证-${width}.png` })
    }
    await screen.getByRole('button', { name: '完成认证' }).click()
    expect(mocks.resumeRunAuth).toHaveBeenCalledWith('op', { token: 't'.repeat(32) })
    await screen.getByRole('button', { name: '取消操作' }).click()
    expect(mocks.cancelSessionOperation).toHaveBeenCalledWith('op')
  })
  it('破坏性操作携带用户所见实例与代次', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await screen.getByRole('button', { name: '更多' }).click()
    await screen.getByRole('menuitem', { name: '关闭会话' }).click()
    await screen.getByRole('button', { name: '确认执行' }).click()
    expect(mocks.requestAccountSessionOperation).toHaveBeenCalledWith(
      TARGET_ID,
      ACCOUNT_ID,
      expect.objectContaining({
        kind: 'CLOSE',
        expectedSessionId: '33333333-3333-4333-8333-333333333333',
        expectedGeneration: 1,
      }),
    )
  })
})
