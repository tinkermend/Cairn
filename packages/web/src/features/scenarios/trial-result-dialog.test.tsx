import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunDetailDto } from '@cairn/shared'
import '@/styles/index.css'
import { TrialResultDialog } from './trial-result-dialog'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, ...props }: any) => (
    <a href='#' className={className} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: any) =>
    selector({
      auth: {
        user: {
          id: 'u-1',
          name: 'Tester',
          roles: ['operator'],
          permissions: ['run:read', 'run:execute'],
        },
      },
    }),
}))

const mockSuccessRun: RunDetailDto = {
  id: 'run-success-123',
  scenarioId: 'sc-1',
  scenarioVersionId: 'v-1',
  scenarioVersionKind: 'trial',
  targetId: 't-1',
  status: 'SUCCEEDED',
  outcomeStatus: 'PASSED',
  evidenceStatus: 'VERIFIED',
  startedAt: '2026-09-28T00:00:00Z',
  finishedAt: '2026-09-28T00:01:00Z',
  placement: { runnerHost: 'worker-1' },
  snapshot: {
    steps: [
      { id: 'step-1', name: '打开登录页', type: 'NAVIGATE' },
      { id: 'step-2', name: '输入用户名密码', type: 'FILL' },
    ],
  },
  stepRuns: [
    {
      id: 'sr-1',
      runId: 'run-success-123',
      stepId: 'step-1',
      status: 'SUCCEEDED',
      attempts: [
        {
          id: 'att-1',
          attemptNo: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-28T00:00:01Z',
          finishedAt: '2026-09-28T00:00:10Z',
        },
      ],
    },
    {
      id: 'sr-2',
      runId: 'run-success-123',
      stepId: 'step-2',
      status: 'SUCCEEDED',
      attempts: [
        {
          id: 'att-2',
          attemptNo: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-28T00:00:11Z',
          finishedAt: '2026-09-28T00:00:25Z',
        },
      ],
    },
  ],
} as unknown as RunDetailDto

const mockFailedRun: RunDetailDto = {
  id: 'run-failed-456',
  scenarioId: 'sc-1',
  scenarioVersionId: 'v-1',
  scenarioVersionKind: 'trial',
  targetId: 't-1',
  status: 'FAILED',
  outcomeStatus: 'FAILED',
  evidenceStatus: 'INCOMPLETE',
  startedAt: '2026-09-28T00:00:00Z',
  finishedAt: '2026-09-28T00:00:30Z',
  placement: { runnerHost: 'worker-1' },
  snapshot: {
    steps: [
      { id: 'step-1', name: '打开登录页', type: 'NAVIGATE' },
      { id: 'step-2', name: '点击提交按钮', type: 'CLICK' },
    ],
  },
  stepRuns: [
    {
      id: 'sr-1',
      runId: 'run-failed-456',
      stepId: 'step-1',
      status: 'SUCCEEDED',
      attempts: [
        {
          id: 'att-1',
          attemptNo: 1,
          status: 'SUCCEEDED',
          startedAt: '2026-09-28T00:00:01Z',
          finishedAt: '2026-09-28T00:00:10Z',
        },
      ],
    },
    {
      id: 'sr-2',
      runId: 'run-failed-456',
      stepId: 'step-2',
      status: 'FAILED',
      attempts: [
        {
          id: 'att-2',
          attemptNo: 1,
          status: 'FAILED',
          startedAt: '2026-09-28T00:00:11Z',
          finishedAt: '2026-09-28T00:00:30Z',
          error: {
            code: 'ELEMENT_TIMEOUT',
            safeMessage: '等待元素超时，未能找到提交按钮',
          },
        },
      ],
    },
  ],
} as unknown as RunDetailDto

let currentRunMock: RunDetailDto = mockSuccessRun

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: () => ({
    run: currentRunMock,
    evidence: { items: [] },
    connection: 'connected',
    query: { dataUpdatedAt: Date.now(), isError: false },
    refresh: vi.fn(),
  }),
  connectionLabel: () => '已连接',
  connectionTone: () => 'success',
}))

async function renderDialog(props: Partial<React.ComponentProps<typeof TrialResultDialog>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return await render(
    <QueryClientProvider client={queryClient}>
      <TrialResultDialog
        open={true}
        onOpenChange={vi.fn()}
        runId='run-success-123'
        scenarioId='sc-1'
        selectedDraftStepId='step-1'
        onSelectDraftStep={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  )
}

describe('TrialResultDialog', () => {
  it('正确渲染试跑结果弹窗及成功状态', async () => {
    currentRunMock = mockSuccessRun
    const screen = await renderDialog()

    await expect.element(screen.getByRole('dialog')).toBeVisible()
    await expect.element(screen.getByText('试跑结果')).toBeVisible()
    await expect.element(screen.getByText('执行完成')).toBeVisible()
  })

  it('试跑失败时提供一键定位失败步骤按钮，点击后聚焦并关闭弹窗', async () => {
    currentRunMock = mockFailedRun
    const onFocusFailedStep = vi.fn()
    const onOpenChange = vi.fn()

    const screen = await renderDialog({
      runId: 'run-failed-456',
      onFocusFailedStep,
      onOpenChange,
    })

    const locateBtn = screen.getByRole('button', { name: /定位到失败步骤：点击提交按钮/i })
    await expect.element(locateBtn).toBeVisible()

    await locateBtn.click()
    expect(onFocusFailedStep).toHaveBeenCalledWith('step-2')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('点击底部关闭按钮可以关闭弹窗', async () => {
    currentRunMock = mockSuccessRun
    const onOpenChange = vi.fn()
    const screen = await renderDialog({ onOpenChange })

    const closeBtn = screen.getByRole('button', { name: '关闭' }).first()
    await closeBtn.click()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
