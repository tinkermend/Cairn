import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { runPlacement, type RunDetailDto } from '@cairn/shared'
import { ContextBindingPopover } from './context-binding-popover'

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
        name: '读单号',
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'orderInfo',
        input: {
          target: {
            framePath: [],
            semantic: '订单信息',
            candidates: [{ by: 'css', value: '#order-info' }],
          },
          as: 'text',
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
      name: '读单号',
      type: 'extract',
      ordinal: 0,
      status: 'SUCCEEDED',
      outcomeStatus: 'NOT_EVALUATED',
      startedAt: '2026-09-21T00:00:01.000Z',
      finishedAt: '2026-09-21T00:00:02.000Z',
      attempts: [
        {
          id: 'at-1',
          attemptNo: 1,
          status: 'SUCCEEDED',
          output: { orderId: 'ORD-123', total: 99.9 },
          error: null,
          startedAt: '2026-09-21T00:00:01.000Z',
          finishedAt: '2026-09-21T00:00:02.000Z',
        },
      ],
    },
  ],
}

const mockBindings = [
  { key: 'orderInfo', label: '读单号 (orderInfo)' },
]

describe('ContextBindingPopover Component', () => {
  it('渲染点选绑定按钮并可在打开后看到可用变量与真实产出', async () => {
    const screen = await render(
      <ContextBindingPopover
        bindings={mockBindings}
        run={mockRun}
        onBind={vi.fn()}
      />,
    )

    const openButton = screen.getByRole('button', { name: '从前序步骤产出中选择' })
    await expect.element(openButton).toBeInTheDocument()
    await openButton.click()

    await expect.element(page.getByText('引用数据产出')).toBeInTheDocument()
    await expect.element(page.getByText('运行时的实际产出')).toBeInTheDocument()
    await expect.element(page.getByText('orderId')).toBeInTheDocument()
    await expect.element(page.getByText('ORD-123')).toBeInTheDocument()
  })

  it('点击字段直接触发 onBind 回调', async () => {
    const onBind = vi.fn()
    const screen = await render(
      <ContextBindingPopover
        bindings={mockBindings}
        run={mockRun}
        onBind={onBind}
      />,
    )

    await screen.getByRole('button', { name: '从前序步骤产出中选择' }).click()
    const fieldBtn = page.getByRole('button', { name: /orderId/ })
    await fieldBtn.click()

    expect(onBind).toHaveBeenCalledWith({
      from: 'orderInfo',
      fromField: 'orderId',
      sourceStepId: 'step-1',
    })
  })
})
