import { z } from 'zod'
import {
  ASSISTANT_PROMPT_VERSION,
  assistantCapabilityIdSchema,
  assistantHypothesisSchema,
  assistantStepChangeSchema,
  PAGE_LANDMARK_MANIFESTS,
  type AssistantCapabilityId,
  type AssistantHypothesis,
  type AssistantPageContext,
  type AssistantStepChange,
  type PlatformAiProvider,
  type PlatformAiThinkingMode,
} from '@cairn/shared'
import { recordPlatformAiCall } from '@cairn/db'
import type { DbHandle } from '@cairn/db'
import type { PlatformModelClient } from './model-client'

/**
 * 'none' 是显式逃生选项。不给模型这个出口，它会被迫在五个能力里硬选一个，
 * 越界提问（闲聊、通用问答、平台做不到的事）必然被误派发到某个能力上。
 */
export const modelClassifySchema = z.strictObject({
  capabilityId: z.union([assistantCapabilityIdSchema, z.literal('none')]),
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
  provider: PlatformAiProvider
  thinkingMode: PlatformAiThinkingMode
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
  private accumulatedReasoning = ''
  private thinkingStartedAt?: number
  private thinkingEndedAt?: number

  constructor(
    private readonly db: DbHandle,
    private readonly turnId: string,
    private readonly access: PlatformAiAccess,
    private readonly client: PlatformModelClient,
    private readonly ownerAccountId?: string,
    private readonly onThinkingDelta?: (delta: string) => void,
  ) {}

  getReasoningInfo(): { reasoningText?: string; durationMs?: number } {
    const text = this.accumulatedReasoning.trim()
    const durationMs =
      this.thinkingStartedAt && this.thinkingEndedAt
        ? this.thinkingEndedAt - this.thinkingStartedAt
        : this.thinkingStartedAt
          ? Date.now() - this.thinkingStartedAt
          : undefined
    return {
      reasoningText: text || undefined,
      durationMs,
    }
  }

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
        provider: this.access.provider,
        thinkingMode: this.access.thinkingMode,
        messages,
        maxTokens: this.access.maxOutputTokens,
        timeoutMs: this.remainingMs(),
        json: true,
        signal,
        onThinkingDelta: (delta) => {
          if (!this.thinkingStartedAt) this.thinkingStartedAt = Date.now()
          this.accumulatedReasoning += delta
          this.onThinkingDelta?.(delta)
        },
      })
      if (result.reasoningText && !this.accumulatedReasoning.includes(result.reasoningText)) {
        if (!this.thinkingStartedAt) this.thinkingStartedAt = started
        this.accumulatedReasoning += (this.accumulatedReasoning ? '\n' : '') + result.reasoningText
      }
      if (this.thinkingStartedAt && !this.thinkingEndedAt) {
        this.thinkingEndedAt = Date.now()
      }
      await recordPlatformAiCall(this.db, {
        turnId: this.turnId,
        ownerAccountId: this.ownerAccountId,
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
        ownerAccountId: this.ownerAccountId,
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

export const modelSupervisorRouteSchema = z.strictObject({
  skillId: z.union([assistantCapabilityIdSchema, z.literal('none')]),
  confidence: z.number().min(0).max(1),
  slots: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  reasoning: z.string().optional(),
})
export type ModelSupervisorRouteOutput = z.infer<typeof modelSupervisorRouteSchema>

export async function supervisorRouteWithLlm(
  session: AssistantModelSession,
  question: string,
  availableSkills: readonly { id: AssistantCapabilityId; label: string; purpose?: string }[],
  pageContext?: AssistantPageContext,
  signal?: AbortSignal,
): Promise<ModelSupervisorRouteOutput | null> {
  const page = pageContext?.page
  const landmarks = page ? PAGE_LANDMARK_MANIFESTS[page] : null
  const landmarkPrompt = landmarks
    ? `\n\n【当前页面地标与可用操作】:\n页面: ${landmarks.pageTitle} (${landmarks.page})\n${JSON.stringify(
        landmarks.regions.map((r) => ({
          region: r.regionName,
          actions: r.actions.map((a) => ({ name: a.name, trigger: a.trigger, description: a.description })),
        })),
        null,
        2,
      )}`
    : '\n\n【当前页面信息】: 无特定页面地标上下文'

  const skillPrompt = availableSkills
    .map((s) => `- ${s.id}: 【${s.label}】${s.purpose ?? ''}`)
    .join('\n')

  const result = await session.completeJson(
    'classify',
    modelSupervisorRouteSchema,
    [
      {
        role: 'system',
        content: `你是识途助手的主管意图路由器（Supervisor Intent Router）。
你的职责是精准理解用户在平台控制台提问的语义，并将其分派给最合适的能力（Skill）。

【核心决策原则】
1. 若用户在当前页面提问某个按钮、操作或功能在页面哪里、怎么操作（如“添加步骤在页面哪里”、“怎么保存草稿”、“怎么排序”）：
   - 若当前页面地标中存在对应操作，必须选择 "in-page.guidance"，并在 slots 中提取 actionKey / question 等信息。
2. 若用户询问的是全局独立大模块、跨系统菜单或跨页面入口（如“在哪里改密码”、“去哪里配置目标系统”、“怎么看监控”）：
   - 必须选择 "platform.guide"，并在 slots 中尽量提取 topic（如 accounts, browser, platform-config, studio, scenarios, runs, targets 等）。
3. 若用户提问运行故障、失败原因、慢在何处：
   - 选择 "run.diagnose"，并在 slots 中带上 runId（若上下文有）或 findRecentFailed: true。
4. 若用户提问比对运行差异：
   - 选择 "run.compare"，并在 slots 中带上 baseRunId / targetRunId。
5. 若用户询问当前场景逻辑、步骤在做什么、或修改建议：
   - 选择 "scenario.explain" 或 "scenario.propose-step"，并在 slots 中带上 scenarioId（若上下文有）。
6. 若用户想要查找/搜索现有场景：
   - 选择 "scenario.discover"，并在 slots 中提取 filter 关键词。
7. 若用户询问受控单资源运维写操作（如暂停调度、恢复调度、取消运行）：
   - 选择 "operations.action"，并在 slots 中提取 actionKey 与 resourceId。
8. 若用户询问平台概念、使用规范、功能配置说明或业务实体事实（非页面局部找按钮动线、非运行失败诊断、非场景步骤解释、且不包含任何修改/执行等写意图）：
   - 选择 "knowledge.answer"，并在 slots 中尽量提取相关关键词或查询意图；若含有明确写意图，禁止选择此能力，强制转入专有操作或澄清。
9. 若都不匹配或用户在进行与平台完全无关的闲聊，skillId 必须输出 "none"，confidence 设为 0。不要勉强归类。

【当前页面信息】
${landmarkPrompt}

【可用能力列表】
${skillPrompt}
- none: 无法匹配任何可用能力

请严格输出 JSON:
{
  "skillId": "能力ID或none",
  "confidence": 0.0到1.0的置信度数值,
  "slots": { "关键参数名": "提取的值" },
  "reasoning": "简要判断理由"
}`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          page: pageContext?.page ?? (pageContext as any)?.pageKind ?? null,
          scenarioId: pageContext?.scenarioId ?? null,
          runId: pageContext?.runId ?? null,
          stepId: pageContext?.stepId ?? null,
          targetId: (pageContext as any)?.targetId ?? null,
        }),
      },
    ],
    signal,
  )

  if (!result.ok) return null
  return result.value
}

export async function classifyAssistantCapability(
  session: AssistantModelSession,
  question: string,
  available: readonly AssistantCapabilityId[],
  signal?: AbortSignal,
  pageContext?: AssistantPageContext,
): Promise<AssistantCapabilityId | null> {
  const skills = available.map((id) => ({ id, label: id }))
  const res = await supervisorRouteWithLlm(session, question, skills, pageContext, signal)
  if (!res || res.skillId === 'none' || !available.includes(res.skillId as AssistantCapabilityId)) {
    return null
  }
  return res.skillId as AssistantCapabilityId
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
