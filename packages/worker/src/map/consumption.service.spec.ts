import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MapConsumptionService } from './consumption.service.js'
import type { StepExecutionContext } from '../engine/step-executor.js'
import { resolveEvidencePolicy, type BrowserCommandResult, type Step } from '@cairn/shared'

const mocks = vi.hoisted(() => ({
  appendMapFacts: vi.fn(),
  appendMapSelectionDecision: vi.fn(),
  findMapConsumptionAttemptObservation: vi.fn(),
  loadFrozenMapCandidates: vi.fn(),
  newId: vi.fn(() => '00000000-0000-4000-8000-000000000099'),
}))

vi.mock('@cairn/db', () => mocks)

const targetId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
const stepRunId = '00000000-0000-4000-8000-000000000003'
const attemptId = '00000000-0000-4000-8000-000000000004'
const stepId = '00000000-0000-4000-8000-000000000005'
const releaseId = '00000000-0000-4000-8000-000000000006'
const objectId = '00000000-0000-4000-8000-000000000007'
const digest = 'c'.repeat(64)

const extractStep: Step = {
  id: stepId,
  name: '提取',
  type: 'extract',
  effectType: 'READ_ONLY',
  outputKey: 'title',
  input: {
    target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] },
    as: 'text',
  },
}

const clickStep: Step = {
  id: stepId,
  name: '点击',
  type: 'click',
  effectType: 'SIDE_EFFECT',
  input: { target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '保存' }] } },
}

function frozen(mode: 'shadow' | 'read_only_fallback') {
  return {
    mode,
    releaseId,
    targetId,
    manifestDigest: digest,
    sourceWatermark: 1,
    policy: {
      schemaVersion: 1 as const,
      policyVersion: 1,
      mode,
      allowedStepTypes: ['extract', 'assert'] as ('extract' | 'assert')[],
      allowedAssetRefs: [],
      maxCandidateCount: 2,
      maxResolveMs: 1000,
      maxExtraAiCalls: 0 as const,
      onUnavailable: 'baseline' as const,
    },
    bindings: [
      {
        stepId,
        slotKey: 'step:extract',
        assetRef: { targetId, objectId, implementationKey: 'desktop-zh', descriptorVersion: 1 },
        bindingDigest: digest,
      },
    ],
    consumerVersion: 'map-consumption@1' as const,
    frozenAt: '2026-09-16T00:00:00.000Z',
  }
}

function ctx(step: Step, mapConsumption?: ReturnType<typeof frozen> | { mode: 'off' }): StepExecutionContext {
  return {
    runId,
    stepRunId,
    attemptId,
    targetId,
    step,
    input: {},
    context: {},
    signal: new AbortController().signal,
    clock: { now: () => 1_000, sleep: async () => undefined },
    sessionGrant: {
      sessionId: '00000000-0000-4000-8000-000000000008',
      leaseId: '00000000-0000-4000-8000-000000000009',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: '2026-09-16T01:00:00.000Z',
    },
    evidencePolicy: resolveEvidencePolicy({}),
    grant: {
      runId,
      leaseId: '00000000-0000-4000-8000-000000000010',
      fencingToken: 1,
      holderWorkerId: 'w1',
      expiresAt: '2026-09-16T01:00:00.000Z',
    },
    snapshot: {
      schemaVersion: 1,
      runId,
      targetId,
      scenarioId: '00000000-0000-4000-8000-000000000011',
      scenarioVersionId: '00000000-0000-4000-8000-000000000012',
      steps: [step],
      input: {},
      createdAt: '2026-09-16T00:00:00.000Z',
      mapConsumption,
    } as StepExecutionContext['snapshot'],
  }
}

const notFound: BrowserCommandResult = {
  ok: false,
  error: {
    code: 'TARGET_NOT_FOUND',
    category: 'VALIDATION',
    retryable: false,
    safeMessage: '未找到',
  },
}

const found: BrowserCommandResult = {
  ok: true,
  output: { value: '订单' },
  resolvedTargetToken: '00000000-0000-4000-8000-000000000070',
  diagnostics: { outcome: 'FOUND', candidatesTried: [{ index: 0, by: 'role', value: 'heading', matches: 1 }] },
}

