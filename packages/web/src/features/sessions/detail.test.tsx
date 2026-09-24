import '@/styles/index.css'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PERMISSIONS } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ThemeProvider } from '@/context/theme-provider'
import {
  SessionDetailPage,
  describeOperationBanner,
  resolveSessionPrimaryAction,
  sessionOperationProgress,
  sessionRetentionHint,
} from './detail'

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
  observeSession: vi.fn(),
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
      lastAuthError: null,
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

  it('就绪但未配置检测时主操作仍是检查登录，不改成再登录', () => {
    expect(
      resolveSessionPrimaryAction({
        status: 'ready',
        actions: [
          { kind: 'PREPARE', enabled: false },
          { kind: 'VERIFY_AUTH', enabled: false },
          { kind: 'LOGIN', enabled: true },
          { kind: 'RENEW_AUTH', enabled: false },
        ],
      }),
    ).toBe('VERIFY_AUTH')
  })

  it('待检查且未配置检测时主操作落到登录', () => {
    expect(
      resolveSessionPrimaryAction({
        status: 'needs_check',
        actions: [
          { kind: 'PREPARE', enabled: false },
          { kind: 'VERIFY_AUTH', enabled: false },
          { kind: 'LOGIN', enabled: true },
        ],
      }),
    ).toBe('LOGIN')
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

  it('排队横幅说清在等什么、排第几、何时超时', () => {
    const now = Date.parse('2026-09-24T01:10:00.000Z')
    const waiting = describeOperationBanner({
      kind: 'PREPARE',
      status: 'QUEUED',
      now,
      waitReason: 'WORKER_SESSION_CAPACITY',
      waitDetail: { occupied: 2, maxSessions: 2 },
      queueDeadlineAt: '2026-09-24T01:14:19.000Z',
      queuePosition: 2,
    })
    expect(waiting.headline).toBe('准备会话 · 排队中')
    expect(waiting.tone).toBe('info')
    expect(waiting.lines[0]).toBe('执行节点会话已满（2/2），等待释放')
    expect(waiting.lines[1]).toMatch(/^前面还有 2 个操作 · 将于 .+ 超时（剩 4 分 19 秒）$/)

    const noWorker = describeOperationBanner({
      kind: 'PREPARE',
      status: 'QUEUED',
      now,
      waitReason: 'NO_ELIGIBLE_WORKER',
      queueDeadlineAt: '2026-09-24T01:14:19.000Z',
      queuePosition: 0,
    })
    expect(noWorker).toMatchObject({ tone: 'warning', showWorkersLink: true, expired: false })
    expect(noWorker.lines[0]).toBe('没有在线的执行节点，操作不会开始')

    const expired = describeOperationBanner({
      kind: 'PREPARE',
      status: 'QUEUED',
      now: Date.parse('2026-09-24T02:00:00.000Z'),
      waitReason: 'NO_ELIGIBLE_WORKER',
      queueDeadlineAt: '2026-09-24T01:14:19.000Z',
    })
    expect(expired).toMatchObject({ headline: '准备会话 · 排队已超时', expired: true, tone: 'warning' })
    expect(expired.lines[0]).toMatch(/可以重新发起$/)
  })

  it('普通等待超过 30 秒后说明已等待多久', () => {
    const now = Date.parse('2026-09-24T01:10:00.000Z')
    const base = {
      kind: 'PREPARE',
      status: 'QUEUED',
      now,
      waitReason: 'AWAITING_CLAIM',
      queueDeadlineAt: '2026-09-24T01:14:00.000Z',
    }
    expect(describeOperationBanner({ ...base, createdAt: '2026-09-24T01:09:50.000Z' }).lines[0]).toBe(
      '等待执行节点领取（通常几秒）',
    )
    expect(describeOperationBanner({ ...base, createdAt: '2026-09-24T01:09:00.000Z' }).lines[0]).toBe(
      '已等待 1 分 0 秒，执行节点仍未领取',
    )
    // 有明确原因时仍说原因。
    expect(
      describeOperationBanner({
        ...base,
        waitReason: 'WORKER_SESSION_CAPACITY',
        createdAt: '2026-09-24T01:09:00.000Z',
      }).lines[0],
    ).toBe('执行节点会话已满，等待释放')
  })

  it('执行横幅显示当前阶段、已用时长与执行节点', () => {
    const running = describeOperationBanner({
      kind: 'PREPARE',
      status: 'RUNNING',
      now: Date.parse('2026-09-24T01:10:12.000Z'),
      latestProgress: { payload: { phase: 'browser_launched', durationMs: 2300 } },
      claimedAt: '2026-09-24T01:10:00.000Z',
      ownerWorkerId: 'local-worker',
    })
    expect(running.headline).toBe('准备会话 · 执行中')
    expect(running.lines).toEqual(['当前：启动浏览器 · 耗时 2秒', '已用 12 秒 · 执行节点 local-worker'])
  })

  it('无可用节点时横幅给出提示与执行节点入口', async () => {
    const base = await mocks.fetchAccountSession()
    const deadline = new Date(Date.now() + 120_000).toISOString()
    mocks.fetchAccountSession.mockResolvedValue({
      ...base,
      status: 'maintenance',
      currentOperation: {
        id: 'op',
        kind: 'PREPARE',
        status: 'QUEUED',
        reusedRunId: null,
        queueDeadlineAt: deadline,
        waitReason: 'NO_ELIGIBLE_WORKER',
      },
    })
    mocks.fetchSessionOperation.mockResolvedValue({
      id: 'op',
      kind: 'PREPARE',
      status: 'QUEUED',
      queueDeadlineAt: deadline,
      waitReason: 'NO_ELIGIBLE_WORKER',
      waitDetail: null,
      queuePosition: 0,
      ownerWorkerId: null,
      errorCode: null,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByText('准备会话 · 排队中')).toBeInTheDocument()
    await expect.element(screen.getByText('没有在线的执行节点，操作不会开始')).toBeInTheDocument()
    await expect.element(screen.getByText('查看执行节点')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '取消操作' })).toBeInTheDocument()
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
    await expect.element(screen.getByText('节点 / 实例版本')).toBeInTheDocument()
    await expect.element(screen.getByText('worker-a · 实例 #1', { exact: true })).toBeInTheDocument()
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
    await expect.element(screen.getByText('准备会话 · 等待登录')).toBeInTheDocument()
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

  it('等待登录时展示最近问题而不是只说等待人工认证', async () => {
    const base = await mocks.fetchAccountSession()
    mocks.fetchAccountSession.mockResolvedValue({
      ...base,
      status: 'maintenance',
      lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
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
    await expect.element(screen.getByText('准备会话 · 登录页打不开')).toBeInTheDocument()
    await expect.element(screen.getByText('目标登录页打不开', { exact: true })).toBeInTheDocument()
    await expect
      .element(screen.getByText('目标登录页打不开。画面只发给当前处理登录的人。'))
      .toBeInTheDocument()
  })

  it('检查登录失败的使用记录显示失败而不是执行中', async () => {
    mocks.fetchSessionEvents.mockResolvedValue({
      items: [
        {
          id: 'e3',
          seq: 3,
          type: 'auth.unknown',
          operationId: 'op-verify',
          payload: { status: 'FAILED', errorCode: 'SESSION_AUTH_UNSUPPORTED', kind: 'VERIFY_AUTH' },
          createdAt: '2026-09-21T04:00:02.000Z',
        },
        {
          id: 'e2',
          seq: 2,
          type: 'operation.claimed',
          operationId: 'op-verify',
          payload: { kind: 'VERIFY_AUTH' },
          createdAt: '2026-09-21T04:00:01.000Z',
        },
        {
          id: 'e1',
          seq: 1,
          type: 'operation.requested',
          operationId: 'op-verify',
          payload: { kind: 'VERIFY_AUTH', origin: 'USER' },
          createdAt: '2026-09-21T04:00:00.000Z',
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
    await expect.element(screen.getByText('检查登录 · 登录状态待确认')).toBeInTheDocument()
    await expect.element(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByText('执行中')).not.toBeInTheDocument()
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

  it('多会话时必须先选一台再关闭', async () => {
    const base = await mocks.fetchAccountSession()
    mocks.fetchAccountSession.mockResolvedValue({
      ...base,
      session: null,
      liveCount: 2,
      effectiveCap: 3,
      instances: [
        {
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
          occupancy: null,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          generation: 2,
          status: 'OPEN',
          ownerWorkerId: 'worker-b',
          authState: 'AUTHENTICATED',
          identityState: 'UNVERIFIED',
          observedTier: 'LOGIN_VERIFIED',
          lastAuthCheckedAt: '2026-09-16T00:00:00.000Z',
          lastAuthSuccessAt: '2026-09-16T00:00:00.000Z',
          authValidUntil: null,
          lastExpectedIdentity: null,
          retainUntil: null,
          occupancy: null,
        },
      ],
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <SessionDetailPage />
        </QueryClientProvider>
      </ThemeProvider>,
    )
    await expect.element(screen.getByLabelText('选择会话')).toBeInTheDocument()
    await expect.element(screen.getByText('会话 2/3', { exact: true })).toBeInTheDocument()
    await screen.getByRole('button', { name: '更多' }).click()
    await screen.getByRole('menuitem', { name: '关闭会话' }).click()
    await screen.getByRole('button', { name: '确认执行' }).click()
    expect(mocks.requestAccountSessionOperation).toHaveBeenCalledWith(
      TARGET_ID,
      ACCOUNT_ID,
      expect.objectContaining({
        kind: 'CLOSE',
        expectedSessionId: '33333333-3333-4333-8333-333333333333',
      }),
    )
  })
})

