import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { knownMetric, type MonitoringOverviewResponse } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { connectionLabel, useMonitoringObservation } from './use-monitoring-observation'
import { AUTO_REFRESH_STORAGE_KEY } from './labels'

const mocks = vi.hoisted(() => ({
  fetchMonitoringOverview: vi.fn(),
  subscribeMonitoringStream: vi.fn(),
}))

vi.mock('@/lib/monitoring-api', () => mocks)

const AS_OF = '2026-09-18T03:00:00.000Z'

function snapshot(asOf = AS_OF): MonitoringOverviewResponse {
  return {
    asOf,
    partitions: {
      service: { availability: 'unavailable', reasonCode: 'AGGREGATE_FAILED', message: '聚合失败' },
      capacity: { availability: 'unavailable', reasonCode: 'DATA_PLANE_UNAVAILABLE', message: '数据面不可用' },
      queues: { availability: 'unavailable', reasonCode: 'AGGREGATE_FAILED', message: '聚合失败' },
      anomalies: {
        availability: 'available',
        source: 'aggregate',
        sampledAt: asOf,
        data: {
          leases: {
            expiredActiveRunLeases: knownMetric(0),
            expiredActiveSessionLeases: knownMetric(0),
            leftoverAuthHolds: knownMetric(0),
            orphanAttempts: knownMetric(0),
            recoveryCappedRuns: knownMetric(0),
          },
          evidence: {
            pendingUpload: knownMetric(0),
            uploadFailed: knownMetric(0),
            maxUploadAttempts: knownMetric(0),
            purgeBacklog: knownMetric(0),
            purgeFailed: knownMetric(0),
            missingReasons: [],
          },
          clockSkew: { maxAbsSkewMs: knownMetric(0) },
        },
      },
      ai: {
        availability: 'unavailable',
        reasonCode: 'AGGREGATE_FAILED',
        message: 'AI 账本尚未采集',
      },
    },
  }
}

type StreamInput = {
  signal: AbortSignal
  lastEventId?: string
  handlers: {
    onSnapshot?: (snapshot: MonitoringOverviewResponse) => void
    onControl?: (control: { kind: string; intervalMs?: number; minIntervalMs?: number; code?: string }) => void
  }
}

function captureSubscribe() {
  let handlers: StreamInput['handlers'] | undefined
  mocks.subscribeMonitoringStream.mockImplementation(async (input: StreamInput) => {
    handlers = input.handlers
    input.handlers.onControl?.({ kind: 'ready', intervalMs: 5_000, minIntervalMs: 5_000 })
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) {
        resolve()
        return
      }
      input.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  return {
    emitSnapshot() {
      handlers?.onSnapshot?.(snapshot())
    },
    emitControl(control: { kind: string; code?: string }) {
      handlers?.onControl?.(control)
    },
  }
}

function Probe() {
  const obs = useMonitoringObservation()
  return (
    <div>
      <span>{obs.overview.data?.asOf ?? 'none'}</span>
      <span>{connectionLabel(obs.connection)}</span>
      <span>{obs.autoRefresh ? 'auto-on' : 'auto-off'}</span>
      <button type='button' onClick={() => void obs.refresh()}>
        刷新
      </button>
      <button type='button' onClick={() => obs.setAutoRefresh(false)}>
        关闭自动刷新
      </button>
    </div>
  )
}

async function renderHook() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  return { screen, client }
}

describe('useMonitoringObservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem(AUTO_REFRESH_STORAGE_KEY)
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试',
      email: null,
      roles: [],
      permissions: ['monitor:read'],
    })
    useAuthStore.getState().auth.setAccessToken('token-a')
    mocks.fetchMonitoringOverview.mockResolvedValue(snapshot())
    captureSubscribe()
  })

  afterEach(() => {
    useAuthStore.getState().auth.reset()
    localStorage.removeItem(AUTO_REFRESH_STORAGE_KEY)
  })

  it('快照 GET 是事实源，SSE 只提示刷新且合并请求', async () => {
    let calls = 0
    mocks.fetchMonitoringOverview.mockImplementation(async () => {
      calls += 1
      if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 40))
      return snapshot()
    })
    const stream = captureSubscribe()
    const { screen } = await renderHook()
    await expect.element(screen.getByText('推送已连接')).toBeInTheDocument()
    const afterReady = calls
    for (let i = 0; i < 5; i += 1) stream.emitSnapshot()
    await vi.waitFor(() => expect(calls).toBeGreaterThan(afterReady))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(calls - afterReady).toBeLessThanOrEqual(2)
  })

  it('403 停止重连并显示无权限', async () => {
    mocks.subscribeMonitoringStream.mockImplementation(async () => {
      throw new ApiRequestError(403, { code: 'FORBIDDEN', message: '无权限', requestId: 'r1' })
    })
    const { screen } = await renderHook()
    await expect.element(screen.getByText(AS_OF)).toBeInTheDocument()
    await vi.waitFor(() => expect(mocks.subscribeMonitoringStream).toHaveBeenCalled())
    await expect.element(screen.getByText('无权限')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mocks.subscribeMonitoringStream).toHaveBeenCalledTimes(1)
  })

  it('关闭自动刷新后记住并停止订阅', async () => {
    const { screen } = await renderHook()
    await expect.element(screen.getByText('auto-on')).toBeInTheDocument()
    await screen.getByRole('button', { name: '关闭自动刷新' }).click()
    await expect.element(screen.getByText('auto-off')).toBeInTheDocument()
    expect(localStorage.getItem(AUTO_REFRESH_STORAGE_KEY)).toBe('off')
    await expect.element(screen.getByText('推送未订阅')).toBeInTheDocument()
  })

  it('标签页隐藏时暂停订阅，恢复可见后补取快照', async () => {
    const { screen } = await renderHook()
    await expect.element(screen.getByText('推送已连接')).toBeInTheDocument()
    const beforeHide = mocks.subscribeMonitoringStream.mock.calls.length
    const fetchesBeforeHide = mocks.fetchMonitoringOverview.mock.calls.length
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await expect.element(screen.getByText('推送未订阅')).toBeInTheDocument()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await expect.element(screen.getByText('推送已连接')).toBeInTheDocument()
    expect(mocks.subscribeMonitoringStream.mock.calls.length).toBeGreaterThan(beforeHide)
    await vi.waitFor(() =>
      expect(mocks.fetchMonitoringOverview.mock.calls.length).toBeGreaterThan(fetchesBeforeHide),
    )
  })
})