describe('地图消费服务', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appendMapFacts.mockResolvedValue([])
    mocks.appendMapSelectionDecision.mockResolvedValue({})
    mocks.loadFrozenMapCandidates.mockResolvedValue({ digestOk: true, candidates: [] })
  })

  it('OMF01 off 不读地图也不写决策', async () => {
    const browser = { execute: vi.fn() }
    const service = new MapConsumptionService({} as never, browser as never)
    const result = await service.afterBaseline(
      ctx(extractStep, { mode: 'off' }),
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result).toEqual({ kind: 'passthrough' })
    expect(browser.execute).not.toHaveBeenCalled()
    expect(mocks.loadFrozenMapCandidates).not.toHaveBeenCalled()
    expect(mocks.appendMapSelectionDecision).not.toHaveBeenCalled()
  })

  it('OMF03 原定位成功只记 baseline', async () => {
    const service = new MapConsumptionService({} as never, { execute: vi.fn() } as never)
    const result = await service.afterBaseline(
      ctx(extractStep, frozen('shadow')),
      extractStep,
      found,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result.kind).toBe('passthrough')
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ decision: 'baseline', reasonCode: 'BASELINE_FOUND' }),
      }),
    )
    expect(mocks.loadFrozenMapCandidates).not.toHaveBeenCalled()
  })

  it('OMF07 click 不进候选', async () => {
    const service = new MapConsumptionService({} as never, { execute: vi.fn() } as never)
    await service.afterBaseline(
      ctx(clickStep, frozen('shadow')),
      clickStep,
      notFound,
      { type: 'click', target: clickStep.input.target },
    )
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ decision: 'skipped', reasonCode: 'EFFECT_NOT_READ_ONLY' }),
      }),
    )
  })

  it('OMF04 shadow 命中唯一候选不改原结果', async () => {
    const descriptor = { framePath: [], candidates: [{ by: 'role' as const, value: 'heading', name: '单据' }] }
    mocks.loadFrozenMapCandidates.mockResolvedValue({
      digestOk: true,
      candidates: [
        {
          binding: frozen('shadow').bindings[0],
          descriptor,
          condition: { targetId, accountBinding: { presence: 'unknown' }, unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'] },
          locatorConfirmed: true,
        },
      ],
    })
    const browser = {
      execute: vi.fn().mockResolvedValue(found),
    }
    const service = new MapConsumptionService({} as never, browser as never)
    const result = await service.afterBaseline(
      ctx(extractStep, frozen('shadow')),
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result.kind).toBe('passthrough')
    expect(browser.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'locate', target: descriptor }),
      expect.anything(),
    )
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ decision: 'shadow_only', reasonCode: 'SHADOW_WOULD_USE' }),
      }),
    )
  })

  it('OMF04 fallback 先写 selected 再执行原 extract', async () => {
    const descriptor = { framePath: [], candidates: [{ by: 'role' as const, value: 'heading', name: '单据' }] }
    mocks.loadFrozenMapCandidates.mockResolvedValue({
      digestOk: true,
      candidates: [
        {
          binding: frozen('read_only_fallback').bindings[0],
          descriptor,
          condition: { targetId, accountBinding: { presence: 'unknown' }, unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'] },
          locatorConfirmed: true,
        },
      ],
    })
    const browser = {
      execute: vi.fn()
        .mockResolvedValueOnce(found)
        .mockResolvedValueOnce({ ok: true, output: { value: '单据' } }),
    }
    const service = new MapConsumptionService({} as never, browser as never)
    const result = await service.afterBaseline(
      ctx(extractStep, frozen('read_only_fallback')),
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result).toEqual({ kind: 'replaced', result: { ok: true, output: { value: '单据' } } })
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ decision: 'selected', reasonCode: 'FALLBACK_USED' }),
      }),
    )
    expect(browser.execute).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'extract', target: descriptor, as: 'text', expectedTargetToken: found.ok ? found.resolvedTargetToken : undefined }),
      expect.anything(),
      expect.objectContaining({ runId }),
    )
  })

  it('OMF04 选定候选关联同 Attempt 的既有观察，分开回流定位和业务评价', async () => {
    mocks.loadFrozenMapCandidates.mockResolvedValue({ digestOk: true, candidates: [candidate()] })
    mocks.findMapConsumptionAttemptObservation.mockResolvedValue({ observationId: '00000000-0000-4000-8000-000000000080' })
    const browser = { execute: vi.fn().mockResolvedValueOnce(found).mockResolvedValueOnce({ ok: true, output: { value: '单据' } }) }
    const result = await new MapConsumptionService({} as never, browser as never).afterBaseline(
      ctx(extractStep, frozen('read_only_fallback')), extractStep, notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result.kind).toBe('replaced')
    expect(mocks.appendMapFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      facts: expect.arrayContaining([
        expect.objectContaining({ type: 'verification', verification: expect.objectContaining({ dimension: 'locator', verdict: 'confirmed' }) }),
        expect.objectContaining({ type: 'verification', verification: expect.objectContaining({ dimension: 'business', verdict: 'not_observed' }) }),
      ]),
    }))
  })

  it('OMF06 在步骤时采样语言和视口；采样不到时仍保守跳过依赖语言的候选', async () => {
    const localeCandidate = {
      ...candidate(),
      condition: { targetId, accountBinding: { presence: 'unknown' },
        locale: 'en-US', viewport: { category: 'desktop' as const, widthPx: 1440, heightPx: 900 },
        unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'featureVersion'] },
    }
    mocks.loadFrozenMapCandidates.mockResolvedValue({ digestOk: true, candidates: [localeCandidate] })
    const browser = {
      sampleMapConditions: vi.fn().mockResolvedValue({ locale: 'en-US', viewport: { category: 'desktop', widthPx: 1440, heightPx: 900 }, pageFrameObserved: true }),
      execute: vi.fn().mockResolvedValue(found),
    }
    const result = await new MapConsumptionService({} as never, browser as never).afterBaseline(
      ctx(extractStep, frozen('shadow')), extractStep, notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result.kind).toBe('passthrough')
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      decision: expect.objectContaining({ conditionSnapshot: expect.objectContaining({ locale: 'en-US', viewport: expect.objectContaining({ category: 'desktop' }) }), coverage: 'page_frame_observed' }),
    }))
  })

  it('OMF08 查询失败或预算用尽时保留原定位、不再试候选', async () => {
    const original = ctx(extractStep, frozen('shadow'))
    const expired = { ...original, snapshot: { ...original.snapshot, deadlineAt: '1970-01-01T00:00:00.000Z' } }
    const browser = { execute: vi.fn() }
    const timeoutService = new MapConsumptionService({} as never, browser as never)
    const timeoutResult = await timeoutService.afterBaseline(
      expired,
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(timeoutResult.kind).toBe('passthrough')
    expect(mocks.loadFrozenMapCandidates).not.toHaveBeenCalled()
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ decision: 'skipped', reasonCode: 'BUDGET_EXHAUSTED' }),
      }),
    )

    mocks.loadFrozenMapCandidates.mockRejectedValueOnce(new Error('projection down'))
    const failService = new MapConsumptionService({} as never, { execute: vi.fn() } as never)
    const failResult = await failService.afterBaseline(
      ctx(extractStep, frozen('shadow')),
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(failResult.kind).toBe('passthrough')
    expect(mocks.appendMapSelectionDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ decision: 'skipped', reasonCode: 'QUERY_UNAVAILABLE' }),
      }),
    )
  })

  it('OMF11 选定后页面丢失则停止，不换对象重试', async () => {
    const descriptor = { framePath: [], candidates: [{ by: 'role' as const, value: 'heading', name: '单据' }] }
    mocks.loadFrozenMapCandidates.mockResolvedValue({
      digestOk: true,
      candidates: [
        {
          binding: frozen('read_only_fallback').bindings[0],
          descriptor,
          condition: { targetId, accountBinding: { presence: 'unknown' }, unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'] },
          locatorConfirmed: true,
        },
      ],
    })
    const lost: BrowserCommandResult = {
      ok: false,
      error: { code: 'SURFACE_LOST', category: 'INFRASTRUCTURE', retryable: true, safeMessage: '页面已替换' },
      diagnostics: { outcome: 'SURFACE_LOST', candidatesTried: [] },
    }
    const browser = {
      execute: vi.fn().mockResolvedValueOnce(found).mockResolvedValueOnce(lost),
    }
    const service = new MapConsumptionService({} as never, browser as never)
    const result = await service.afterBaseline(
      ctx(extractStep, frozen('read_only_fallback')),
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result).toEqual({ kind: 'replaced', result: lost })
    expect(browser.execute).toHaveBeenCalledTimes(2)
  })

  it('OMF09 写入失败则不执行候选读取', async () => {
    mocks.loadFrozenMapCandidates.mockResolvedValue({
      digestOk: true,
      candidates: [
        {
          binding: frozen('read_only_fallback').bindings[0],
          descriptor: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '单据' }] },
          condition: { targetId, accountBinding: { presence: 'unknown' }, unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'] },
          locatorConfirmed: true,
        },
      ],
    })
    mocks.appendMapSelectionDecision.mockRejectedValue({ code: 'MAP_FACT_STALE_OWNER' })
    const browser = { execute: vi.fn().mockResolvedValue(found) }
    const service = new MapConsumptionService({} as never, browser as never)
    const result = await service.afterBaseline(
      ctx(extractStep, frozen('read_only_fallback')),
      extractStep,
      notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' },
    )
    expect(result.kind).toBe('blocked')
    expect(browser.execute).toHaveBeenCalledTimes(1)
  })
  function candidate() {
    return { binding: frozen('read_only_fallback').bindings[0],
      descriptor: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '单据' }] },
      condition: { targetId, accountBinding: { presence: 'unknown' }, unknownFields: ['targetAccount', 'permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'] },
      locatorConfirmed: true }
  }
  it('挂起的地图查询在预算内返回，迟到结果不触发候选读取', async () => {
    let resolve!: (value: unknown) => void
    mocks.loadFrozenMapCandidates.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const policy = frozen('read_only_fallback')
    policy.policy.maxResolveMs = 20
    const browser = { execute: vi.fn() }
    const began = Date.now()
    const result = await new MapConsumptionService({} as never, browser as never).afterBaseline(ctx(extractStep, policy), extractStep, notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' })
    expect(Date.now() - began).toBeLessThan(300)
    expect(result.kind).toBe('passthrough')
    resolve({ digestOk: true, candidates: [candidate()] })
    await Promise.resolve()
    expect(browser.execute).not.toHaveBeenCalled()
    expect(mocks.appendMapSelectionDecision.mock.calls[0]![1].decision.reasonCode).toBe('BUDGET_EXHAUSTED')
  })
  it('候选定位异常只记录查询失败，保留原定位结果', async () => {
    mocks.loadFrozenMapCandidates.mockResolvedValueOnce({ digestOk: true, candidates: [candidate()] })
    const browser = { execute: vi.fn().mockRejectedValue(new Error('transport down')) }
    const result = await new MapConsumptionService({} as never, browser as never).afterBaseline(ctx(extractStep, frozen('shadow')), extractStep, notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' })
    expect(result.kind).toBe('passthrough')
    expect(mocks.appendMapSelectionDecision.mock.calls[0]![1].decision.reasonCode).toBe('QUERY_UNAVAILABLE')
  })
  it('持久化期间取消，不发出候选业务读取', async () => {
    const abort = new AbortController()
    mocks.loadFrozenMapCandidates.mockResolvedValueOnce({ digestOk: true, candidates: [candidate()] })
    mocks.appendMapSelectionDecision.mockImplementationOnce(async () => abort.abort())
    const browser = { execute: vi.fn().mockResolvedValue(found) }
    await new MapConsumptionService({} as never, browser as never).afterBaseline({ ...ctx(extractStep, frozen('read_only_fallback')), signal: abort.signal }, extractStep, notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' })
    expect(browser.execute).toHaveBeenCalledTimes(1)
  })
  it('预算不足以检查全部候选时不能从已命中的部分选取', async () => {
    const policy = frozen('read_only_fallback')
    policy.policy.maxCandidateCount = 1
    mocks.loadFrozenMapCandidates.mockResolvedValueOnce({ digestOk: true, candidates: [candidate(), candidate()] })
    const browser = { execute: vi.fn().mockResolvedValue(found) }
    const result = await new MapConsumptionService({} as never, browser as never).afterBaseline(ctx(extractStep, policy), extractStep, notFound,
      { type: 'extract', target: extractStep.input.target, as: 'text' })
    expect(result.kind).toBe('passthrough')
    expect(browser.execute).toHaveBeenCalledTimes(1)
    expect(mocks.appendMapSelectionDecision.mock.calls[0]![1].decision.reasonCode).toBe('BUDGET_EXHAUSTED')
  })

  it('记录 baseline 失败不能把已成功执行的步骤变成重试', async () => {
    mocks.appendMapSelectionDecision.mockRejectedValueOnce(new Error('ledger unavailable'))
    const browser = { execute: vi.fn() }
    const result = await new MapConsumptionService({} as never, browser as never).afterBaseline(ctx(extractStep, frozen('shadow')), extractStep, found,
      { type: 'extract', target: extractStep.input.target, as: 'text' })
    expect(result).toEqual({ kind: 'passthrough' })
    expect(browser.execute).not.toHaveBeenCalled()
  })

})
