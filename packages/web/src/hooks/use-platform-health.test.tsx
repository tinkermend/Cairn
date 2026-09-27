import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { platformHealthResponseSchema, type PlatformHealthResponse, type PlatformHealthStatus } from '@cairn/shared'
import { PlatformHealthIndicator } from '@/components/layout/platform-health-indicator'
import { useAuthStore } from '@/stores/auth-store'
import { markPlatformHealthStale, usePlatformHealth } from './use-platform-health'

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }))

function snapshot(overall: PlatformHealthStatus): PlatformHealthResponse {
  const asOf = new Date().toISOString()
  return {
    overall,
    asOf,
    validUntil: new Date(Date.now() + 2_000).toISOString(),
    freshForMs: 2_000,
    checks: {
      api: { status: overall, code: 'API_STATE', message: '旧 API 状态' },
      database: { status: 'healthy', code: 'OK', message: '旧数据库状态' },
      worker: {
        status: 'degraded',
        code: 'WORKER_DEGRADED',
        message: '旧 Worker 状态',
        healthyNodes: 3,
        affectedActiveRuns: 2,
        affectedActiveSessions: 1,
      },
      changeHint: { status: 'healthy', code: 'OK', message: '旧提示链路状态' },
    },
  }
}

function Probe() {
  const { data, isStale, refresh } = usePlatformHealth()
  return (
    <div>
      <button type='button' onClick={() => void refresh()}>刷新</button>
      <span data-testid='overall'>{data?.overall ?? 'loading'}</span>
      <span data-testid='api'>{data?.checks.api.status ?? 'loading'}</span>
      <span data-testid='database'>{data?.checks.database.status ?? 'loading'}</span>
      <span data-testid='worker'>{data?.checks.worker.status ?? 'loading'}</span>
      <span data-testid='change-hint'>{data?.checks.changeHint.status ?? 'loading'}</span>
      <span data-testid='worker-count'>{data?.checks.worker.healthyNodes ?? 'loading'}</span>
      <span data-testid='stale'>{isStale ? 'expired' : 'fresh'}</span>
    </div>
  )
}

describe('平台健康快照过期', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset()
    useAuthStore.getState().auth.reset()
  })

  it.each(['healthy', 'degraded', 'critical', 'unknown'] as const)('将 %s 快照及全部组件明细标为未知', (overall) => {
    const stale = markPlatformHealthStale(snapshot(overall))
    expect(() => platformHealthResponseSchema.parse(stale)).not.toThrow()
    expect(stale.overall).toBe('unknown')
    for (const check of Object.values(stale.checks)) {
      expect(check).toMatchObject({ status: 'unknown', code: 'STALE', message: '状态已过期，等待重新检查' })
    }
    expect(stale.checks.worker).toMatchObject({
      healthyNodes: 0,
      affectedActiveRuns: 0,
      affectedActiveSessions: 0,
    })
  })

  it('刷新请求未返回时，不继续显示旧黄色或旧绿色组件状态', async () => {
    mocks.apiFetch.mockResolvedValueOnce(snapshot('degraded'))
    mocks.apiFetch.mockImplementation(() => new Promise(() => {}))

    const screen = await render(<Probe />)
    await expect.element(screen.getByTestId('overall')).toHaveTextContent('degraded')
    await vi.waitFor(async () => {
      await expect.element(screen.getByTestId('stale')).toHaveTextContent('expired')
    }, { timeout: 5_000 })
    for (const key of ['overall', 'api', 'database', 'worker', 'change-hint']) {
      await expect.element(screen.getByTestId(key)).toHaveTextContent('unknown')
    }
    await expect.element(screen.getByTestId('worker-count')).toHaveTextContent('0')
  })

  it('响应到达时已超过 validUntil，立即标记为过期', async () => {
    mocks.apiFetch.mockImplementationOnce(async () => {
      const result = snapshot('healthy')
      result.validUntil = new Date(Date.now() + 100).toISOString()
      result.freshForMs = 5_000
      await new Promise((resolve) => setTimeout(resolve, 250))
      return result
    })
    mocks.apiFetch.mockImplementation(() => new Promise(() => {}))

    const screen = await render(<Probe />)
    await vi.waitFor(async () => {
      await expect.element(screen.getByTestId('stale')).toHaveTextContent('expired')
    }, { timeout: 2_000 })
    await expect.element(screen.getByTestId('overall')).toHaveTextContent('unknown')
    await expect.element(screen.getByTestId('database')).toHaveTextContent('unknown')
  })

  it('健康详情弹层在过期后不保留旧组件绿灯或旧文案', async () => {
    mocks.apiFetch.mockResolvedValueOnce(snapshot('degraded'))
    mocks.apiFetch.mockImplementation(() => new Promise(() => {}))

    const screen = await render(<PlatformHealthIndicator />)
    await expect.element(screen.getByRole('button', { name: '平台健康状态：平台降级' })).toBeInTheDocument()
    await vi.waitFor(async () => {
      await expect.element(screen.getByRole('button', { name: '平台健康状态：状态未确认' })).toBeInTheDocument()
    }, { timeout: 5_000 })
    await userEvent.click(screen.getByRole('button', { name: '平台健康状态：状态未确认' }))
    await expect.element(screen.getByText('结果已过期')).toBeInTheDocument()
    expect(screen.getByText('状态已过期，等待重新检查').elements()).toHaveLength(4)
    expect(screen.getByText('旧数据库状态').elements()).toHaveLength(0)
    expect(screen.getByText('旧提示链路状态').elements()).toHaveLength(0)
  })

  it('较早请求晚到时不能覆盖后发起的刷新结果', async () => {
    let resolveFirst: ((value: PlatformHealthResponse) => void) | undefined
    const firstResponse = new Promise<PlatformHealthResponse>((resolve) => {
      resolveFirst = resolve
    })
    mocks.apiFetch.mockImplementationOnce(() => firstResponse)
    mocks.apiFetch.mockImplementationOnce(async () => snapshot('critical'))

    const screen = await render(<Probe />)
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    await expect.element(screen.getByTestId('overall')).toHaveTextContent('critical')

    resolveFirst?.(snapshot('healthy'))
    await firstResponse
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect.element(screen.getByTestId('overall')).toHaveTextContent('critical')
    await expect.element(screen.getByTestId('stale')).toHaveTextContent('fresh')
  })
})
