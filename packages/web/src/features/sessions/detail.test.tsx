import '@/styles/index.css'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PERMISSIONS } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import { SessionDetailPage, sessionOperationProgress, sessionRetentionHint } from './detail'

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

  it('未落到当前实例的保留意图不当成正在保留', () => {
    expect(
      sessionRetentionHint({
        retained: false,
        retainUntil: null,
        quotaUsed: 0,
        quotaLimit: 1,
      }),
    ).toBe('未设置保留。当前节点配额 0/1。只有打开的实例可以占用节点配额。')
    expect(
      sessionRetentionHint({
        retained: true,
        retainUntil: '2026-09-18T03:39:04.673Z',
        quotaUsed: 1,
        quotaLimit: 1,
      }),
    ).toMatch(/^截止 /)
  })

  it('只在进行中的会话操作显示进度', () => {
    expect(sessionOperationProgress({ currentKind: 'PREPARE', currentStatus: 'SUCCEEDED' })).toBeNull()
    expect(sessionOperationProgress({ currentKind: 'PREPARE', currentStatus: 'RUNNING' })).toEqual({
      kind: 'PREPARE',
      status: 'RUNNING',
    })
    expect(
      sessionOperationProgress({
        submittingKind: 'VERIFY_AUTH',
        currentKind: 'PREPARE',
        currentStatus: 'SUCCEEDED',
      }),
    ).toEqual({ kind: 'VERIFY_AUTH', status: 'SUBMITTING' })
  })

  it('完成后不再悬挂操作进度', async () => {
    mocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-verify',
      reusedRunId: null,
      created: true,
    })
    mocks.fetchSessionOperation.mockResolvedValue({
      id: 'op-verify',
      kind: 'VERIFY_AUTH',
      status: 'SUCCEEDED',
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByRole('button', { name: '检查登录' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '操作进度' }).elements()).toHaveLength(0)
    await screen.getByRole('button', { name: '检查登录' }).click()
    await expect.poll(() => mocks.requestAccountSessionOperation.mock.calls.length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: '操作进度' }).elements()).toHaveLength(0)
    expect(screen.getByText('检查登录 · 已完成').elements()).toHaveLength(0)
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
    await expect.element(screen.getByText(/执行该操作/)).toBeInTheDocument()
    expect(screen.getByText(/执行该操作/).element().textContent).not.toContain('清除登录数据')
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

  it('未准备时不渲染关闭会话', async () => {
    const base = await mocks.fetchAccountSession()
    mocks.fetchAccountSession.mockResolvedValue({
      ...base,
      status: 'unprepared',
      session: null,
      occupancy: null,
      actions: ['CLOSE', 'RESTART', 'RESET_PROFILE'].map((kind) => ({
        kind,
        enabled: kind === 'RESET_PROFILE',
        disabledReason: kind === 'RESET_PROFILE' ? null : '需要空闲实例',
      })),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByRole('button', { name: '更多' })).toBeInTheDocument()
    await screen.getByRole('button', { name: '更多' }).click()
    expect(screen.getByRole('menuitem', { name: '关闭会话' })).not.toBeInTheDocument()
    await expect.element(screen.getByRole('menuitem', { name: '清除登录数据' })).toBeInTheDocument()
  })

  it('高频连续登出信号自动聚合折叠并展示摘要', async () => {
    mocks.fetchSessionEvents.mockResolvedValue({
      items: [
        {
          id: 'e3',
          seq: 3,
          type: 'auth.signal_observed',
          payload: { kind: 'logout_signal', summary: '匹配登出URL: /login' },
          createdAt: '2026-09-19T02:31:33.000Z',
          runId: null,
        },
        {
          id: 'e2',
          seq: 2,
          type: 'auth.signal_observed',
          payload: { kind: 'logout_signal', summary: '匹配登出URL: /login' },
          createdAt: '2026-09-19T02:31:24.000Z',
          runId: null,
        },
        {
          id: 'e1',
          seq: 1,
          type: 'auth.signal_observed',
          payload: { kind: 'logout_signal', summary: '匹配登出URL: /login' },
          createdAt: '2026-09-19T02:31:16.000Z',
          runId: null,
        },
      ],
      nextCursor: null,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('使用记录')).toBeInTheDocument()
    await expect.element(screen.getByText('× 3')).toBeInTheDocument()
    await expect.element(screen.getByText('匹配登出URL: /login')).toBeInTheDocument()
  })
})

