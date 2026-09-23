import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AccountSessionDetail, RunDetailDto } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { StudioScreen } from './studio-screen'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_ID = '33333333-3333-4333-8333-333333333333'
const RUN_ID = '77777777-7777-4777-8777-777777777777'

const observation = vi.hoisted(() => ({
  run: null as RunDetailDto | null,
  evidence: { items: [] as { type: string }[] },
  connection: 'live' as const,
  refresh: vi.fn(),
  eventSeq: 0,
  query: {},
}))

const sessionMocks = vi.hoisted(() => ({
  fetchAccountSession: vi.fn(),
  requestAccountSessionOperation: vi.fn(),
  fetchSessionOperation: vi.fn().mockResolvedValue(null),
  fetchAccountSessionEvents: vi.fn().mockResolvedValue({ items: [] }),
  cancelSessionOperation: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/features/sessions/use-session-observation', () => ({
  useSessionObservation: () => ({ connected: true, eventSeq: 1 }),
}))

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: () => observation,
}))

vi.mock('@/features/runs/browser-view', () => ({
  BrowserView: ({ sessionMode }: { sessionMode?: boolean }) => (
    <div data-testid='mock-browser-view'>{sessionMode ? '会话实时画面' : '受管浏览器画面'}</div>
  ),
}))

vi.mock('@/features/runs/run-video', () => ({
  RunVideoSection: () => <div data-testid='mock-run-video'>运行录像</div>,
}))

vi.mock('@/lib/sessions-api', () => ({
  fetchAccountSession: (...args: unknown[]) => sessionMocks.fetchAccountSession(...args),
  requestAccountSessionOperation: (...args: unknown[]) =>
    sessionMocks.requestAccountSessionOperation(...args),
  fetchSessionOperation: (...args: unknown[]) => sessionMocks.fetchSessionOperation(...args),
  fetchAccountSessionEvents: (...args: unknown[]) => sessionMocks.fetchAccountSessionEvents(...args),
  cancelSessionOperation: (...args: unknown[]) => sessionMocks.cancelSessionOperation(...args),
  sessionBrowserTransport: () => ({}),
  newSessionIdempotencyKey: (kind: string) => `session-${kind}-key`,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href='#'>{children}</a>,
}))

const finishedRun = {
  id: RUN_ID,
  status: 'FAILED',
  scenarioVersionId: 'ver-1',
  finishedAt: '2026-09-21T06:16:10.000Z',
} as RunDetailDto

const openSession = {
  targetId: TARGET_ID,
  targetName: '智慧运维',
  targetAccountId: ACCOUNT_ID,
  accountDisplayName: '管理员',
  accountUsername: 'admin',
  accountStatus: 'active',
  hasPassword: true,
  expectedIdentity: null,
  authCapability: 'LOGIN_VERIFIED',
  lastAuthError: null,
  status: 'ready',
  retained: false,
  session: {
    id: SESSION_ID,
    status: 'OPEN',
    generation: 1,
    ownerWorkerId: 'worker-1',
    authState: 'AUTHENTICATED',
    identityState: 'UNVERIFIED',
    observedTier: null,
    lastAuthCheckedAt: null,
    lastAuthSuccessAt: null,
    authValidUntil: null,
    lastExpectedIdentity: null,
    retainUntil: null,
  },
  occupancy: null,
  retention: null,
  currentOperation: null,
  actions: [],
  instances: [],
  liveCount: 1,
  effectiveCap: 1,
  asOf: '2026-09-21T06:20:00.000Z',
} as AccountSessionDetail

