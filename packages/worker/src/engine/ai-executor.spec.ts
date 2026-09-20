import { describe, expect, it, vi } from 'vitest'
import { ASSERT_FAILED_CODE, resolveEvidencePolicy } from '@cairn/shared'
import { AiStepExecutor } from './ai-executor.js'
import type { AiPort } from './ports.js'
import { testAiExecution, testRunGrant, testRunSnapshot } from '../__tests__/harness.js'
import { systemClock } from './clock.js'
import { resolveStepInput } from './engine-step-plan.js'
import type { Step } from '@cairn/shared'

const extractStep = {
  id: '00000000-0000-4000-8000-000000000071',
  name: '提取',
  type: 'ai_extract' as const,
  effectType: 'READ_ONLY' as const,
  outputKey: 'order',
  input: {
    instruction: '提取单号',
    outputSchema: { kind: 'object' as const, fields: [{ name: 'orderNo', type: 'string' as const, required: true }] },
  },
}

const assertStep = {
  id: '00000000-0000-4000-8000-000000000072',
  name: '判断',
  type: 'ai_assert' as const,
  effectType: 'READ_ONLY' as const,
  input: { instruction: '结果是否成功' },
}

function context(step: typeof extractStep | typeof assertStep) {
  return {
    runId: '00000000-0000-4000-8000-000000000031',
    stepRunId: '00000000-0000-4000-8000-000000000033',
    attemptId: '00000000-0000-4000-8000-000000000034',
    targetId: '00000000-0000-4000-8000-000000000041',
    step,
    input: step.input,
    context: {},
    signal: new AbortController().signal,
    clock: systemClock,
    sessionGrant: {
      sessionId: '00000000-0000-4000-8000-000000000051',
      leaseId: '00000000-0000-4000-8000-000000000052',
      generation: 1,
      sessionFencingToken: 1,
      expiresAt: '2026-09-13T03:00:00.000Z',
    },
    evidencePolicy: resolveEvidencePolicy({}),
    grant: testRunGrant(),
    snapshot: testRunSnapshot({
      steps: [step],
      aiExecution: testAiExecution(),
    }),
  }
}

describe('AiStepExecutor', () => {
  it('resolves a structured context field before sending an atomic action to the AI port', async () => {
    const step: Step = { id: extractStep.id, name: '输入订单号', type: 'ai_action', effectType: 'SIDE_EFFECT', input: { operation: 'input', mode: 'replace', targetDescription: '订单号', from: 'order', fromField: 'no' } }
    const resolved = resolveStepInput(step, { order: { no: 'SO-2' } })
    expect(resolved.ok).toBe(true)
    const execute = vi.fn<AiPort['execute']>(async () => ({ ok: true, output: { done: true } }))
    await new AiStepExecutor({ execute }).execute({ ...context(extractStep), step, input: resolved.input })
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ action: { operation: 'input', mode: 'replace', targetDescription: '订单号', value: 'SO-2' } })
    expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('instruction')
    expect(resolveStepInput(step, { order: { no: '' } })).toMatchObject({ ok: false, error: { code: 'AI_INPUT_EMPTY', retryable: false } })
    expect(resolveStepInput(step, {})).toMatchObject({ ok: false, error: { category: 'VALIDATION', retryable: false } })
  })
  it('断言不成立走 ASSERT_FAILED / VALIDATION，不把失败写成成功输出', async () => {
    const ai: AiPort = {
      execute: vi.fn(async () => ({
        ok: true,
        output: { passed: false, reason: '列表是空的' },
      })),
    }
    const outcome = await new AiStepExecutor(ai).execute(context(assertStep))
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe(ASSERT_FAILED_CODE)
      expect(outcome.error.category).toBe('VALIDATION')
      expect(outcome.output).toEqual({ passed: false, reason: '列表是空的' })
    }
  })

  it('未落定的调用标 hung，进入核查', async () => {
    const ai: AiPort = {
      execute: vi.fn(async () => ({ ok: false, hung: true, summary: '仍在请求' })),
    }
    const outcome = await new AiStepExecutor(ai).execute(context(extractStep))
    expect(outcome.kind).toBe('needs_review')
    expect(outcome.hung).toBe(true)
  })

  it('没有会话时不调用端口', async () => {
    const execute = vi.fn()
    const outcome = await new AiStepExecutor({ execute }).execute({
      ...context(extractStep),
      sessionGrant: undefined,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error.code).toBe('BROWSER_UNAVAILABLE')
  })
})
