import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunDetailDto, TargetObservation } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  AuthoringObserveProvider,
  computeScreenAlignment,
  useAuthoringObserve,
} from './observe'

const RUN_ID = '77777777-7777-4777-8777-777777777777'
const STEP_ID = '55555555-5555-4555-8555-555555555555'

const observeRun = vi.fn()
const observeSession = vi.fn()
const refresh = vi.fn()
const onApplyTarget = vi.fn()
const onWriteBack = vi.fn(async () => true)

vi.mock('@/lib/runs-api', () => ({
  observeRun: (...args: unknown[]) => observeRun(...args),
}))

vi.mock('@/lib/sessions-api', () => ({
  observeSession: (...args: unknown[]) => observeSession(...args),
}))

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: (id: string) => ({
    run: id
      ? ({
          id: RUN_ID,
          status: 'HOLDING',
          debugMode: 'holdOnFailure',
          checkpoint: { stepId: STEP_ID, fencingToken: '1' },
          debugOverlay: null,
        } as Pick<
          RunDetailDto,
          'id' | 'status' | 'debugMode' | 'checkpoint' | 'debugOverlay'
        >)
      : null,
    refresh,
  }),
}))

const found: TargetObservation = {
  outcome: 'FOUND',
  target: { framePath: [], candidates: [{ by: 'testId', value: 'go' }] },
  page: { url: 'https://shop.example/orders' },
  diagnostics: {
    outcome: 'FOUND',
    candidatesTried: [{ index: 0, by: 'testId', value: 'go', matches: 1 }],
  },
  source: 'managed',
}

function Probe() {
  const observe = useAuthoringObserve()
  return (
    <div>
      <button type='button' onClick={() => observe.pickAt(12, 34)}>
        点选
      </button>
      <button type='button' onClick={() => observe.applyForTrial()}>
        本次验证
      </button>
      <button type='button' onClick={() => observe.writeBack()}>
        写回草稿
      </button>
      <p>{observe.lastPicked ? '已点到' : '未点到'}</p>
    </div>
  )
}

describe('AuthoringObserveProvider', () => {
  beforeEach(() => {
    observeRun.mockReset()
    observeSession.mockReset()
    refresh.mockReset()
    onApplyTarget.mockReset()
    onWriteBack.mockReset()
    onWriteBack.mockResolvedValue(true)
    observeRun.mockResolvedValue(found)
  })

  it('指认只产生观察；本次验证才写覆盖；写回草稿才改本地目标', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          runId={RUN_ID}
          selectedStepId={STEP_ID}
          enabled
          onApplyTarget={onApplyTarget}
          onWriteBack={onWriteBack}
        >
          <Probe />
        </AuthoringObserveProvider>
      </QueryClientProvider>
    )
    await screen.getByRole('button', { name: '点选' }).click()
    await vi.waitFor(() =>
      expect(observeRun).toHaveBeenCalledWith(RUN_ID, {
        op: 'pick',
        x: 12,
        y: 34,
      })
    )
    expect(onApplyTarget).not.toHaveBeenCalled()
    await expect.element(screen.getByText('已点到')).toBeInTheDocument()

    await screen.getByRole('button', { name: '本次验证' }).click()
    await vi.waitFor(() =>
      expect(observeRun).toHaveBeenCalledWith(RUN_ID, {
        op: 'highlight',
        target: found.target,
        applyOverlay: true,
      })
    )
    expect(onApplyTarget).not.toHaveBeenCalled()

    await screen.getByRole('button', { name: '写回草稿' }).click()
    await vi.waitFor(() =>
      expect(onApplyTarget).toHaveBeenCalledWith(found.target, { previewText: '' })
    )
    expect(onWriteBack).toHaveBeenCalled()
  })

  it('会话实时画面可指认，不走试跑 observe', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    observeSession.mockResolvedValue(found)
    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          sessionId={RUN_ID}
          selectedStepId={STEP_ID}
          enabled
          authoring={{
            indicate: 'open',
            highlight: 'open',
            debugHold: 'open',
            assist: 'closed',
            stepTypesExtra: [],
          }}
          onApplyTarget={onApplyTarget}
          onWriteBack={onWriteBack}
        >
          <Probe />
        </AuthoringObserveProvider>
      </QueryClientProvider>
    )
    await screen.getByRole('button', { name: '点选' }).click()
    await vi.waitFor(() =>
      expect(observeSession).toHaveBeenCalledWith(RUN_ID, {
        op: 'pick',
        x: 12,
        y: 34,
      })
    )
    expect(observeRun).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onApplyTarget).toHaveBeenCalledWith(found.target, { previewText: '' }))
    await vi.waitFor(() =>
      expect(observeSession).toHaveBeenCalledWith(RUN_ID, {
        op: 'highlight',
        target: found.target,
      }),
    )
  })

  it('拾取返回 disambiguation 时弹出消歧对话框并支持采用可见文本', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const disambiguated: TargetObservation = {
      outcome: 'FOUND',
      target: {
        framePath: [],
        candidates: [
          { by: 'title', value: 'SubmitBtn' },
          { by: 'text', value: '提交订单' },
        ],
      },
      disambiguation: {
        visibleText: '提交订单',
        accessibleName: 'SubmitBtn',
        recommended: 'visible_text',
      },
      page: { url: 'https://shop.example/checkout' },
      diagnostics: {
        outcome: 'FOUND',
        candidatesTried: [{ index: 0, by: 'title', value: 'SubmitBtn', matches: 1 }],
      },
      source: 'managed',
    }
    observeSession.mockResolvedValue(disambiguated)

    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          sessionId={RUN_ID}
          selectedStepId={STEP_ID}
          enabled
          onApplyTarget={onApplyTarget}
          onWriteBack={onWriteBack}
        >
          <Probe />
        </AuthoringObserveProvider>
      </QueryClientProvider>
    )

    await screen.getByRole('button', { name: '点选' }).click()
    await expect.element(screen.getByText('请确认目标语义')).toBeInTheDocument()
    await expect.element(screen.getByText(/检测到该元素页面上显示的文本与底层无障碍名称存在差异/)).toBeInTheDocument()

    const confirmBtn = screen.getByRole('button', { name: '确认采用' })
    await expect.element(confirmBtn).toBeInTheDocument()
    await confirmBtn.click()

    await vi.waitFor(() => {
      expect(onApplyTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          candidates: expect.arrayContaining([{ by: 'text', value: '提交订单' }]),
        }),
        expect.anything()
      )
    })
  })
})