describe('StudioScreen Component', () => {
  function renderScreen(props: {
    runId?: string
    targetId?: string
    targetAccountId?: string
    onStartTrial?: () => void
    permissions?: string[]
    selectedStepName?: string
    selectedIsFirst?: boolean
    trialDisabledReason?: string
  }) {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试',
      email: null,
      roles: [],
      permissions: props.permissions ?? [
        'run:read',
        'run:execute',
        'session:read',
        'session:control',
        'session:view',
      ],
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <StudioScreen
          runId={props.runId}
          scenarioId='sc-1'
          targetId={props.targetId}
          targetAccountId={props.targetAccountId}
          onStartTrial={props.onStartTrial ?? vi.fn()}
          selectedStepName={props.selectedStepName}
          selectedIsFirst={props.selectedIsFirst}
          trialDisabledReason={props.trialDisabledReason}
        />
      </QueryClientProvider>,
    )
  }

  it('未提供 runId 且没有会话时展示空态与连接受管会话', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'unprepared',
    })
    const onStart = vi.fn()
    const screen = await renderScreen({
      onStartTrial: onStart,
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })
    await expect.element(screen.getByRole('heading', { name: '画面未连接' })).toBeInTheDocument()
    await expect.element(screen.getByText(/连的是目标账号会话/)).toBeInTheDocument()
    const startBtn = screen.getByRole('button', { name: '连接受管会话' })
    await expect.element(startBtn).toBeInTheDocument()
  })

  it('上次登录页打不开时说明原因并给出再试', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'unprepared',
      lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
    })
    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })
    await expect.element(screen.getByText(/目标登录页打不开/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '再试一次' })).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: '查看会话' })).toBeInTheDocument()
  })

  it('试跑结束后若会话仍打开，主画面是实时会话而不是录像', async () => {
    observation.run = finishedRun
    sessionMocks.fetchAccountSession.mockResolvedValue(openSession)
    const screen = await renderScreen({
      runId: RUN_ID,
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })
    await expect.element(screen.getByText('会话实时画面')).toBeInTheDocument()
    await expect.element(screen.getByText('会话已连接')).toBeInTheDocument()
    expect(screen.getByTestId('mock-run-video').elements()).toHaveLength(0)
    await expect.element(screen.getByRole('button', { name: '本次试跑录像' })).toBeInTheDocument()
  })

  it('会话直播且当前不是第一步时说明画面不是这一步之后的页', async () => {
    observation.run = finishedRun
    sessionMocks.fetchAccountSession.mockResolvedValue(openSession)
    const screen = await renderScreen({
      runId: RUN_ID,
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
      selectedStepName: '点击组件配置',
      selectedIsFirst: false,
      trialDisabledReason: '先保存草稿',
    })
    await expect
      .element(screen.getByText(/不是执行到「点击组件配置」之后的页面/))
      .toBeInTheDocument()
    await expect.element(screen.getByText(/试跑不可用：先保存草稿/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑', exact: true })).toBeDisabled()
  })

  it('选中第一步或试跑挂起现场时不提示画面不是步骤页', async () => {
    observation.run = finishedRun
    sessionMocks.fetchAccountSession.mockResolvedValue(openSession)
    const first = await renderScreen({
      runId: RUN_ID,
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
      selectedStepName: '打开页面',
      selectedIsFirst: true,
    })
    await expect.element(first.getByText(/不是执行到/)).not.toBeInTheDocument()
    await first.unmount()

    observation.run = {
      ...finishedRun,
      status: 'HOLDING',
    }
    const holding = await renderScreen({
      runId: RUN_ID,
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
      selectedStepName: '点击组件配置',
      selectedIsFirst: false,
    })
    await expect.element(holding.getByText('会话实时画面')).not.toBeInTheDocument()
    await expect.element(holding.getByText(/不是执行到/)).not.toBeInTheDocument()
  })

  it('试跑结束且没有会话时才回退到录像', async () => {
    observation.run = finishedRun
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'unprepared',
    })
    const screen = await renderScreen({
      runId: RUN_ID,
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })
    await expect.element(screen.getByTestId('mock-run-video')).toBeInTheDocument()
    await expect.element(screen.getByText(/运行已结束/)).toBeInTheDocument()
  })

  it('点击连接受管会话后展示四阶段 Stepper 与取消准备按钮', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'unprepared',
      currentOperation: {
        id: 'op-prepare-1',
        kind: 'PREPARE',
        status: 'QUEUED',
        reusedRunId: null,
      },
    })
    sessionMocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-prepare-1',
      created: true,
      reusedRunId: null,
    })
    sessionMocks.fetchSessionOperation.mockResolvedValue({
      id: 'op-prepare-1',
      status: 'QUEUED',
      queueDeadlineAt: new Date(Date.now() + 180000).toISOString(),
      createdAt: new Date().toISOString(),
    })

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    const connectBtn = screen.getByRole('button', { name: '连接受管会话' })
    await connectBtn.click()

    await expect.element(screen.getByText('排队调度', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('启动环境', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('自动登录', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('会话就绪', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '取消准备' })).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: '查看会话详情' })).toBeInTheDocument()
  })

  it('操作进入 WAITING_FOR_AUTH 时自动切出 BrowserView 并展示人工验证引导', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'maintenance',
      lastAuthError: 'CAPTCHA_REQUIRED',
      occupancy: {
        purpose: 'AUTH_WAIT',
        occupyingRunId: null,
        occupyingOperationId: 'op-auth-wait',
      },
      currentOperation: {
        id: 'op-auth-wait',
        kind: 'PREPARE',
        status: 'WAITING_FOR_AUTH',
        reusedRunId: null,
      },
    })

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    await expect.element(screen.getByText('会话实时画面')).toBeInTheDocument()
    await expect.element(screen.getByText(/需要人工辅助验证/)).toBeInTheDocument()
    await expect.element(screen.getByText(/请在下方画面中点击「取得控制权」/)).toBeInTheDocument()
  })

  it('在准备中点击取消准备会调用 cancelSessionOperation', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'unprepared',
      currentOperation: {
        id: 'op-to-cancel',
        kind: 'PREPARE',
        status: 'RUNNING',
        reusedRunId: null,
      },
    })
    sessionMocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-to-cancel',
      created: true,
      reusedRunId: null,
    })
    sessionMocks.cancelSessionOperation.mockResolvedValue({})

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    const connectBtn = screen.getByRole('button', { name: '连接受管会话' })
    await connectBtn.click()

    const cancelBtn = screen.getByRole('button', { name: '取消准备' })
    await cancelBtn.click()

    expect(sessionMocks.cancelSessionOperation).toHaveBeenCalledWith('op-to-cancel')
  })

  it('准备会话失败时立即展示失败信息与再试一次按钮，不显示取消准备与死等转圈', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: null,
      status: 'unprepared',
      currentOperation: null,
    })
    sessionMocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-failed-1',
      created: true,
      reusedRunId: null,
    })
    sessionMocks.fetchSessionOperation.mockResolvedValue({
      id: 'op-failed-1',
      status: 'FAILED',
      errorCode: 'SESSION_NOT_CLAIMABLE',
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    })

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    const connectBtn = screen.getByRole('button', { name: '连接受管会话' })
    await connectBtn.click()

    // 标题展示会话准备失败，徽章展示准备失败
    await expect.element(screen.getByRole('heading', { name: '会话准备失败' })).toBeInTheDocument()
    await expect.element(screen.getByText('准备失败', { exact: true })).toBeInTheDocument()

    // 详细错误说明中包含友好翻译与错误码
    await expect.element(screen.getByText(/执行节点会话资源不可用/)).toBeInTheDocument()
    await expect.element(screen.getByText(/SESSION_NOT_CLAIMABLE/)).toBeInTheDocument()

    // 展示「再试一次」按钮（Header 与卡片内），不展示「取消准备」
    await expect.element(screen.getByRole('button', { name: '再试一次' }).first()).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '取消准备' })).not.toBeInTheDocument()
  })

  it('准备失败后点击「关闭」按钮可回到初始未连接状态', async () => {
    sessionMocks.fetchAccountSession.mockResolvedValue({
      session: null,
      currentOperation: null,
      lastAuthError: null,
      occupancy: null,
    })
    sessionMocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-failed-2',
    })
    sessionMocks.fetchSessionOperation.mockResolvedValue({
      id: 'op-failed-2',
      status: 'FAILED',
      errorCode: 'SESSION_NOT_CLAIMABLE',
    })

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    const connectBtn = screen.getByRole('button', { name: '连接受管会话' })
    await connectBtn.click()

    await expect.element(screen.getByRole('heading', { name: '会话准备失败' })).toBeInTheDocument()

    // 点击「关闭」按钮
    const closeBtn = screen.getByRole('button', { name: '关闭' })
    await closeBtn.click()

    // 恢复为未连接空态
    await expect.element(screen.getByRole('heading', { name: '画面未连接' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '连接受管会话' })).toBeInTheDocument()
  })

  it('在 WAITING_FOR_AUTH 状态下点击「放弃接管并关闭」强制发起 CLOSE 操作', async () => {
    observation.run = null
    sessionMocks.fetchAccountSession.mockResolvedValue({
      ...openSession,
      session: {
        ...openSession.session!,
        status: 'OPEN',
      },
      status: 'maintenance',
      lastAuthError: 'CAPTCHA_REQUIRED',
      occupancy: {
        purpose: 'AUTH_WAIT',
        occupyingRunId: null,
        occupyingOperationId: 'op-auth-wait-2',
      },
      currentOperation: {
        id: 'op-auth-wait-2',
        kind: 'PREPARE',
        status: 'WAITING_FOR_AUTH',
        reusedRunId: null,
      },
    })
    sessionMocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-close-1',
      created: true,
      reusedRunId: null,
    })

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    const abandonBtn = screen.getByRole('button', { name: '放弃接管并关闭' })
    await expect.element(abandonBtn).toBeInTheDocument()
    await abandonBtn.click()

    expect(sessionMocks.requestAccountSessionOperation).toHaveBeenCalledWith(
      TARGET_ID,
      ACCOUNT_ID,
      expect.objectContaining({
        kind: 'CLOSE',
        force: true,
      }),
    )
  })

  it('准备失败后展示「彻底重置会话」逃生通道并强制调用 CLOSE', async () => {
    sessionMocks.fetchAccountSession.mockResolvedValue({
      session: null,
      currentOperation: null,
      lastAuthError: null,
      occupancy: null,
    })
    sessionMocks.requestAccountSessionOperation.mockResolvedValue({
      operationId: 'op-failed-3',
    })
    sessionMocks.fetchSessionOperation.mockResolvedValue({
      id: 'op-failed-3',
      status: 'FAILED',
      errorCode: 'SESSION_OPERATION_CONFLICT',
    })

    const screen = await renderScreen({
      targetId: TARGET_ID,
      targetAccountId: ACCOUNT_ID,
    })

    const connectBtn = screen.getByRole('button', { name: '连接受管会话' })
    await connectBtn.click()

    const resetBtn = screen.getByRole('button', { name: '彻底重置会话' })
    await expect.element(resetBtn).toBeInTheDocument()
    await resetBtn.click()

    expect(sessionMocks.requestAccountSessionOperation).toHaveBeenCalledWith(
      TARGET_ID,
      ACCOUNT_ID,
      expect.objectContaining({
        kind: 'CLOSE',
        force: true,
      }),
    )
  })
})
