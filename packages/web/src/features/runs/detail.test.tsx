import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetailDto, RunEvidenceListResponse } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { RunDetailPage } from './detail'

const RUN_ID = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  fetchRun: vi.fn(),
  fetchRunEvidence: vi.fn(),
  fetchEvidenceContent: vi.fn(),
  cancelRun: vi.fn(),
  reviewRun: vi.fn(),
  resumeRunAuth: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => mocks)

// 顶栏是各页共用的外壳（侧栏上下文、搜索、账号菜单），与本页要验的东西无关。
vi.mock('@/components/layout/app-header', () => ({
  AppHeader: () => null,
}))

// Link / useParams 需要路由上下文，本用例只关心页面本身：给最小替身。
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({ runId: RUN_ID }),
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

function runDetail(overrides: Partial<RunDetailDto> = {}): RunDetailDto {
  return {
    id: RUN_ID,
    status: 'NEEDS_REVIEW',
    cancelRequested: false,
    targetId: '11111111-1111-4111-8111-111111111111',
    targetName: '演示商城',
    targetAccountId: '22222222-2222-4222-8222-222222222222',
    targetAccountName: '巡检账号',
    scenarioId: '33333333-3333-4333-8333-333333333333',
    scenarioName: '下单巡检',
    scenarioVersionId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-09-11T02:00:00.000Z',
    startedAt: '2026-09-11T02:00:01.000Z',
    finishedAt: null,
    evidenceStatus: 'PENDING',
    lease: null,
    placement: {
      state: 'not_applicable',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
    },
    snapshot: {
      schemaVersion: 1,
      runId: RUN_ID,
      targetId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '33333333-3333-4333-8333-333333333333',
      scenarioVersionId: '55555555-5555-4555-8555-555555555555',
      steps: [],
      input: {},
      createdAt: '2026-09-11T02:00:00.000Z',
    },
    context: { greeting: 'hello' },
    stepRuns: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        stepId: '77777777-7777-4777-8777-777777777777',
        name: '提交订单',
        type: 'delay',
        ordinal: 0,
        status: 'FAILED',
        startedAt: '2026-09-11T02:00:01.000Z',
        finishedAt: '2026-09-11T02:00:09.000Z',
        attempts: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            attemptNo: 1,
            status: 'FAILED',
            startedAt: '2026-09-11T02:00:01.000Z',
            finishedAt: '2026-09-11T02:00:09.000Z',
            output: null,
            error: {
              code: 'UNKNOWN',
              category: 'UNKNOWN',
              retryable: false,
              safeMessage: '接管时副作用步骤结果未确认',
            },
          },
        ],
      },
    ],
    ...overrides,
  }
}

const evidence: RunEvidenceListResponse = {
  items: [
    {
      schemaVersion: 1,
      id: '99999999-9999-4999-8999-999999999999',
      runId: RUN_ID,
      stepRunId: '66666666-6666-4666-8666-666666666666',
      attemptId: '88888888-8888-4888-8888-888888888888',
      type: 'error',
      status: 'available',
      createdAt: '2026-09-11T02:00:09.000Z',
      payload: { code: 'UNKNOWN', safeMessage: '接管时副作用步骤结果未确认' },
    },
  ],
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunDetailPage />
    </QueryClientProvider>,
  )
}

