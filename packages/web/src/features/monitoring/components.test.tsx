import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { Progress } from '@/components/ui/progress'
import { SegmentedStatusBar } from './components/segmented-status-bar'
import { StatusBanner } from './components/status-banner'
import { MonitoringChartsGrid } from './components/monitoring-charts-grid'
import { DrilldownTabs } from './components/drilldown-tabs'
import type { MonitorCapacityCard } from '@cairn/shared'

const fetchMonitorAlerts = vi.fn()
const fetchMonitorSeries = vi.fn()
const fetchWorkers = vi.fn()
const useCan = vi.fn((_permission?: string) => true)

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

vi.mock('@/lib/monitoring-api', () => ({
  fetchMonitorAlerts: (...args: unknown[]) => fetchMonitorAlerts(...args),
  fetchMonitorSeries: (...args: unknown[]) => fetchMonitorSeries(...args),
  fetchAiModels: vi.fn().mockResolvedValue({ asOf: '2026-09-22T00:00:00Z', items: [] }),
  fetchTargetSla: vi.fn().mockResolvedValue({ asOf: '2026-09-22T00:00:00Z', items: [] }),
  silenceMonitorAlert: vi.fn(),
}))

vi.mock('@/lib/workers-api', () => ({
  fetchWorkers: (...args: unknown[]) => fetchWorkers(...args),
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: (perm: string) => useCan(perm),
}))

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

