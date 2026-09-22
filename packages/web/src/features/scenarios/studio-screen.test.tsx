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
})
