import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetailDto, RunObservation } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { connectionLabel, useRunObservation } from './use-run-observation'

const RUN_ID = '44444444-4444-4444-8444-444444444444'

const mocks = vi.hoisted(() => ({
  fetchRunObservation: vi.fn(),
  subscribeRunEvents: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => mocks)

function runDetail(overrides: Partial<RunDetailDto> = {}): RunDetailDto {
  return {
    id: RUN_ID,
    status: 'QUEUED',
    cancelRequested: false,
    targetId: '11111111-1111-4111-8111-111111111111',
    targetName: '演示商城',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: '33333333-3333-4333-8333-333333333333',
    scenarioName: '下单巡检',
    scenarioVersionId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-09-11T02:00:00.000Z',
    startedAt: null,
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
    context: {},
    stepRuns: [],
    ...overrides,
  }
}

function observationOf(run: RunDetailDto, eventSeq: number): RunObservation {
  return {
    run,
    evidence: { items: [] },
    eventSeq,
    earliestEventSeq: eventSeq > 0 ? 1 : 0,
  }
}

type StreamInput = {
  signal: AbortSignal
  handlers: {
    onEvent?: () => void
    onControl?: (control: {
      kind: string
      realtime?: boolean
      code?: string
    }) => void
  }
}

function captureSubscribe() {
  let handlers: StreamInput['handlers'] | undefined
  mocks.subscribeRunEvents.mockImplementation(async (id: string, input: StreamInput) => {
    handlers = input.handlers
    input.handlers.onControl?.({
      kind: 'ready',
      realtime: true,
    })
    await new Promise<void>((resolve) => {
      if (input.signal.aborted) {
        resolve()
        return
      }
      input.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  return {
    emitEvent() {
      handlers?.onEvent?.()
    },
    emitControl(control: { kind: string; realtime?: boolean; code?: string }) {
      handlers?.onControl?.(control)
    },
  }
}

function Probe() {
  const obs = useRunObservation(RUN_ID)
  return (
    <div>
      <span>{obs.run?.status ?? 'none'}</span>
      <span>{obs.eventSeq}</span>
      <span>{connectionLabel(obs.connection)}</span>
      <button type='button' onClick={() => void obs.refresh()}>
        刷新
      </button>
    </div>
  )
}

async function renderHook(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const screen = await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  return { screen, client }
}

describe('useRunObservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试',
      email: null,
      roles: [],
      permissions: ['run:read'],
    })
    useAuthStore.getState().auth.setAccessToken('token-a')
    mocks.fetchRunObservation.mockResolvedValue(observationOf(runDetail({ status: 'RUNNING' }), 5))
    captureSubscribe()
  })

  afterEach(() => {
    useAuthStore.getState().auth.reset()
  })

  it('较慢的旧观察不能覆盖已应用版本，也不改草稿缓存', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['scenarios', RUN_ID, 'draft'], { name: 'keep-draft' })
    mocks.fetchRunObservation
      .mockResolvedValueOnce(observationOf(runDetail({ status: 'RUNNING' }), 5))
      .mockResolvedValueOnce(observationOf(runDetail({ status: 'QUEUED' }), 2))
    const { screen } = await renderHook(client)
    await expect.element(screen.getByText('RUNNING')).toBeInTheDocument()
    await expect.element(screen.getByText('5')).toBeInTheDocument()
    await screen.getByRole('button', { name: '刷新' }).click()
    await vi.waitFor(() => expect(mocks.fetchRunObservation).toHaveBeenCalledTimes(2))
    await expect.element(screen.getByText('RUNNING')).toBeInTheDocument()
    await expect.element(screen.getByText('5')).toBeInTheDocument()
    expect(client.getQueryData(['scenarios', RUN_ID, 'draft'])).toEqual({ name: 'keep-draft' })
    expect(client.getQueryData(['runs', RUN_ID])).toMatchObject({ status: 'RUNNING' })
  })

  it('连续事件合并为有限次观察 GET', async () => {
    let calls = 0
    mocks.fetchRunObservation.mockImplementation(async () => {
      calls += 1
      if (calls > 1) await new Promise((resolve) => setTimeout(resolve, 40))
      return observationOf(runDetail({ status: 'RUNNING' }), 5)
    })
    const stream = captureSubscribe()
    const { screen } = await renderHook()
    await expect.element(screen.getByText('连接正常')).toBeInTheDocument()
    const afterReady = calls
    for (let i = 0; i < 5; i += 1) stream.emitEvent()
    await vi.waitFor(() => expect(calls).toBeGreaterThan(afterReady))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(calls - afterReady).toBeLessThanOrEqual(2)
  })

  it('complete 后停止重连', async () => {
    const stream = captureSubscribe()
    const { screen } = await renderHook()
    await expect.element(screen.getByText('连接正常')).toBeInTheDocument()
    stream.emitControl({ kind: 'complete' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mocks.subscribeRunEvents).toHaveBeenCalledTimes(1)
  })

  it('旧流 401 不得清新登录 token', async () => {
    mocks.subscribeRunEvents.mockImplementation(async () => {
      useAuthStore.getState().auth.setAccessToken('token-b')
      throw new ApiRequestError(401, {
        code: 'UNAUTHORIZED',
        message: '未认证',
        requestId: 'req-1',
      })
    })
    const { screen } = await renderHook()
    await expect.element(screen.getByText('RUNNING')).toBeInTheDocument()
    await vi.waitFor(() => expect(mocks.subscribeRunEvents).toHaveBeenCalled())
    expect(useAuthStore.getState().auth.accessToken).toBe('token-b')
    expect(useAuthStore.getState().auth.user?.id).toBe('u1')
  })

  it('实时未配置显示辅助灰标，不是 Run 失败', async () => {
    mocks.subscribeRunEvents.mockImplementation(async (id: string, input: StreamInput) => {
      input.handlers.onControl?.({ kind: 'ready', realtime: false })
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    const { screen } = await renderHook()
    await expect.element(screen.getByText('实时未配置')).toBeInTheDocument()
    await expect.element(screen.getByText('RUNNING')).toBeInTheDocument()
  })
})