describe('RunDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchRun.mockResolvedValue(runDetail())
    mocks.fetchRunEvidence.mockResolvedValue(evidence)
    mocks.cancelRun.mockResolvedValue({ status: 'CANCELLED' })
    mocks.reviewRun.mockResolvedValue(undefined)
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  /** 验收 33 与 34：步骤、Attempt、证据、context 都要能看见，待核查是橙色且核查是主操作。 */
  it('待核查：橙色状态、核查是主操作，步骤/Attempt/证据/context 可见', async () => {
    signIn(['run:read', 'run:review', 'run:cancel', 'run:execute'])
    const screen = await renderPage()

    const badge = screen.getByText('待核查')
    await expect.element(badge).toBeInTheDocument()
    // D14：待核查用橙色（warning），不能混进红色失败语义
    expect(badge.element().closest('[data-slot="status-badge"]')?.className).toContain(
      'bg-status-warning-background',
    )

    // 场景与目标系统给人看的是名字，不是 UUID
    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    await expect.element(screen.getByText('演示商城')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('33333333-3333-4333-8333-333333333333')

    // 核查是这一页的主操作；待核查的 Run 不给取消按钮
    await expect.element(screen.getByRole('button', { name: '判定失败' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '判定取消' })).toBeInTheDocument()
    // 注意 exact：'判定取消' 也含'取消'，不加就永远命中
    expect(screen.getByRole('button', { name: '取消', exact: true }).elements()).toHaveLength(0)

    // 步骤、Attempt、错误、证据、context 一个都不许省
    await expect.element(screen.getByText('1. 提交订单')).toBeInTheDocument()
    await expect.element(screen.getByText(/Attempt #1/)).toBeInTheDocument()
    expect(document.body.textContent).toContain('接管时副作用步骤结果未确认')
    expect(document.body.textContent).toContain('greeting')
  })

  it('核查写入说明并调用接口', async () => {
    signIn(['run:read', 'run:review'])
    const screen = await renderPage()

    await screen.getByLabelText('核查说明').fill('人工确认订单未生成')
    await screen.getByRole('button', { name: '判定失败' }).click()

    expect(mocks.reviewRun).toHaveBeenCalledWith(RUN_ID, {
      conclusion: 'fail',
      note: '人工确认订单未生成',
    })
  })

  /** 验收 35：排队中的 Run 可以取消。 */
  it('排队中：取消按钮调用取消接口', async () => {
    mocks.fetchRun.mockResolvedValue(runDetail({ status: 'QUEUED', stepRuns: [] }))
    signIn(['run:read', 'run:cancel'])
    const screen = await renderPage()

    await screen.getByRole('button', { name: '取消', exact: true }).click()
    expect(mocks.cancelRun).toHaveBeenCalledWith(RUN_ID)
  })

  /** 验收 37：viewer 只读——看得见状态，但建不了、取消不了、核查不了。 */
  it('只读权限：看得见内容，没有取消与核查入口', async () => {
    signIn(['run:read'])
    const screen = await renderPage()

    await expect.element(screen.getByText('待核查')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '判定失败' }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '判定取消' }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '取消', exact: true }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '确认目标系统已登录' }).elements()).toHaveLength(0)
    // 刷新是只读操作，任何人都能点
    await expect.element(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  })

  it('失联会话：橙色说明须处置；等待 owner：灰色说明', async () => {
    mocks.fetchRun.mockResolvedValue(
      runDetail({
        status: 'QUEUED',
        stepRuns: [],
        placement: {
          state: 'session_lost',
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ownerWorkerId: 'worker-a',
          sessionStatus: 'LOST',
        },
      }),
    )
    signIn(['run:read'])
    const lost = await renderPage()
    await expect.element(lost.getByText(/会话失联，处置并确认旧浏览器停止后才会继续/)).toBeInTheDocument()
    expect(lost.getByText(/会话失联/).element().className).toContain('text-status-warning-foreground')

    mocks.fetchRun.mockResolvedValue(
      runDetail({
        status: 'QUEUED',
        stepRuns: [],
        placement: {
          state: 'owner_required',
          sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ownerWorkerId: 'worker-a',
          sessionStatus: 'OPEN',
        },
      }),
    )
    const waiting = await renderPage()
    await expect.element(waiting.getByText(/等待持有该账号会话的 Worker 领取/)).toBeInTheDocument()
    expect(waiting.getByText(/等待持有该账号会话/).element().className).toContain('text-muted-foreground')
  })

  it('两根轴并列：成功且证据不完整是橙色；终态收集中是灰色', async () => {
    mocks.fetchRun.mockResolvedValue(
      runDetail({ status: 'SUCCEEDED', evidenceStatus: 'INCOMPLETE', stepRuns: [] }),
    )
    signIn(['run:read'])
    const incomplete = await renderPage()
    await expect.element(incomplete.getByText('成功')).toBeInTheDocument()
    const incompleteBadge = incomplete.getByText('证据不完整')
    await expect.element(incompleteBadge).toBeInTheDocument()
    expect(incompleteBadge.element().closest('[data-slot="status-badge"]')?.className).toContain(
      'bg-status-warning-background',
    )

    mocks.fetchRun.mockResolvedValue(
      runDetail({ status: 'SUCCEEDED', evidenceStatus: 'PENDING', stepRuns: [] }),
    )
    const pending = await renderPage()
    const collecting = pending.getByText('证据收集中')
    await expect.element(collecting).toBeInTheDocument()
    expect(collecting.element().closest('[data-slot="status-badge"]')?.className).toContain(
      'bg-status-neutral-background',
    )
    expect(collecting.element().closest('[data-slot="status-badge"]')?.className).not.toContain(
      'bg-status-warning-background',
    )
  })

  it('缺失原因用橙色而不是红色；证据挂在对应 Attempt 下', async () => {
    mocks.fetchRunEvidence.mockResolvedValue({
      items: [
        {
          schemaVersion: 1,
          id: '99999999-9999-4999-8999-999999999991',
          runId: RUN_ID,
          stepRunId: '66666666-6666-4666-8666-666666666666',
          attemptId: '88888888-8888-4888-8888-888888888888',
          type: 'screenshot',
          status: 'missing',
          createdAt: '2026-09-11T02:00:09.000Z',
          missingReason: 'worker_lost',
        },
      ],
    })
    signIn(['run:read', 'run:review'])
    const screen = await renderPage()
    await expect.element(screen.getByText(/Attempt #1/)).toBeInTheDocument()
    await screen.getByText('截图').click()
    const reason = screen.getByText(/缺失原因：worker_lost/)
    await expect.element(reason).toBeInTheDocument()
    expect(reason.element().className).toContain('text-status-warning-foreground')
    expect(reason.element().className).not.toContain('text-destructive')
  })

  it('点刷新重新拉取运行与证据', async () => {
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText('待核查')).toBeInTheDocument()
    expect(mocks.fetchRun).toHaveBeenCalledTimes(1)

    await screen.getByRole('button', { name: '刷新' }).click()
    await vi.waitFor(() => expect(mocks.fetchRun).toHaveBeenCalledTimes(2))
    expect(mocks.fetchRunEvidence).toHaveBeenCalledTimes(2)
  })
})

/**
 * 验收 36 的一半：页面不得存在任何定时刷新。
 *
 * 宪法 §13 禁止把轮询当正常进度机制，P7 才上 SSE。这条只能在源码层面卡住——
 * 行为测试等不出"没有定时器"，而一个 refetchInterval 混进来之后就再没人会发现。
 */
describe('运行与场景页不得有定时刷新', () => {
  const sources = {
    ...import.meta.glob('../runs/*.tsx', { query: '?raw', import: 'default', eager: true }),
    ...import.meta.glob('../scenarios/*.tsx', { query: '?raw', import: 'default', eager: true }),
  } as Record<string, string>

  it('源码里没有 refetchInterval / setInterval / 自动重连', () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith('.test.tsx'))
      .filter(([, code]) => /refetchInterval|refetchIntervalInBackground|setInterval|EventSource/.test(code))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
