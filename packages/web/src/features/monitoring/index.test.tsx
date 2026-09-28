import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  knownMetric,
  unknownMetric,
  type MonitorProfileListResponse,
  type MonitoringOverviewResponse,
  type WorkerStatus,
  type WorkerSummary,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { AUTO_REFRESH_STORAGE_KEY } from './labels'
import { MonitoringPage } from './index'

const fetchMonitoringOverview = vi.fn()
const fetchMonitorProfiles = vi.fn()
const fetchMonitorSeries = vi.fn()
const fetchMonitorAlerts = vi.fn()
const probeObjectStore = vi.fn()
const subscribeMonitoringStream = vi.fn()
const fetchWorkers = vi.fn()
const fetchTargetSla = vi.fn()
const fetchAiModels = vi.fn()
const useCan = vi.fn(
  (permission: string) =>
    permission === 'session:read' || permission === 'monitor:read' || permission === 'platform-config:read',
)

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    search,
    children,
    ...props
  }: {
    to: string
    params?: { workerId: string }
    search?: Record<string, string | boolean | undefined>
    children: ReactNode
    'aria-label'?: string
  }) => {
    const path = to.replace('$workerId', params?.workerId ?? '')
    const qs = search
      ? `?${new URLSearchParams(
          Object.entries(search).flatMap(([key, value]) =>
            value == null || value === '' ? [] : [[key, String(value)]],
          ),
        ).toString()}`
      : ''
    return (
      <a href={`${path}${qs}`} {...props}>
        {children}
      </a>
    )
  },
}))
vi.mock('@/lib/monitoring-api', () => ({
  fetchMonitoringOverview: (...args: unknown[]) => fetchMonitoringOverview(...args),
  fetchMonitorProfiles: (...args: unknown[]) => fetchMonitorProfiles(...args),
  fetchMonitorSeries: (...args: unknown[]) => fetchMonitorSeries(...args),
  fetchMonitorAlerts: (...args: unknown[]) => fetchMonitorAlerts(...args),
  fetchTargetSla: (...args: unknown[]) => fetchTargetSla(...args),
  fetchAiModels: (...args: unknown[]) => fetchAiModels(...args),
  silenceMonitorAlert: vi.fn(),
  probeObjectStore: (...args: unknown[]) => probeObjectStore(...args),
  subscribeMonitoringStream: (...args: unknown[]) => subscribeMonitoringStream(...args),
}))
vi.mock('@/lib/workers-api', () => ({
  fetchWorkers: (...args: unknown[]) => fetchWorkers(...args),
}))
vi.mock('@/hooks/use-permissions', () => ({
  useCan: (permission: string) => useCan(permission),
}))

const AS_OF = '2026-09-18T03:00:00.000Z'
const INSTANCE = '11111111-1111-4111-8111-111111111111'