describe('computeScreenAlignment', () => {
  const stepOrder = ['step-1', 'step-2', 'step-3', 'step-4']

  it('未选择步骤或步骤不在列表中时返回 disconnected', () => {
    expect(computeScreenAlignment({ sessionOpen: true, stepOrder })).toBe('disconnected')
    expect(computeScreenAlignment({ sessionOpen: true, selectedStepId: 'unknown', stepOrder })).toBe('disconnected')
  })

  it('无活跃 Run 时根据会话及历史截图判定', () => {
    // 纯受管会话打开
    expect(
      computeScreenAlignment({
        sessionOpen: true,
        selectedStepId: 'step-1',
        stepOrder,
      })
    ).toBe('aligned')

    expect(
      computeScreenAlignment({
        sessionOpen: true,
        selectedStepId: 'step-3',
        stepOrder,
      })
    ).toBe('session_initial')

    // 会话未连接但有离线截图
    expect(
      computeScreenAlignment({
        sessionOpen: false,
        selectedStepId: 'step-2',
        stepOrder,
        hasOfflineScreenshot: true,
      })
    ).toBe('offline_snapshot')

    // 会话未连接且无截图
    expect(
      computeScreenAlignment({
        sessionOpen: false,
        selectedStepId: 'step-2',
        stepOrder,
        hasOfflineScreenshot: false,
      })
    ).toBe('disconnected')
  })

  it('活跃 Run 在 HOLDING 状态下根据 reason 精确判断对齐与步进', () => {
    // author_pause: 暂停在 step-3 前置
    expect(
      computeScreenAlignment({
        sessionOpen: true,
        liveRun: {
          status: 'HOLDING',
          checkpoint: { stepId: 'step-3', reason: 'author_pause' },
          stepRuns: [],
        },
        selectedStepId: 'step-3',
        stepOrder,
      })
    ).toBe('aligned')

    expect(
      computeScreenAlignment({
        sessionOpen: true,
        liveRun: {
          status: 'HOLDING',
          checkpoint: { stepId: 'step-2', reason: 'author_pause' },
          stepRuns: [],
        },
        selectedStepId: 'step-3',
        stepOrder,
      })
    ).toBe('behind')

    expect(
      computeScreenAlignment({
        sessionOpen: true,
        liveRun: {
          status: 'HOLDING',
          checkpoint: { stepId: 'step-3', reason: 'author_pause' },
          stepRuns: [],
        },
        selectedStepId: 'step-1',
        stepOrder,
      })
    ).toBe('ahead')

    // step_succeeded: step-2 成功挂起，对齐到 step-3 (chkIdx + 1)
    expect(
      computeScreenAlignment({
        sessionOpen: true,
        liveRun: {
          status: 'HOLDING',
          checkpoint: { stepId: 'step-2', reason: 'step_succeeded' },
          stepRuns: [],
        },
        selectedStepId: 'step-3',
        stepOrder,
      })
    ).toBe('aligned')

    expect(
      computeScreenAlignment({
        sessionOpen: true,
        liveRun: {
          status: 'HOLDING',
          checkpoint: { stepId: 'step-2', reason: 'step_succeeded' },
          stepRuns: [],
        },
        selectedStepId: 'step-4',
        stepOrder,
      })
    ).toBe('behind')
  })
})
