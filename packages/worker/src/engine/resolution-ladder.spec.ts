import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserCommand, BrowserCommandResult, ResolutionDecision, RunGrant, Step } from '@cairn/shared'
import { commandHasResolvableTarget, isDeterministicMiss, outcomeFromBrowser, resolutionError, runResolutionLadder } from './resolution-ladder.js'
import type { AiPort, BrowserPort } from './ports.js'
import type { MapConsumptionService } from '../map/consumption.service.js'
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

function clickStep(extras: Partial<Step> = {}): Step {
  return {
    id: STEP_ID,
    name: '点击',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'text', value: '查询' }] },
    },
    ...extras,
  } as Step
}

function commandFor(step: Step): BrowserCommand {
  return {
    type: 'click',
    target: step.type === 'click' ? step.input.target : { framePath: [], candidates: [{ by: 'text', value: '查询' }] },
  }
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

function ctx(step: Step, policy: 'deterministic_only' | 'prefer_deterministic' | 'prefer_ai' | 'ai_only'): StepExecutionContext {
  return {
    runId: RUN_ID,
    stepRunId: STEP_RUN_ID,
    attemptId: ATTEMPT_ID,
    targetId: '00000000-0000-4000-8000-0000000000f1',
    step,
    input: {},
    context: {},
    signal: new AbortController().signal,
    clock: { now: () => Date.now() },
    sessionGrant: {
      leaseId: '00000000-0000-4000-8000-0000000000e2',
      sessionId: '00000000-0000-4000-8000-0000000000e3',
      fencingToken: 1,
      holderWorkerId: 'w1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    evidencePolicy: { screenshot: 'on_failure', trace: 'off' },
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

function found(): BrowserCommandResult {
  return { ok: true, output: {}, diagnostics: { outcome: 'FOUND', candidatesTried: [] } }
}

function missing(): BrowserCommandResult {
  return {
    ok: false,
    error: { code: 'TARGET_NOT_FOUND', category: 'EXECUTOR', retryable: true, safeMessage: '未找到' },
    diagnostics: { outcome: 'TARGET_NOT_FOUND', candidatesTried: [] },
  }
}

describe('解析阶梯', () => {
  beforeEach(() => {
    appendResolutionDecision.mockReset()
    appendResolutionDecision.mockImplementation(async (_handle: unknown, input: { decision: ResolutionDecision }) => input.decision)
  })

  it('只对带 target 的命令走阶梯', () => {
    expect(commandHasResolvableTarget({ type: 'navigate', url: 'https://lab.example', allowedOrigins: ['https://lab.example'] })).toBe(false)
    expect(commandHasResolvableTarget(commandFor(clickStep()))).toBe(true)
    expect(outcomeFromBrowser(found())).toBe('FOUND')
    expect(resolutionError('CROSS_CHECK_FAILED', '不匹配').retryable).toBe(false)
  })

  it('确定性命中后写入决策，不调 AI', async () => {
    const step = clickStep()
    const execute = vi.fn(async () => found())
    const locate = vi.fn()
    const afterBaseline = vi.fn(async () => ({ kind: 'unchanged' as const }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_deterministic'),
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('success')
    expect(locate).not.toHaveBeenCalled()
    expect(afterBaseline).toHaveBeenCalledTimes(1)
    expect(appendResolutionDecision).toHaveBeenCalledTimes(1)
    expect(appendResolutionDecision.mock.calls[0]?.[1].decision.decision).toBe('deterministic')
  })

  it('AI 决策写入失败时不执行 Playwright 动作', async () => {
    const step = clickStep({ policy: { resolution: 'prefer_deterministic' } })
    const execute = vi.fn(async () => missing())
    appendResolutionDecision.mockRejectedValueOnce(new Error('persist'))
    const bindResolvedFromPoint = vi.fn(async () => ({ ok: true, texts: ['查询'], tagName: 'BUTTON' }))
    const clearResolved = vi.fn(async () => undefined)
    const locate = vi.fn(async () => ({ ok: true, center: [10, 20] as [number, number], dpr: 1, callNs: [1] }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_deterministic'),
      step,
      command: commandFor(step),
      browser: { bindResolvedFromPoint, clearResolved } as unknown as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'unchanged' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('PERSISTENCE_FAILED')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(clearResolved).toHaveBeenCalled()
  })

  it('写步骤交叉确认失败时零动作并记 CROSS_CHECK_FAILED', async () => {
    const step = clickStep()
    const execute = vi.fn(async () => missing())
    const locate = vi.fn(async () => ({ ok: true, center: [10, 20] as [number, number], dpr: 1, callNs: [1] }))
    const bindResolvedFromPoint = vi.fn(async () => ({ ok: true, texts: ['取消'], tagName: 'BUTTON' }))
    const clearResolved = vi.fn(async () => undefined)
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_deterministic'),
      step,
      command: commandFor(step),
      browser: { bindResolvedFromPoint, clearResolved } as unknown as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'unchanged' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('CROSS_CHECK_FAILED')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(appendResolutionDecision.mock.calls.at(-1)?.[1].decision).toMatchObject({
      decision: 'failed',
      reasonCode: 'CROSS_CHECK_FAILED',
    })
  })

  it('prefer_ai 跳过地图级', async () => {
    const step = clickStep({ policy: { resolution: 'prefer_ai' } })
    const execute = vi.fn(async () => found())
    const afterBaseline = vi.fn(async () => ({ kind: 'passthrough' as const }))
    const locate = vi.fn(async () => ({ ok: false, error: { code: 'AI_NOT_FOUND', category: 'EXECUTOR', retryable: true, safeMessage: '未找到' } }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_ai'),
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('success')
    expect(afterBaseline).toHaveBeenCalledTimes(1)
    expect(appendResolutionDecision.mock.calls.at(-1)?.[1].decision.decision).toBe('deterministic')
    expect(appendResolutionDecision.mock.calls.at(-1)?.[1].decision.rungs.some((rung: { rung: string }) => rung.rung === 'M')).toBe(false)
  })

  it('断言失败或弹窗交接失败不升到 AI 级', async () => {
    expect(isDeterministicMiss({
      ok: false,
      error: { code: 'ASSERT_FAILED', category: 'EXECUTOR', retryable: false, safeMessage: '断言不成立' },
      diagnostics: { outcome: 'FOUND', candidatesTried: [] },
    })).toBe(false)
    const step = clickStep()
    const locate = vi.fn()
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'ASSERT_FAILED', category: 'EXECUTOR' as const, retryable: false, safeMessage: '断言不成立' },
      diagnostics: { outcome: 'FOUND' as const, candidatesTried: [] },
    }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_deterministic'),
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'passthrough' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('ASSERT_FAILED')
    expect(locate).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('定位挂起记 AI_HUNG 并标 hung，不伪装成未找到', async () => {
    const step = clickStep()
    const execute = vi.fn(async () => missing())
    const locate = vi.fn(async () => ({
      ok: false,
      hung: true,
      summary: '模型调用在超时后仍未落定',
      callNs: [],
      error: { code: 'AI_HUNG', category: 'UNKNOWN' as const, retryable: false, safeMessage: 'AI 调用未落定，会话不可复用' },
    }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_deterministic'),
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'passthrough' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('needs_review')
    expect(outcome.kind !== 'success' && outcome.error.code).toBe('AI_HUNG')
    expect(outcome.kind !== 'success' && outcome.hung).toBe(true)
    expect(appendResolutionDecision.mock.calls.at(-1)?.[1].decision.reasonCode).toBe('AI_HUNG')
  })

  it('取消后决策写入失效仍保留 CANCELLED', async () => {
    const step = clickStep()
    const controller = new AbortController()
    const context = ctx(step, 'prefer_deterministic')
    ;(context as { signal: AbortSignal }).signal = controller.signal
    const execute = vi.fn(async () => {
      controller.abort()
      return {
        ok: false as const,
        error: { code: 'CANCELLED', category: 'CANCELLED' as const, retryable: false, safeMessage: '步骤已取消' },
      }
    })
    appendResolutionDecision.mockRejectedValue(Object.assign(new Error('stale'), { code: 'RESOLUTION_FACT_STALE_OWNER' }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: context,
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate: vi.fn() } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'passthrough' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('CANCELLED')
    expect(outcome.kind === 'failed' && outcome.aborted).toBe(true)
  })

  it('容器标签交叉确认失败，零动作', async () => {
    const step = clickStep()
    const execute = vi.fn(async () => missing())
    const locate = vi.fn(async () => ({ ok: true, center: [10, 20] as [number, number], dpr: 1, callNs: [1] }))
    const bindResolvedFromPoint = vi.fn(async () => ({ ok: true, texts: ['查询'], tagName: 'TD' }))
    const clearResolved = vi.fn(async () => undefined)
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_deterministic'),
      step,
      command: commandFor(step),
      browser: { bindResolvedFromPoint, clearResolved } as unknown as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'passthrough' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('CROSS_CHECK_FAILED')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(clearResolved).toHaveBeenCalled()
  })

  it('剩余尝试期限不够一次请求时不调模型', async () => {
    const step = clickStep()
    const context = ctx(step, 'prefer_deterministic')
    const now = 1_000
    ;(context as { clock: { now: () => number }; deadlineAtMs: number }).clock = { now: () => now }
    ;(context as { deadlineAtMs: number }).deadlineAtMs = now + 3_000
    const locate = vi.fn()
    const execute = vi.fn(async () => missing())
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: context,
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'passthrough' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(locate).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('BUDGET_EXHAUSTED')
  })

  it('prefer_ai 在 AI 取消后不再执行确定性动作', async () => {
    const step = clickStep({ policy: { resolution: 'prefer_ai' } })
    const execute = vi.fn()
    const locate = vi.fn(async () => ({
      ok: false,
      error: { code: 'CANCELLED', category: 'CANCELLED' as const, retryable: false, safeMessage: '已取消' },
    }))
    const outcome = await runResolutionLadder({
      handle: {} as never,
      ctx: ctx(step, 'prefer_ai'),
      step,
      command: commandFor(step),
      browser: {} as BrowserPort,
      ai: { locate } as unknown as AiPort,
      consumption: { afterBaseline: async () => ({ kind: 'passthrough' as const }) } as unknown as MapConsumptionService,
      execute,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('CANCELLED')
    expect(execute).not.toHaveBeenCalled()
  })
})