function overview(overrides: Partial<MonitoringOverviewResponse['partitions']> = {}): MonitoringOverviewResponse {
  return {
    asOf: AS_OF,
    partitions: {
      service: {
        availability: 'available',
        source: 'self',
        sampledAt: AS_OF,
        data: {
          api: { status: 'ok', service: 'cairn-api', uptimeSeconds: knownMetric(12) },
          database: {
            driver: 'postgres',
            ping: 'down',
            pingLatencyMs: knownMetric(3),
            expectedLogicalVersion: '0059',
            appliedPrefix: '0059',
            expectedPrefix: '0059',
            schemaConsistency: 'consistent',
            pool: {
              totalCount: unknownMetric('unsupported'),
              idleCount: unknownMetric('unsupported'),
              waitingCount: unknownMetric('unsupported'),
            },
          },
          changeHint: {
            status: 'unused',
            realtime: false,
            realtimeProgressAvailable: false,
            consequence: '实时进度不可用',
          },
          apiInstances: {
            ready: unknownMetric('not_collected'),
            lost: unknownMetric('not_collected'),
            derivedCount: knownMetric(1),
            items: [
              {
                id: 'dev-host:3030',
                idSource: 'derived',
                instanceId: INSTANCE,
                status: 'READY',
                version: null,
                schemaLogicalVersion: '0062',
                heartbeatAt: AS_OF,
                heartbeatExpiresAt: '2026-09-18T03:01:00.000Z',
                startedAt: AS_OF,
                rssBytes: unknownMetric('not_reported'),
                eventLoopDelayMs: unknownMetric('not_reported'),
                sseConnections: unknownMetric('not_reported'),
                internalForwardInFlight: unknownMetric('not_reported'),
              },
            ],
          },
          objectStore: {
            status: unknownMetric('not_collected'),
            latencyMs: unknownMetric('not_collected'),
            probedAt: null,
            errorClass: null,
          },
        },
      },
      capacity: {
        availability: 'available',
        source: 'registry',
        sampledAt: AS_OF,
        data: {
          workers: {
            ready: knownMetric(1),
            draining: knownMetric(0),
            stopped: knownMetric(1),
            lost: knownMetric(1),
            heartbeatFresh: knownMetric(1),
            heartbeatStale: knownMetric(1),
          },
          capacity: { total: knownMetric(4), used: knownMetric(1) },
          sessions: { total: knownMetric(4), used: knownMetric(1) },
          slots: {
            occupied: knownMetric(1),
            lostOccupied: knownMetric(1),
            executing: knownMetric(1),
            running: knownMetric(1),
            holding: knownMetric(0),
            waitingForAuth: knownMetric(1),
            leftoverAuthHolds: knownMetric(0),
            expiredLeaseResidue: knownMetric(0),
            runCapacityUsed: knownMetric(1),
          },
          workerSamples: {
            items: [
              {
                workerId: 'worker-ready',
                rssBytes: knownMetric(2048),
                cpuPercent: knownMetric(3),
                eventLoopDelayMs: knownMetric(1),
                browserProcessCount: knownMetric(1),
                clockSkewMs: knownMetric(0),
                sampledAt: AS_OF,
              },
            ],
          },
        },
      },
      queues: {
        availability: 'unavailable',
        reasonCode: 'DATA_PLANE_UNAVAILABLE',
        message: '数据面不可用',
      },
      anomalies: {
        availability: 'available',
        source: 'aggregate',
        sampledAt: AS_OF,
        data: {
          leases: {
            expiredActiveRunLeases: knownMetric(0),
            expiredActiveSessionLeases: knownMetric(0),
            leftoverAuthHolds: knownMetric(0),
            orphanAttempts: knownMetric(0),
            recoveryCappedRuns: knownMetric(0),
          },
          evidence: {
            pendingUpload: knownMetric(2),
            uploadFailed: knownMetric(0),
            maxUploadAttempts: knownMetric(3),
            purgeBacklog: knownMetric(0),
            purgeFailed: knownMetric(0),
            missingReasons: [],
          },
          clockSkew: { maxAbsSkewMs: unknownMetric('not_collected') },
        },
      },
      ai: {
        availability: 'available',
        source: 'aggregate',
        sampledAt: AS_OF,
        data: {
          calls: knownMetric(0),
          errors: knownMetric(0),
          inputTokens: knownMetric(0),
          outputTokens: knownMetric(0),
          durationP95Ms: unknownMetric('not_collected'),
          cost: unknownMetric('not_collected'),
          lastCallAt: null,
          lastErrorAt: null,
          lastErrorClass: null,
        },
      },
      sla: {
        availability: 'available',
        source: 'aggregate',
        sampledAt: AS_OF,
        data: {
          windowHours: 24,
          totalRuns: 10,
          succeededRuns: 9,
          successRate: 90,
          failedRuns: 1,
          p95DurationMs: 1200,
          throughputRpm: 5,
        },
      },
      ...overrides,
    },
  }
}

