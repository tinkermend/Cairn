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
  private thinkingStartedAt?: number
  private thinkingDurationMs = 0

  constructor(
    private readonly db: DbHandle,
    private readonly turnId: string,
    private readonly access: PlatformAiAccess,
    private readonly client: PlatformModelClient,
    private readonly ownerAccountId?: string,
  ) {}

  getReasoningInfo(): { durationMs?: number } {
    const durationMs = this.thinkingDurationMs +
      (this.thinkingStartedAt ? Date.now() - this.thinkingStartedAt : 0)
    return { durationMs: durationMs > 0 ? durationMs : undefined }
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
  ): Promise<{ ok: true; value: T } | { ok: false; message: string; code?: 'MODEL_UNAVAILABLE' | 'MODEL_TIMEOUT' | 'MODEL_INVALID_OUTPUT' | 'BUDGET_EXHAUSTED' | 'INTENT_UNSUPPORTED' }> {
    const first = await this.call(purpose, messages, signal)
    if (!first.ok) return first
    const parsed = this.parse(schema, first.text)
    if (parsed.ok) return parsed
    if (!allowRepair || this.used >= this.access.maxCallsPerTurn) {
      return { ok: false, code: 'MODEL_INVALID_OUTPUT', message: parsed.message }
    }
    const repaired = await this.call(`${purpose}-repair`, [
      ...messages,
      { role: 'user', content: `上一次输出无法通过契约：${parsed.message}。请只输出合法 JSON。` },
    ], signal)
    if (!repaired.ok) return repaired
    const repairedParsed = this.parse(schema, repaired.text)
    if (!repairedParsed.ok) {
      return { ok: false, code: 'MODEL_INVALID_OUTPUT', message: repairedParsed.message }
    }
    return repairedParsed
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
  ): Promise<{ ok: true; text: string } | { ok: false; message: string; code: 'MODEL_UNAVAILABLE' | 'MODEL_TIMEOUT' | 'BUDGET_EXHAUSTED' }> {
    if (this.used >= this.access.maxCallsPerTurn) {
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: '本轮模型调用次数已用尽' }
    }
    if (Date.now() >= this.access.deadlineAt.getTime()) {
      return { ok: false, code: 'MODEL_TIMEOUT', message: '本轮模型时间已用尽' }
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
        onThinkingDelta: () => {
          if (!this.thinkingStartedAt) this.thinkingStartedAt = Date.now()
        },
      })
      if (result.reasoningText && !this.thinkingStartedAt) {
        this.thinkingStartedAt = started
      }
      if (this.thinkingStartedAt) {
        this.thinkingDurationMs += Date.now() - this.thinkingStartedAt
        this.thinkingStartedAt = undefined
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
      if (this.thinkingStartedAt) {
        this.thinkingDurationMs += Date.now() - this.thinkingStartedAt
        this.thinkingStartedAt = undefined
      }
      const errMsg = error instanceof Error ? error.message : '模型调用失败'
      const isTimeout = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('deadline')
      const code: 'MODEL_TIMEOUT' | 'MODEL_UNAVAILABLE' = isTimeout ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE'
      await recordPlatformAiCall(this.db, {
        turnId: this.turnId,
        ownerAccountId: this.ownerAccountId,
        seq: this.used,
        purpose,
        configRevision: this.access.revision,
        model: this.access.model,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        reservedTokens: this.access.maxOutputTokens,
        error: errMsg,
        durationMs: Date.now() - started,
      }).catch(() => undefined)
      return { ok: false, code, message: errMsg }
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

export const modelAuthoringOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('insert_step'),
    id: z.string().min(1).max(128),
    step: z.looseObject({
      id: z.string().optional(),
      name: z.string().trim().min(1).max(128),
      type: z.string(),
      effectType: z.enum(['READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT']).optional(),
      input: z.record(z.string(), z.unknown()),
      outputKey: z.string().optional(),
    }),
    parentBlockId: z.string().optional(),
    branchKey: z.enum(['then', 'else', 'body']).optional(),
    anchorStepId: z.string().nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal('update_step'),
    id: z.string().min(1).max(128),
    stepId: z.string().min(1).max(128),
    patch: z.strictObject({
      name: z.string().trim().min(1).max(128).optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      outputKey: z.string().optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal('remove_step'),
    id: z.string().min(1).max(128),
    stepId: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal('move_step'),
    id: z.string().min(1).max(128),
    stepId: z.string().min(1).max(128),
    parentBlockId: z.string().optional(),
    branchKey: z.enum(['then', 'else', 'body']).optional(),
    anchorStepId: z.string().nullable().optional(),
  }),
])
export type ModelAuthoringOperation = z.infer<typeof modelAuthoringOperationSchema>

