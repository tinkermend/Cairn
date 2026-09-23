import '@/styles/index.css'
import type { RunDetailDto } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { MiniRunTracker } from './mini-run-tracker'

const { navigate, mockLocation, cancelRunMock, mockRunObservation } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  mockLocation: { pathname: '/scenarios/sc-1' },
  cancelRunMock: vi.fn(async () => ({ id: 'run-1', status: 'CANCELLED' })),
  mockRunObservation: {
    run: null as Partial<RunDetailDto> | null,
    view: null as { run: Partial<RunDetailDto> } | null,
    isStreaming: false,
    error: null,
  },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({ location: mockLocation }),
  }
})

vi.mock('@/lib/runs-api', () => ({
  cancelRun: cancelRunMock,
}))

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: () => mockRunObservation,
}))

describe('MiniRunTracker 微型运行监控坞', () => {
  const RUN_ID = '11111111-1111-4111-8111-111111111111'

  beforeEach(() => {
    navigate.mockReset()
    cancelRunMock.mockReset()
    mockLocation.pathname = '/scenarios/sc-1'
    useAssistantStore.setState({
      trackedRunId: null,
    })
    useAuthStore.getState().auth.setUser({
      id: 'u-1',
      displayName: '测试用户',
      email: null,
      roles: [],
      permissions: ['run:read', 'run:cancel'],
    })
    const runData = {
      id: RUN_ID,
      status: 'RUNNING',
      stepRuns: [
        {
          id: 'sr-1',
          runId: RUN_ID,
          stepId: 'step-1',
          name: '打开页面',
          status: 'SUCCEEDED',
          startedAt: '2026-09-23T00:00:00.000Z',
          finishedAt: '2026-09-23T00:00:01.200Z',
          attemptCount: 1,
          retryCount: 0,
          error: null,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:01.200Z',
        },
        {
          id: 'sr-2',
          runId: RUN_ID,
          stepId: 'step-2',
          name: '点击登录',
          status: 'RUNNING',
          startedAt: '2026-09-23T00:00:01.200Z',
          finishedAt: null,
          attemptCount: 1,
          retryCount: 0,
          error: null,
          createdAt: '2026-09-23T00:00:01.200Z',
          updatedAt: '2026-09-23T00:00:01.200Z',
        },
      ],
    } as unknown as Partial<RunDetailDto>

    mockRunObservation.run = runData
    mockRunObservation.view = { run: runData }
  })

  afterEach(() => {
    useAssistantStore.setState({ trackedRunId: null })
  })

  it('没有 trackedRunId 时静默隐退，不渲染任何节点', async () => {
    useAssistantStore.setState({ trackedRunId: null })
    const screen = await render(<MiniRunTracker />)
    expect(screen.container.firstChild).toBeNull()
  })

  it('路由位于 /runs/:runId 当前运行页时自动隐退防冗余', async () => {
    useAssistantStore.setState({ trackedRunId: RUN_ID })
    mockLocation.pathname = `/runs/${RUN_ID}`

    const screen = await render(<MiniRunTracker />)
    expect(screen.container.firstChild).toBeNull()
  })

  it('在其它页面展示运行状态、步骤列表与跳转按钮', async () => {
    useAssistantStore.setState({ trackedRunId: RUN_ID })
    mockLocation.pathname = '/scenarios/sc-1'

    const screen = await render(<MiniRunTracker />)
    await expect.element(screen.getByTestId('mini-run-tracker')).toBeInTheDocument()
    await expect.element(screen.getByText(/运行监控 · 11111111…/)).toBeInTheDocument()
    await expect.element(screen.getByText('打开页面')).toBeInTheDocument()
    await expect.element(screen.getByText('点击登录')).toBeInTheDocument()
    await expect.element(screen.getByText('1.2s')).toBeInTheDocument()

    // 点击前往完整复盘页
    const jumpBtn = screen.getByRole('button', { name: /前往完整复盘页/ })
    await jumpBtn.click()
    expect(navigate).toHaveBeenCalledWith({
      to: '/runs/$runId',
      params: { runId: RUN_ID },
    })

    // 点击关闭按钮清理跟踪
    const closeBtn = screen.getByRole('button', { name: '关闭运行监控坞' })
    await closeBtn.click()
    expect(useAssistantStore.getState().trackedRunId).toBeNull()
  })

  it('具备 run:cancel 权限且运行中时展示中止运行按钮并支持触发终止', async () => {
    useAssistantStore.setState({ trackedRunId: RUN_ID })

    const screen = await render(<MiniRunTracker />)
    const cancelBtn = screen.getByRole('button', { name: /中止运行/ })
    await expect.element(cancelBtn).toBeInTheDocument()

    await cancelBtn.click()
    expect(cancelRunMock).toHaveBeenCalledWith(RUN_ID)
  })

  it('缺少 run:cancel 权限或运行已结束时不显示中止运行按钮', async () => {
    // 缺少权限
    useAuthStore.getState().auth.setUser({
      id: 'u-1',
      displayName: '只读用户',
      email: null,
      roles: [],
      permissions: ['run:read'],
    })
    useAssistantStore.setState({ trackedRunId: RUN_ID })

    const screen1 = await render(<MiniRunTracker />)
    await expect.element(screen1.getByRole('button', { name: /中止运行/ })).not.toBeInTheDocument()

    // 具备权限但已处于终态
    useAuthStore.getState().auth.setUser({
      id: 'u-1',
      displayName: '测试用户',
      email: null,
      roles: [],
      permissions: ['run:read', 'run:cancel'],
    })
    const finishedRun = {
      id: RUN_ID,
      status: 'SUCCEEDED',
      stepRuns: [],
    } as unknown as Partial<RunDetailDto>
    mockRunObservation.run = finishedRun
    mockRunObservation.view = {
      run: finishedRun,
    }

    const screen2 = await render(<MiniRunTracker />)
    await expect.element(screen2.getByRole('button', { name: /中止运行/ })).not.toBeInTheDocument()
  })
})
