import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { runPlacement, type RunDetailDto } from '@cairn/shared'
import { HealingCard } from './healing-card'

const debugRunMock = vi.fn()
vi.mock('@/lib/runs-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runs-api')>()),
  debugRun: (...args: unknown[]) => debugRunMock(...args),
}))

const mockRun: RunDetailDto = {
  executionOrigin: 'standalone',
  id: 'run-1',
  status: 'HOLDING',
  cancelRequested: false,
  targetId: 't-1',
  targetName: '测试目标',
  targetAccountId: null,
  targetAccountName: null,
  scenarioId: 'sc-1',
  scenarioName: '测试场景',
  scenarioVersionId: 'v-1',
  scenarioVersionKind: 'trial',
  createdAt: '2026-09-21T00:00:00.000Z',
  startedAt: '2026-09-21T00:00:01.000Z',
  finishedAt: null,
  evidenceStatus: 'PENDING',
  outcomeStatus: 'NOT_EVALUATED',
  lease: null,
  debugMode: 'holdOnFailure',
  checkpoint: {
    mode: 'holdOnFailure',
    reason: 'step_failed',
    stepId: 'step-1',
    stepOrdinal: 0,
    contextKeys: [],
    sessionGeneration: 1,
    fencingToken: 'fence-1',
    overlayRevision: 0,
  },
  outcomeResults: [],
  placement: runPlacement({
    state: 'not_applicable',
    sessionId: null,
    ownerWorkerId: null,
    sessionStatus: null,
  }),
  snapshot: {
    schemaVersion: 1,
    runId: 'run-1',
    targetId: 't-1',
    scenarioId: 'sc-1',
    scenarioVersionId: 'v-1',
    steps: [
      {
        id: 'step-1',
        name: '点击提交',
        type: 'click',
        effectType: 'READ_ONLY',
        input: {
          target: {
            framePath: [],
            semantic: '提交按钮',
            candidates: [{ by: 'role', value: 'button', name: '提交' }],
          },
        },
      },
    ],
    input: {},
    createdAt: '2026-09-21T00:00:00.000Z',
  },
  context: {},
  stepRuns: [
    {
      id: 'sr-1',
      stepId: 'step-1',
      name: '点击提交',
      type: 'click',
      ordinal: 0,
      status: 'FAILED',
      outcomeStatus: 'NOT_EVALUATED',
      startedAt: '2026-09-21T00:00:01.000Z',
      finishedAt: '2026-09-21T00:00:05.000Z',
      attempts: [
        {
          id: 'at-1',
          attemptNo: 1,
          status: 'FAILED',
          output: null,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: '找不到元素: role=button, name=提交',
          },
          startedAt: '2026-09-21T00:00:01.000Z',
          finishedAt: '2026-09-21T00:00:05.000Z',
        },
      ],
    },
  ],
}

describe('HealingCard Component', () => {
  it('在非 HOLDING/RUNNING 调试态时不渲染', async () => {
    const finishedRun: RunDetailDto = {
      ...mockRun,
      status: 'SUCCEEDED',
    }
    const screen = await render(<HealingCard run={finishedRun} />)
    await expect.element(screen.getByText('第 1 步执行失败')).not.toBeInTheDocument()
  })

  it('在 HOLDING 状态下展示失败诊断与就地再试按钮', async () => {
    const screen = await render(<HealingCard run={mockRun} />)
    await expect.element(screen.getByText('第 1 步执行失败')).toBeInTheDocument()
    await expect.element(screen.getByText('这一页上找不到要点的对象')).toBeInTheDocument()
    await screen.getByRole('button', { name: '详细原因' }).click()
    await expect.element(screen.getByText(/ELEMENT_NOT_FOUND/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '再试这一步' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '结束会话' })).toBeInTheDocument()
  })

  it('点击再试本步触发 retry_current 操作', async () => {
    debugRunMock.mockResolvedValueOnce(mockRun)
    const onChanged = vi.fn()
    const screen = await render(<HealingCard run={mockRun} onChanged={onChanged} />)
    const retryBtn = screen.getByRole('button', { name: '再试这一步' })
    await retryBtn.click()
    expect(debugRunMock).toHaveBeenCalledWith('run-1', {
      action: 'retry_current',
      targetOverride: undefined,
      fencingToken: 'fence-1',
      confirmSideEffect: undefined,
    })
  })

  it('点击再试本步时支持先保存草稿并携带 stepOverride', async () => {
    debugRunMock.mockResolvedValueOnce(mockRun)
    const onBeforeRetry = vi.fn().mockResolvedValue(true)
    const currentStep = { ...mockRun.snapshot.steps[0]!, name: '修改后的步骤名称' }
    const screen = await render(
      <HealingCard run={mockRun} currentStep={currentStep} onBeforeRetry={onBeforeRetry} />,
    )
    const retryBtn = screen.getByRole('button', { name: '再试这一步' })
    await retryBtn.click()
    expect(onBeforeRetry).toHaveBeenCalledTimes(1)
    expect(debugRunMock).toHaveBeenCalledWith('run-1', {
      action: 'retry_current',
      targetOverride: undefined,
      fencingToken: 'fence-1',
      confirmSideEffect: undefined,
      stepOverride: currentStep,
    })
  })

  it('在成功或暂停态时展示继续后续步骤按钮', async () => {
    const succeededRun: RunDetailDto = {
      ...mockRun,
      stepRuns: [
        {
          ...mockRun.stepRuns[0]!,
          status: 'SUCCEEDED',
        },
      ],
    }
    const screen = await render(<HealingCard run={succeededRun} />)
    await expect.element(screen.getByText('当前步骤已通过验证')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '继续后续步骤' })).toBeInTheDocument()
  })

  it('checkpoint 缺失时不假装第一步失败', async () => {
    const unresolved: RunDetailDto = {
      ...mockRun,
      checkpoint: null,
    }
    const screen = await render(<HealingCard run={unresolved} />)
    await expect.element(screen.getByText('挂起的步骤无法确定')).toBeInTheDocument()
    await expect.element(screen.getByText('第 1 步执行失败')).not.toBeInTheDocument()
  })
})
