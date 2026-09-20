import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth-store'
import { OverviewPage } from './index'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

const mockAnalytics = {
  asOf: '2026-09-20T00:00:00.000Z',
  range: '7d',
  summary: {
    totalRuns: 1280,
    succeededRuns: 1240,
    failedRuns: 30,
    timedOutRuns: 5,
    canceledRuns: 5,
    runningRuns: 0,
    pendingRuns: 0,
    successRate: 0.968,
    avgDurationMs: 12000,
    p95DurationMs: 25000,
    runsDeltaPercentage: 15.2,
    successRateDeltaPercentage: 2.1,
  },
  timeline: [
    {
      bucketAt: '2026-09-19T00:00:00.000Z',
      total: 150,
      succeeded: 145,
      failed: 5,
      timedOut: 0,
      canceled: 0,
      running: 0,
      successRate: 0.966,
      p95DurationMs: 15000,
    },
  ],
  outcomes: {
    passed: 1200,
    violation: 50,
    failed: 30,
    notEvaluated: 0,
  },
  triggers: {
    manual: 500,
    schedule: 400,
    serviceApi: 300,
    suiteMember: 80,
  },
  topScenarios: [
    {
      scenarioId: '018f3a2b-1111-7000-8000-000000000001',
      scenarioName: '核心采购下单流程',
      targetId: '018f3a2b-1111-7000-8000-000000000002',
      targetName: 'ERP系统',
      runCount: 320,
      failCount: 4,
      successRate: 0.988,
    },
  ],
  troubledScenarios: [],
}

vi.mock('@/lib/overview-api', () => ({
  fetchOverviewAnalytics: vi.fn(async () => mockAnalytics),
}))

vi.mock('@/lib/monitoring-api', () => ({
  fetchMonitoringOverview: vi.fn(async () => ({
    asOf: '2026-09-20T00:00:00.000Z',
    partitions: {
      service: {
        availability: 'available',
        data: { objectStore: { status: 'ok', latencyMs: { status: 'known', value: 12 } } },
      },
      capacity: {
        availability: 'available',
        data: {
          workers: { ready: { status: 'known', value: 8 }, total: { status: 'known', value: 8 }, lost: { status: 'known', value: 0 } },
          capacity: { used: { status: 'known', value: 4 }, total: { status: 'known', value: 10 } },
          sessions: { used: { status: 'known', value: 12 } },
        },
      },
      queues: {
        availability: 'available',
        data: {
          claimableRuns: { status: 'known', value: 0 },
          needsReview: { status: 'known', value: 0 },
        },
      },
      anomalies: {
        availability: 'available',
        data: {
          leases: { expiredActiveRunLeases: { status: 'known', value: 0 } },
        },
      },
      ai: {
        availability: 'available',
        data: {
          calls: { status: 'known', value: 4520 },
          errors: { status: 'known', value: 12 },
          inputTokens: { status: 'known', value: 1200000 },
          outputTokens: { status: 'known', value: 600000 },
          durationP95Ms: { status: 'known', value: 1850 },
        },
      },
    },
  })),
  fetchMonitorSeries: vi.fn(async () => ({
    asOf: '2026-09-20T00:00:00.000Z',
    series: [],
  })),
}))

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionSystemOverview: vi.fn(async () => ({
    asOf: '2026-09-20T00:00:00.000Z',
    items: [
      {
        targetId: 't1',
        targetName: 'ERP生产系统',
        targetCode: 'erp-prod',
        targetStatus: 'active',
        accountTotal: 10,
        readyCount: 9,
        problemCount: 1,
        unpreparedCount: 0,
        busyCount: 0,
        retainedCount: 0,
        worstStatus: 'AVAILABLE',
      },
    ],
    nextCursor: null,
    summary: {
      systems: 1,
      readyAccounts: 9,
      problemAccounts: 1,
      unpreparedAccounts: 0,
    },
  })),
}))

describe('OverviewPage', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试管理员',
      email: 'admin@example.com',
      roles: ['admin'],
      permissions: ['run:read', 'monitor:read', 'session:read'],
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('渲染总览页面标题与问候语', async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>
    )

    await expect.element(screen.getByRole('heading', { name: /你好，测试管理员/ })).toBeInTheDocument()
    await expect.element(screen.getByText('累计执行总数')).toBeInTheDocument()
    await expect.element(screen.getByText('综合执行成功率')).toBeInTheDocument()
    await expect.element(screen.getByText('AI 智能调用')).toBeInTheDocument()
    await expect.element(screen.getByText('目标系统与账号')).toBeInTheDocument()
    await expect.element(screen.getByText('集群算力利用率')).toBeInTheDocument()
  })

  it('渲染五大分区核心大图与场景排行', async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>
    )

    // Zone 2 图表标题
    await expect.element(screen.getByRole('heading', { name: '执行态势与成功率走势' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '业务成果断言分布' })).toBeInTheDocument()

    // Zone 3 AI 标题
    await expect.element(screen.getByRole('heading', { name: 'AI 步骤调用时序' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: 'Token 吞吐量与模型开销' })).toBeInTheDocument()

    // Zone 4 排行与目标系统
    await expect.element(screen.getByRole('heading', { name: /高频活跃场景排行/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '目标系统与会话健康就绪' })).toBeInTheDocument()

    // Zone 5 底部韧性
    await expect.element(screen.getByText('执行节点')).toBeInTheDocument()
    await expect.element(screen.getByText('调度排队')).toBeInTheDocument()
  })
})
