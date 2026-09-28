import { describe, expect, it, vi } from 'vitest'
import { resolveEvidencePolicy, type RunGrant, type RunSnapshot, type ScreenshotPointer, type SessionGrant, type Step } from '@cairn/shared'
import { BrowserStepExecutor } from './browser-executor.js'
import type { AiPort, BrowserPort } from './ports.js'
import type { StepExecutionContext } from './step-executor.js'

const appendResolutionDecision = vi.hoisted(() => vi.fn())

vi.mock('@cairn/db', () => ({
  appendResolutionDecision: (...args: unknown[]) => appendResolutionDecision(...args),
  newId: () => '00000000-0000-4000-8000-000000000099',
}))

const STEP_ID = '00000000-0000-4000-8000-0000000000c1'
const RUN_ID = '00000000-0000-4000-8000-0000000000a1'
const STEP_RUN_ID = '00000000-0000-4000-8000-0000000000b1'
const ATTEMPT_ID = '00000000-0000-4000-8000-0000000000d1'

function clickStep(): Step {
  return {
    id: STEP_ID,
    name: '点击',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'text', value: '查询' }] },
    },
  } as Step
}

function grant(): RunGrant {
  return {
    runId: RUN_ID,
    leaseId: '00000000-0000-4000-8000-0000000000e1',
    fencingToken: 1,
    holderWorkerId: 'w1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function sessionGrant(): SessionGrant {
  return {
    leaseId: '00000000-0000-4000-8000-0000000000e2',
    sessionId: '00000000-0000-4000-8000-0000000000e3',
    fencingToken: 1,
    holderWorkerId: 'w1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

function ctxFor(step: Step, policy: 'deterministic_only' | 'ai_only', signal = new AbortController().signal): StepExecutionContext {
  return {
    runId: RUN_ID,
    stepRunId: STEP_RUN_ID,
    attemptId: ATTEMPT_ID,
    targetId: '00000000-0000-4000-8000-0000000000f1',
    step,
    input: {},
    context: {},
    signal,
    clock: { now: () => Date.now() },
    sessionGrant: sessionGrant(),
    evidencePolicy: resolveEvidencePolicy(),
    grant: grant(),
    snapshot: {
      resolution: {
        protocol: 'snapshot.resolution@1',
        ceiling: policy,
        scenarioDefault: policy,
        steps: { [step.id]: policy },
      },
      aiExecution: {
        modelName: 'demo',
        modelFamily: 'openai',
        modelBaseUrl: 'https://model.example/v1',
        secretRef: { secretId: '00000000-0000-4000-8000-000000000099' },
        configVersion: '1',
        requestTimeoutMs: 15_000,
        maxCalls: 4,
        maxOutputTokens: 1024,
        hangWaitMs: 20_000,
      },
    } as StepExecutionContext['snapshot'],
  } as StepExecutionContext
}

describe('BrowserStepExecutor - 失败兜底截图', () => {
  it('仅文本模型档定位未命中：解析梯全程未执行任何浏览器命令，补一张 on_error 兜底现场', async () => {
    const locate = vi.fn(async () => ({
      ok: false as const,
      route: 'text' as const,
      outcomeClass: 'miss' as const,
      callNs: [1],
      error: { code: 'AI_NOT_FOUND' as const, category: 'EXECUTOR' as const, retryable: true, safeMessage: '文本模型未找到目标' },
    }))
    appendResolutionDecision.mockImplementation(async (_handle: unknown, input: { decision: unknown }) => input.decision)
    const execute = vi.fn()
    const pointer: ScreenshotPointer = { objectKey: 'obj-on-error', contentType: 'image/png', byteSize: 10, digest: 'x' }
    const captureFailureScreenshot = vi.fn(async () => pointer)
    const browser: BrowserPort = {
      execute,
      captureFailureScreenshot,
    } as unknown as BrowserPort
    const ai: AiPort = { locate } as unknown as AiPort

    const executor = new BrowserStepExecutor({} as never, browser, ai)
    const outcome = await executor.execute(ctxFor(clickStep(), 'ai_only'))

    expect(execute).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('failed')
    expect(captureFailureScreenshot).toHaveBeenCalledTimes(1)
    expect(captureFailureScreenshot.mock.calls[0]?.[1]).toMatchObject({ runId: RUN_ID, stepRunId: STEP_RUN_ID, attemptId: ATTEMPT_ID })
    if (outcome.kind === 'failed') expect(outcome.screenshot).toEqual(pointer)
  })

  it('确定性档已经有失败截图时不再补拍', async () => {
    const existing: ScreenshotPointer = { objectKey: 'obj-existing', contentType: 'image/png', byteSize: 5, digest: 'y' }
    appendResolutionDecision.mockImplementation(async (_handle: unknown, input: { decision: unknown }) => input.decision)
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'TARGET_NOT_FOUND' as const, category: 'EXECUTOR' as const, retryable: false, safeMessage: '未找到' },
      screenshot: existing,
    }))
    const captureFailureScreenshot = vi.fn(async () => ({ objectKey: 'should-not-be-used' }) as ScreenshotPointer)
    const browser: BrowserPort = { execute, captureFailureScreenshot } as unknown as BrowserPort

    const executor = new BrowserStepExecutor({} as never, browser)
    const outcome = await executor.execute(ctxFor(clickStep(), 'deterministic_only'))

    expect(outcome.kind).toBe('failed')
    expect(captureFailureScreenshot).not.toHaveBeenCalled()
    if (outcome.kind === 'failed') expect(outcome.screenshot).toEqual(existing)
  })

  it('已取消的运行不再补拍失败截图', async () => {
    const controller = new AbortController()
    controller.abort()
    const locate = vi.fn(async () => ({
      ok: false as const,
      route: 'text' as const,
      outcomeClass: 'cancelled' as const,
      callNs: [],
      error: { code: 'CANCELLED' as const, category: 'CANCELLED' as const, retryable: false, safeMessage: '步骤已取消' },
    }))
    appendResolutionDecision.mockImplementation(async (_handle: unknown, input: { decision: unknown }) => input.decision)
    const captureFailureScreenshot = vi.fn(async () => ({ objectKey: 'should-not-be-used' }) as ScreenshotPointer)
    const browser: BrowserPort = { execute: vi.fn(), captureFailureScreenshot } as unknown as BrowserPort
    const ai: AiPort = { locate } as unknown as AiPort

    const executor = new BrowserStepExecutor({} as never, browser, ai)
    await executor.execute(ctxFor(clickStep(), 'ai_only', controller.signal))

    expect(captureFailureScreenshot).not.toHaveBeenCalled()
  })
})
