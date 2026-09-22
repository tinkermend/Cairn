import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunDetailDto, TargetObservation } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AuthoringObserveProvider, useAuthoringObserve } from './observe'

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
})