describe('监控增强组件 (Visualization & Layout Components)', () => {
  it('Progress 组件正确根据 value 渲染宽度与指示条', async () => {
    const screen = await render(<Progress value={45} indicatorClassName="bg-primary" />)
    const bar = screen.container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-valuenow')).toBe('45')
    const inner = bar?.querySelector('div')
    expect(inner?.getAttribute('style')).toContain('width: 45%')
  })

  it('SegmentedStatusBar 正确按比例分段并展示图例', async () => {
    const screen = await render(
      <SegmentedStatusBar
        segments={[
          { key: 'ready', label: '就绪', count: 8, color: 'var(--status-success)' },
          { key: 'lost', label: '失联', count: 2, color: 'var(--status-error)' },
        ]}
      />
    )
    expect(screen.container.textContent).toContain('就绪8')
    expect(screen.container.textContent).toContain('失联2')
    const segments = screen.container.querySelectorAll('[style*="width"]')
    expect(segments.length).toBe(2)
  })

  it('StatusBanner 在有未恢复告警时展示警告条与明细切换', async () => {
    fetchMonitorAlerts.mockResolvedValue({
      asOf: '2026-09-22T00:00:00Z',
      items: [
        {
          id: 'alt-1',
          ruleName: '数据库延迟偏高',
          state: 'active',
          metricKey: 'database.pingLatencyMs',
          scope: 'platform',
          scopeId: 'db',
          conditionOpenedAt: '2026-09-22T00:00:00Z',
          triggerValue: 120,
          threshold: 50,
          comparator: '>',
          noticeKind: 'webhook',
        },
      ],
    })

    const screen = await render(wrap(<StatusBanner />))
    await expect.element(screen.getByText('发现 1 条未恢复告警')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /查看明细/ })).toBeInTheDocument()
  })

  it('MonitoringChartsGrid 渲染三大主题时序面板并支持时间范围切换', async () => {
    fetchMonitorSeries.mockResolvedValue({
      asOf: '2026-09-22T00:00:00Z',
      from: '2026-09-21T18:00:00Z',
      to: '2026-09-22T00:00:00Z',
      scope: 'platform',
      scopeId: '',
      items: [
        {
          key: 'worker.capacity.used',
          scope: 'platform',
          scopeId: '',
          points: [{ bucketAt: '2026-09-22T00:00:00Z', value: 3 }],
        },
      ],
    })

    const screen = await render(wrap(<MonitoringChartsGrid asOf="2026-09-22T00:00:00Z" />))
    await expect.element(screen.getByText('运行并发与调度队列')).toBeInTheDocument()
    await expect.element(screen.getByText('证据上传与过期租约走势')).toBeInTheDocument()
    await expect.element(screen.getByText('AI 模型调用量与失败频次')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '24小时' })).toBeInTheDocument()
  })

  it('StatusBanner 展开后支持按告警严重级别筛选', async () => {
    fetchMonitorAlerts.mockResolvedValue({
      asOf: '2026-09-22T00:00:00Z',
      items: [
        {
          id: 'alt-crit',
          ruleName: '数据库宕机',
          state: 'active',
          severity: 'critical',
          metricKey: 'database.pingLatencyMs',
          scope: 'platform',
          scopeId: 'db',
          conditionOpenedAt: '2026-09-22T00:00:00Z',
          triggerValue: 999,
          threshold: 50,
          comparator: '>',
          noticeKind: 'webhook',
        },
        {
          id: 'alt-warn',
          ruleName: '内存使用较高',
          state: 'active',
          severity: 'warning',
          metricKey: 'worker.rssBytes',
          scope: 'platform',
          scopeId: 'worker',
          conditionOpenedAt: '2026-09-22T00:00:00Z',
          triggerValue: 80,
          threshold: 75,
          comparator: '>',
          noticeKind: 'webhook',
        },
      ],
    })

    const screen = await render(wrap(<StatusBanner />))
    const toggleBtn = screen.getByRole('button', { name: /查看明细/ })
    await toggleBtn.click()

    await expect.element(screen.getByText('全部 (2)')).toBeInTheDocument()
    await expect.element(screen.getByText('严重 (1)')).toBeInTheDocument()
    await expect.element(screen.getByText('警告 (1)')).toBeInTheDocument()

    // 点击筛选“严重”
    const critBtn = screen.getByRole('button', { name: '严重 (1)' })
    await critBtn.click()

    await expect.element(screen.getByText('数据库宕机')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('内存使用较高')
  })

  it('DrilldownTabs 支持 Worker 角色舰队卡片呈现与下钻筛选', async () => {
    fetchWorkers.mockResolvedValue({
      items: [
        {
          workerId: 'worker-executor-0',
          instanceId: 'i-1',
          status: 'READY',
          heartbeatAt: '2026-09-22T00:00:00Z',
          lostAfterSeconds: 45,
          heartbeatExpiresAt: '2026-09-22T00:01:00Z',
          heartbeatFresh: true,
          capacity: 2,
          maxSessions: 2,
          counts: {
            occupiedSlots: 1,
            lostOccupied: 0,
            executingSlots: 1,
            running: 1,
            holding: 0,
            waitingForAuth: 0,
            leftoverAuthHolds: 0,
            expiredLeaseResidue: 0,
            runCapacityUsed: 1,
          },
          handleSample: {
            liveHandleCount: null,
            sampledSlotCount: null,
            handleMismatchStreak: 0,
            handleSampledAt: null,
            mismatchState: 'unknown',
          },
          routeAvailability: 'available',
          routeReason: null,
          endpointSource: 'database',
          internalEndpoint: null,
          listenHost: null,
          listenPort: null,
          hostname: null,
        },
        {
          workerId: 'worker-scheduler-0',
          instanceId: 'i-2',
          status: 'READY',
          heartbeatAt: '2026-09-22T00:00:00Z',
          lostAfterSeconds: 45,
          heartbeatExpiresAt: '2026-09-22T00:01:00Z',
          heartbeatFresh: true,
          capacity: 1,
          maxSessions: 2,
          counts: {
            occupiedSlots: 0,
            lostOccupied: 0,
            executingSlots: 0,
            running: 0,
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
          routeAvailability: 'available',
          routeReason: null,
          endpointSource: 'database',
          internalEndpoint: null,
          listenHost: null,
          listenPort: null,
          hostname: null,
        },
      ],
      nextCursor: undefined,
      asOf: '2026-09-22T00:00:00Z',
    })

    const testCapacity: MonitorCapacityCard = {
      workers: {
        ready: { availability: 'known', value: 2 },
        draining: { availability: 'known', value: 0 },
        stopped: { availability: 'known', value: 0 },
        lost: { availability: 'known', value: 0 },
        heartbeatFresh: { availability: 'known', value: 2 },
        heartbeatStale: { availability: 'known', value: 0 },
      },
      capacity: { total: { availability: 'known', value: 4 }, used: { availability: 'known', value: 1 } },
      sessions: { total: { availability: 'known', value: 4 }, used: { availability: 'known', value: 1 } },
      slots: {
        occupied: { availability: 'known', value: 1 },
        lostOccupied: { availability: 'known', value: 0 },
        executing: { availability: 'known', value: 1 },
        running: { availability: 'known', value: 1 },
        holding: { availability: 'known', value: 0 },
        waitingForAuth: { availability: 'known', value: 0 },
        leftoverAuthHolds: { availability: 'known', value: 0 },
        expiredLeaseResidue: { availability: 'known', value: 0 },
        runCapacityUsed: { availability: 'known', value: 1 },
      },
      workerSamples: {
        items: [],
      },
    }

    const screen = await render(
      wrap(
        <DrilldownTabs
          capacity={testCapacity}
          queues={{} as any}
          anomalies={{} as any}
          canReadWorkers={true}
        />,
      ),
    )

    // 切换到 Worker 节点与沙箱 Tab
    await screen.getByRole('tab', { name: 'Worker 节点与沙箱' }).click()

    // 检查卡片存在
    await expect.element(screen.getByRole('button', { name: '聚焦执行器集群' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '聚焦调度守卫' })).toBeInTheDocument()

    // 初始展示全部节点
    await expect.element(screen.getByText('worker-executor-0')).toBeInTheDocument()
    await expect.element(screen.getByText('worker-scheduler-0')).toBeInTheDocument()

    // 点击执行器卡片筛选
    await screen.getByRole('button', { name: '聚焦执行器集群' }).click()
    await expect.element(screen.getByText('worker-executor-0')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('worker-scheduler-0')

    // 再次点击卡片重置为全部
    await screen.getByRole('button', { name: '聚焦执行器集群' }).click()
    await expect.element(screen.getByText('worker-scheduler-0')).toBeInTheDocument()
  })
})

