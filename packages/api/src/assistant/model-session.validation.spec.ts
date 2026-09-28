import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { recordPlatformAiCall } from '@cairn/db'
import { PLATFORM_AI_OUTPUT_TRUNCATED_CODE } from '@cairn/shared'
import { AssistantModelSession, modelSupervisorRouteSchema, type PlatformAiAccess } from './model-session'
import type { PlatformModelClient } from './model-client'

vi.mock('@cairn/db', () => ({ recordPlatformAiCall: vi.fn(async () => undefined) }))

const access: PlatformAiAccess = {
  revision: 1,
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  provider: 'deepseek',
  thinkingMode: 'off',
  apiKey: 'test-key',
  requestTimeoutMs: 5_000,
  maxCallsPerTurn: 3,
  maxOutputTokens: 200,
  deadlineAt: new Date(Date.now() + 60_000),
}
const schema = z.strictObject({ answer: z.string() })
const messages = [{ role: 'user' as const, content: '请用 JSON 回答' }]

function session(complete: PlatformModelClient['complete'], override: Partial<PlatformAiAccess> = {}) {
  return new AssistantModelSession({} as never,
    '11111111-1111-4111-8111-111111111111', { ...access, ...override }, { complete },
    '22222222-2222-4222-8222-222222222222')
}

describe('assistant model-call validation records', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records invalid JSON separately from a successful provider response', async () => {
    const complete = vi.fn(async () => ({ text: 'not-json', model: 'test-model' }))
    const result = await session(complete).completeJson('knowledge_answer', schema, messages)

    expect(result).toMatchObject({ ok: false, code: 'MODEL_INVALID_OUTPUT' })
    expect(recordPlatformAiCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      purpose: 'knowledge_answer', errorClass: 'invalid_output',
      validation: { schemaOk: false, grounded: 'not_checked', issue: '模型没有返回合法 JSON' },
    }))
  })

  it('records both failed schema validation and a valid repair', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ text: '{}', model: 'test-model' })
      .mockResolvedValueOnce({ text: '{"answer":"可以"}', model: 'test-model' })
    const result = await session(complete).completeJson('knowledge_answer', schema, messages, undefined, true)

    expect(result).toEqual({ ok: true, value: { answer: '可以' } })
    expect(vi.mocked(recordPlatformAiCall).mock.calls.map(([, record]) =>
      ({ seq: record.seq, purpose: record.purpose, schemaOk: record.validation?.schemaOk })))
      .toEqual([
        { seq: 1, purpose: 'knowledge_answer', schemaOk: false },
        { seq: 2, purpose: 'knowledge_answer-repair', schemaOk: true },
      ])
  })

  it('records the invalid field and issue type without logging model content', async () => {
    const complete = vi.fn(async () => ({ text: '{"answer":42,"private":"do not log"}', model: 'test-model' }))
    await session(complete).completeJson('knowledge_answer', schema, messages)

    expect(recordPlatformAiCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      validation: expect.objectContaining({ issue: '模型输出不符合契约（answer: invalid_type）' }),
    }))
    expect(JSON.stringify(vi.mocked(recordPlatformAiCall).mock.calls)).not.toContain('do not log')
  })

  it('records provider failures as provider errors', async () => {
    const complete = vi.fn(async () => { throw new Error('模型服务返回 HTTP 400') })
    const result = await session(complete).completeJson('knowledge_answer', schema, messages)

    expect(result).toMatchObject({ ok: false, code: 'MODEL_UNAVAILABLE' })
    expect(recordPlatformAiCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      purpose: 'knowledge_answer', errorClass: 'provider_error',
      error: '模型服务返回 HTTP 400',
    }))
  })

  it('records the output limit separately from a generic JSON parse failure', async () => {
    const complete = vi.fn(async () => ({ text: '{"answer":', model: 'test-model',
      finishReason: 'length', usage: { completionTokens: 200 } }))
    const result = await session(complete).completeJson('knowledge_answer', schema, messages)

    expect(result).toMatchObject({ ok: false, code: 'MODEL_INVALID_OUTPUT', message: expect.stringContaining('生成上限') })
    expect(recordPlatformAiCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      errorClass: 'invalid_output',
      validation: expect.objectContaining({ schemaOk: false, grounded: 'not_checked', finishReason: 'length', issue: '模型没有返回合法 JSON' }),
    }))
  })

  it('retries a truncated thinking response once without thinking within the call budget', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ text: '{"answer":', model: 'test-model', finishReason: 'length' })
      .mockResolvedValueOnce({ text: '{"answer":"可以"}', model: 'test-model', finishReason: 'stop' })
    const result = await session(complete, { thinkingMode: 'on' }).completeJson('knowledge_answer', schema, messages)

    expect(result).toEqual({ ok: true, value: { answer: '可以' } })
    expect(complete.mock.calls.map(([input]) => input.thinkingMode)).toEqual(['on', 'off'])
    expect(vi.mocked(recordPlatformAiCall).mock.calls.map(([, record]) =>
      ({ purpose: record.purpose, schemaOk: record.validation?.schemaOk, finishReason: record.validation?.finishReason })))
      .toEqual([
        { purpose: 'knowledge_answer', schemaOk: false, finishReason: 'length' },
        { purpose: 'knowledge_answer-no-thinking-retry', schemaOk: true, finishReason: 'stop' },
      ])
  })

  it('uses a purpose-specific non-thinking mode without repeating a truncated call', async () => {
    const complete = vi.fn(async () => ({ text: '{"answer":', model: 'test-model', finishReason: 'length' }))
    const result = await session(complete, { thinkingMode: 'on' })
      .completeJson('knowledge_answer', schema, messages, undefined, false, 'off')

    expect(result).toMatchObject({ ok: false, code: 'MODEL_INVALID_OUTPUT' })
    expect(complete.mock.calls.map(([input]) => input.thinkingMode)).toEqual(['off'])
  })

  it('records an empty output caused by the output limit as invalid output', async () => {
    const complete = vi.fn(async () => { throw Object.assign(new Error('模型输出达到生成上限'), {
      code: PLATFORM_AI_OUTPUT_TRUNCATED_CODE,
    }) })
    const result = await session(complete).completeJson('knowledge_answer', schema, messages)

    expect(result).toMatchObject({ ok: false, code: 'MODEL_INVALID_OUTPUT' })
    expect(recordPlatformAiCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      errorClass: 'invalid_output',
      validation: { schemaOk: false, grounded: 'not_checked', finishReason: 'length' },
    }))
  })
})

describe('supervisor route slot normalization', () => {
  it('keeps the route when optional keywords arrive as a list', () => {
    expect(modelSupervisorRouteSchema.parse({
      skillId: 'knowledge.answer', confidence: 0.88,
      slots: { keywords: ['确定性步骤', '重试'], nested: { unsupported: true }, runId: 'run-1' },
    })).toEqual({ skillId: 'knowledge.answer', confidence: 0.88,
      slots: { keywords: '确定性步骤 重试', runId: 'run-1' } })
  })
})