function worker(workerId: string, status: WorkerStatus, heartbeatFresh: boolean): WorkerSummary {
  return {
    workerId,
    instanceId: INSTANCE,
    status,
    heartbeatAt: AS_OF,
    lostAfterSeconds: 60,
    heartbeatExpiresAt: heartbeatFresh ? '2026-09-18T03:01:00.000Z' : AS_OF,
    heartbeatFresh,
    capacity: 2,
    maxSessions: 2,
    counts: {
      occupiedSlots: 1,
      lostOccupied: status === 'LOST' ? 1 : 0,
      executingSlots: 0,
      running: status === 'READY' ? 1 : 0,
      holding: 0,
      waitingForAuth: 0,
      leftoverAuthHolds: 0,
      expiredLeaseResidue: 0,
      runCapacityUsed: 0,
    },
    handleSample: {
      liveHandleCount: null,
      sampledSlotCount: null,
      handleMismatchStreak: 0,
      handleSampledAt: null,
      mismatchState: 'unknown',
    },
    routeAvailability: status === 'READY' && heartbeatFresh ? 'eligible' : 'unavailable',
    routeReason: status === 'READY' && heartbeatFresh ? null : 'worker_not_ready',
    endpointSource: 'none',
    internalEndpoint: null,
    listenHost: '192.168.1.100',
    listenPort: 8091,
    hostname: 'worker-host-1',
  }
}

function profiles(): MonitorProfileListResponse {
  return {
    asOf: AS_OF,
    items: [
      {
        profileKey: 't1/a1',
        locationWorkerId: 'worker-ready',
        state: 'PRESENT',
        revision: 1,
        pendingCleanups: 2,
        targetId: '11111111-1111-4111-8111-111111111111',
        targetAccountId: '22222222-2222-4222-8222-222222222222',
        targetName: '演示商城',
        accountLabel: '巡检账号',
        updatedAt: AS_OF,
        diskUsageBytes: unknownMetric('not_collected'),
      },
    ],
    nextCursor: undefined,
    nodes: [],
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MonitoringPage />
    </QueryClientProvider>,
  )
}