export const modelAuthoringProposalOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('proposal'),
    operations: z.array(modelAuthoringOperationSchema).min(1).max(4),
    intentCoverage: z
      .array(
        z.strictObject({
          intentId: z.string().min(1).max(128),
          operationIds: z.array(z.string().min(1).max(128)),
        }),
      )
      .default([]),
  }),
  z.strictObject({
    kind: z.literal('clarify'),
    question: z.string().min(1).max(512),
    missingFields: z.array(z.string().min(1).max(64)).default([]),
  }),
  z.strictObject({
    kind: z.literal('unsupported'),
    reasonCode: z.string().min(1).max(64),
    message: z.string().min(1).max(512),
  }),
])
export type ModelAuthoringProposalOutput = z.infer<typeof modelAuthoringProposalOutputSchema>

export async function generateScenarioAuthoringProposal(
  session: AssistantModelSession,
  question: string,
  facts: unknown,
  signal?: AbortSignal,
): Promise<{ output?: ModelAuthoringProposalOutput; error?: string; errorCode?: string }> {
  const result = await session.completeJson(
    'authoring-propose',
    modelAuthoringProposalOutputSchema,
    [
      {
        role: 'system',
        content: `你是识途助手的场景编排助手。
请根据用户的指令和当前场景结构化上下文，给出严格受限的结构化编排操作（AuthoringOperation）。

【操作类型规范】
1. insert_step: 新增步骤
   - 必须提供 step 对象（包含 id, name, type, input）
   - 可选 parentBlockId、branchKey（在流程控制块内部时指定）
   - 可选 anchorStepId（在其之后插入；若为 null 则插入到该分支开头）
2. update_step: 修改已有步骤
   - 必须提供 stepId
   - patch 仅允许包含: name, input, outputKey
   - 保留其他未提及属性，不改变步骤类型，不降低风险等级
3. remove_step: 删除已有步骤
   - 必须提供 stepId
   - 仅当该步骤产出的输出未被后续步骤或场景输出引用时允许删除
4. move_step: 步骤同分支重排
   - 必须提供 stepId
   - 必须在同一父块和分支内移动（禁止跨分支移动）
   - 可选 anchorStepId（移至该锚点步骤之后；若为 null 则移至分支开头）

【受限步骤类型与字段表】
仅允许对以下独立步骤类型执行操作：
- navigate: input 仅限 url
- click: input 仅限 target
- fill: input 仅限 target, from, fromField (敏感字段严禁直接生成字面口令 value，必须引用已声明输入或前序输出 from)
- extract: input 仅限 target, as, attribute, many；可设置 outputKey
- assert: input 仅限 target, expect
- select: input 仅限 target, value, label
- keyboard: input 仅限 target, key
- wait: input 仅限 kind, target, condition, timeoutMs, durationMs, urlPattern, text
- ai_action: input 仅限 instruction
- ai_extract: input 仅限 instruction, schema；可设置 outputKey
- ai_assert: input 仅限 instruction

【目标知识地图】
- 用户上下文中的 targetKnowledge 提供已观测页面、菜单路径、元素定位与资产引用；优先使用与意图匹配且定位稳定的元素。
- 只有元素的 assetRef 为非空时，才可在 input.target.assetRef 中引用它；同时复制该元素的 locator 到 input.target 的 framePath/candidates。
- 不得编造页面 URL、assetRef 或定位候选；无匹配证据时返回 clarify。
- unsafeAction 标记只说明该按钮可能有副作用，不得将对应步骤声明为 READ_ONLY。

【单轮规模硬约束】
- 单次提议最多包含 4 项操作，其中最多 2 项新增步骤。
- 若无法一次完成，必须返回 clarify 要求缩小范围。

【歧义与越界处理】
- 若用户指令模糊（如“把这条指令写清楚”、“处理一下”）且没有明确业务目标，禁止自造“写清楚”文字，必须输出 clarify 澄清业务目标。
- 若涉及两个同名步骤且未明确选中哪一个，必须输出 clarify。
- 若缺少断言预期、缺少点击目标、或引用了不存在的输入/输出，必须输出 clarify 说明缺少项。
- 若要求新建控制块拓扑、模块定义或改写成功条件，必须输出 unsupported 并说明本轮不支持此类操作。
- 若要求降低风险级别（如付款标为 READ_ONLY）或增加重试，必须输出 unsupported。

【输出 JSON 格式】
成功提议：
{
  "kind": "proposal",
  "operations": [ ... ],
  "intentCoverage": [ { "intentId": "子意图描述", "operationIds": ["对应操作id"] } ]
}
需要澄清：
{
  "kind": "clarify",
  "question": "澄清问题描述",
  "missingFields": ["缺失字段名"]
}
不支持的操作：
{
  "kind": "unsupported",
  "reasonCode": "错误代码",
  "message": "不支持原因说明"
}`,
      },
      { role: 'user', content: JSON.stringify({ question, facts }) },
    ],
    signal,
    true,
  )

  if (!result.ok) {
    return { error: result.message, errorCode: (result as any).code ?? 'MODEL_INVALID_OUTPUT' }
  }
  return { output: result.value }
}
