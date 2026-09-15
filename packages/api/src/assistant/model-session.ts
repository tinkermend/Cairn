import { z } from 'zod'
import {
  ASSISTANT_PROMPT_VERSION,
  assistantCapabilityIdSchema,
  assistantHypothesisSchema,
  assistantStepChangeSchema,
  type AssistantCapabilityId,
  type AssistantHypothesis,
  type AssistantStepChange,
} from '@cairn/shared'
import { recordPlatformAiCall } from '@cairn/db'
import type { DbHandle } from '@cairn/db'
import type { PlatformModelClient } from './model-client'

export const modelClassifySchema = z.strictObject({
  capabilityId: assistantCapabilityIdSchema,
})

export const modelHypothesesSchema = z.strictObject({
  hypotheses: assistantHypothesisSchema.array().max(8),
})

export const modelExplanationSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2048),
  stepSummary: z.string().trim().min(1).max(1024).optional(),
})

export type PlatformAiAccess = {
  revision: number
  baseUrl: string
  model: string
  apiKey: string
  requestTimeoutMs: number
  maxCallsPerTurn: number
  maxOutputTokens: number
  deadlineAt: Date
}

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced?.[1]?.trim() ?? trimmed
  return JSON.parse(raw) as unknown
}

export class AssistantModelSession {
  used = 0

  constructor(
    private readonly db: DbHandle,
    private readonly turnId: string,
    private readonly access: PlatformAiAccess,
    private readonly client: PlatformModelClient,
  ) {}

  remainingMs() {
    return Math.max(1, Math.min(this.access.requestTimeoutMs, this.access.deadlineAt.getTime() - Date.now()))
  }

  async completeJson<T>(
    purpose: string,
    schema: z.ZodType<T>,
    messages: { role: 'system' | 'user'; content: string }[],
    signal?: AbortSignal,
    allowRepair = false,
  ): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    const first = await this.call(purpose, messages, signal)
    if (!first.ok) return first
    const parsed = this.parse(schema, first.text)
    if (parsed.ok) return parsed
    if (!allowRepair || this.used >= this.access.maxCallsPerTurn) return parsed
    const repaired = await this.call(`${purpose}-repair`, [
      ...messages,
      { role: 'user', content: `上一次输出无法通过契约：${parsed.message}。请只输出合法 JSON。` },
    ], signal)
    if (!repaired.ok) return repaired
    return this.parse(schema, repaired.text)
  }

  private parse<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; message: string } {
    try {
      const parsed = schema.safeParse(parseModelJson(text))
      if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '模型输出不合法' }
      return { ok: true, value: parsed.data }
    } catch {
      return { ok: false, message: '模型没有返回合法 JSON' }
    }
  }

  private async call(
    purpose: string,
    messages: { role: 'system' | 'user'; content: string }[],
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    if (this.used >= this.access.maxCallsPerTurn) {
      return { ok: false, message: '本轮模型调用次数已用尽' }
    }
    if (Date.now() >= this.access.deadlineAt.getTime()) {
      return { ok: false, message: '本轮模型时间已用尽' }
    }
    this.used += 1
    const started = Date.now()
    try {
      const result = await this.client.complete({
        baseUrl: this.access.baseUrl,
        apiKey: this.access.apiKey,
        model: this.access.model,
        messages,
        maxTokens: this.access.maxOutputTokens,
        timeoutMs: this.remainingMs(),
        json: true,
        signal,
      })
      await recordPlatformAiCall(this.db, {
        turnId: this.turnId,
        seq: this.used,
        purpose,
        configRevision: this.access.revision,
        model: result.model,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        reservedTokens: this.access.maxOutputTokens,
        usage: result.usage ?? null,
        durationMs: Date.now() - started,
      })
      return { ok: true, text: result.text }
    } catch (error) {
      await recordPlatformAiCall(this.db, {
        turnId: this.turnId,
        seq: this.used,
        purpose,
        configRevision: this.access.revision,
        model: this.access.model,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        reservedTokens: this.access.maxOutputTokens,
        error: error instanceof Error ? error.message : '模型调用失败',
        durationMs: Date.now() - started,
      }).catch(() => undefined)
      return { ok: false, message: error instanceof Error ? error.message : '模型调用失败' }
    }
  }
}

export async function classifyAssistantCapability(
  session: AssistantModelSession,
  question: string,
  available: readonly AssistantCapabilityId[],
  signal?: AbortSignal,
): Promise<AssistantCapabilityId | null> {
  const result = await session.completeJson(
    'classify',
    modelClassifySchema,
    [
      {
        role: 'system',
        content:
          '你是识途助手路由器。只能从给定能力中选一个。输出 JSON {"capabilityId":"..."}。不要编造能力。',
      },
      {
        role: 'user',
        content: JSON.stringify({ question, available }),
      },
    ],
    signal,
  )
  if (!result.ok || !available.includes(result.value.capabilityId)) return null
  return result.value.capabilityId
}

export async function generateDiagnosisHypotheses(
  session: AssistantModelSession,
  question: string,
  facts: string,
  citations: string[],
  signal?: AbortSignal,
): Promise<{ hypotheses: AssistantHypothesis[]; error?: string }> {
  const result = await session.completeJson(
    'diagnose',
    modelHypothesesSchema,
    [
      {
        role: 'system',
        content:
          '根据已确认事实提出可能原因。每条必须引用事实包中已有的 citation 键，标为推断。证据不足时不要编造根因。输出 JSON {"hypotheses":[{"text":"...","citations":["run:..."]}]}。',
      },
      { role: 'user', content: JSON.stringify({ question, facts, citations }) },
    ],
    signal,
    true,
  )
  if (!result.ok) return { hypotheses: [], error: result.message }
  const allowed = new Set(citations)
  return {
    hypotheses: result.value.hypotheses.filter((item) => item.citations.every((key) => allowed.has(key))),
  }
}

export async function generateExplanationText(
  session: AssistantModelSession,
  question: string,
  facts: unknown,
  signal?: AbortSignal,
): Promise<{ summary?: string; stepSummary?: string; error?: string }> {
  const result = await session.completeJson(
    'explain',
    modelExplanationSchema,
    [
      {
        role: 'system',
        content:
          '用中文解释已保存的场景定义。不要编造定位器或未出现的步骤。输出 JSON {"summary":"...","stepSummary":"..."}。',
      },
      { role: 'user', content: JSON.stringify({ question, facts }) },
    ],
    signal,
    true,
  )
  if (!result.ok) return { error: result.message }
  return result.value
}

export async function generateStepChange(
  session: AssistantModelSession,
  question: string,
  facts: unknown,
  signal?: AbortSignal,
): Promise<{ change?: AssistantStepChange; error?: string }> {
  const result = await session.completeJson(
    'propose',
    assistantStepChangeSchema,
    [
      {
        role: 'system',
        content:
          '只生成一种受限单步变更：ai_instruction、assert_expectation 或 fill_binding。不要输出 value，不要改定位器。输出对应 JSON。',
      },
      { role: 'user', content: JSON.stringify({ question, facts }) },
    ],
    signal,
    true,
  )
  if (!result.ok) return { error: result.message }
  return { change: result.value }
}