describe('运行监控页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem(AUTO_REFRESH_STORAGE_KEY)
    useCan.mockImplementation(
      (permission: string) =>
        permission === 'session:read' || permission === 'monitor:read' || permission === 'platform-config:read',
    )
    fetchMonitoringOverview.mockResolvedValue(overview())
    fetchMonitorAlerts.mockResolvedValue({ asOf: AS_OF, items: [] })
    fetchMonitorProfiles.mockResolvedValue(profiles())
    fetchMonitorSeries.mockResolvedValue({
      asOf: AS_OF,
      from: AS_OF,
      to: AS_OF,
      scope: 'platform',
      scopeId: '',
      items: [],
    })
    fetchWorkers.mockResolvedValue({
      items: [worker('worker-ready', 'READY', true), worker('worker-stopped', 'STOPPED', true)],
      asOf: AS_OF,
    })
    fetchTargetSla.mockResolvedValue({ asOf: AS_OF, windowHours: 24, items: [] })
    fetchAiModels.mockResolvedValue({ asOf: AS_OF, windowHours: 24, items: [] })
    subscribeMonitoringStream.mockImplementation(async (input: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
  })

  afterEach(() => {
    localStorage.removeItem(AUTO_REFRESH_STORAGE_KEY)
  })

  it('分区降级只影响该区，三类失败可区分，unknown 不显示 0', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByRole('heading', { name: '监控', exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
    await expect.element(screen.getByText('自动刷新')).toBeInTheDocument()

    // 检查第一层全局概览卡片
    await expect.element(screen.getByText('业务执行 SLA')).toBeInTheDocument()
    await expect.element(screen.getByText('平台容量与舰队')).toBeInTheDocument()
    await expect.element(screen.getByText('核心服务基线')).toBeInTheDocument()
    await expect.element(screen.getByText('AI 推理流速')).toBeInTheDocument()

    const pageText = screen.container.textContent ?? ''
    expect(pageText).toContain('此刻的事实')
    expect(pageText).toContain('当前没有未恢复告警')
    expect(pageText).toContain('配置规则')

    // 切换到“队列与租约守卫” Tab 检查分区失败降级
    await screen.getByRole('tab', { name: '队列与租约守卫' }).click()
    await expect.element(screen.getByText('监控数据读取失败', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('数据面不可用，监控数据读取失败。其余分区仍可查看。')).toBeInTheDocument()
    await expect.element(screen.getByText('证据待上传', { exact: true })).toBeInTheDocument()

    // 切换到“Worker 节点与沙箱” Tab 检查节点列表
    await screen.getByRole('tab', { name: 'Worker 节点与沙箱' }).click()
    await expect.element(screen.getByRole('cell', { name: '已停止' })).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: '查看节点 worker-ready' })).toHaveAttribute(
      'href',
      '/workers/worker-ready',
    )
  })

  it('全局概览单卡片降级，不拖累同层其余卡片', async () => {
    fetchMonitoringOverview.mockResolvedValue(
      overview({
        service: {
          availability: 'unavailable',
          reasonCode: 'DATA_PLANE_UNAVAILABLE',
          message: '数据面不可用',
        },
      }),
    )
    const screen = await renderPage()

    // 核心服务卡片降级为失败提示
    await expect.element(screen.getByText('数据面不可用，监控数据读取失败。其余分区仍可查看。')).toBeInTheDocument()

    // 同一层的其余三张卡片（业务 SLA / AI 推理 / 容量与舰队）不受影响，仍然渲染
    await expect.element(screen.getByText('业务执行 SLA')).toBeInTheDocument()
    await expect.element(screen.getByText('AI 推理流速')).toBeInTheDocument()
    await expect.element(screen.getByText('平台容量与舰队')).toBeInTheDocument()
  })

  it('整页读取失败与无权限文案分开', async () => {
    fetchMonitoringOverview.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL', message: 'boom', requestId: 'r' }),
    )
    const screen = await renderPage()
    await expect.element(screen.getByText('监控数据读取失败')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('服务异常')
  })

  it('无会话读取权限时节点表显示无权限，其余分区仍在', async () => {
    useCan.mockImplementation((permission: string) => permission === 'monitor:read')
    const screen = await renderPage()
    await expect.element(screen.getByText('平台容量与舰队')).toBeInTheDocument()

    // 切换到 Worker 节点与沙箱 Tab 确认无权限占位与提示
    await screen.getByRole('tab', { name: 'Worker 节点与沙箱' }).click()
    await expect.element(screen.getByText('无权限')).toBeInTheDocument()
    await expect.element(screen.getByText('查看节点列表需要会话读取权限。可从容量水位了解舰队计数。')).toBeInTheDocument()
    expect(fetchWorkers).not.toHaveBeenCalled()
  })

  it('空 Profile 有明确反馈', async () => {
    fetchMonitorProfiles.mockResolvedValue({ asOf: AS_OF, items: [] })
    const screen = await renderPage()
    await expect.element(screen.getByText('还没有 Profile 落点')).toBeInTheDocument()
  })

  it('同时具备 run:read 才把证据异常链到证据中心', async () => {
    const withoutRead = await renderPage()
    await withoutRead.getByRole('tab', { name: '队列与租约守卫' }).click()
    expect(withoutRead.container.querySelector('a[href^="/evidence"]')).toBeNull()
    withoutRead.unmount()
    useCan.mockImplementation(
      (permission: string) =>
        permission === 'session:read' ||
        permission === 'monitor:read' ||
        permission === 'platform-config:read' ||
        permission === 'run:read',
    )
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '队列与租约守卫' }).click()
    await expect.element(screen.getByRole('link', { name: '证据上传失败' })).toHaveAttribute(
      'href',
      '/evidence?view=capture_upload_anomaly',
    )
    await expect.element(screen.getByRole('link', { name: '清理积压' })).toHaveAttribute(
      'href',
      '/evidence?tab=retention&retentionView=pending_cleanup',
    )
  })
})


