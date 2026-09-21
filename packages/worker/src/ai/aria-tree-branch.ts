import type { Page } from 'playwright'
import {
  parseAiOutput,
  type AiCommand,
  type AiResult,
} from '@cairn/shared'
import { getAriaSnapshot } from '../browser/aria-snapshot.js'
import type { OpenAiLike } from './midscene/model-client.js'

/**
 * 原生 Fetch 构造的轻量 OpenAI 兼容客户端（用于无图语义树分支，无需 Midscene agent）。
 */
export function createDirectOpenAiClient(input: { baseUrl: string; apiKey: string }): OpenAiLike {
  const base = input.baseUrl.replace(/\/+$/, '')
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  return {
    chat: {
      completions: {
        create: async (params: unknown, options?: { signal?: AbortSignal }) => {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${input.apiKey}`,
            },
            body: JSON.stringify(params),
            signal: options?.signal,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            const error = new Error(`Model API error HTTP ${res.status}: ${body}`)
            ;(error as unknown as { status?: number }).status = res.status
            throw error
          }
          return await res.json()
        },
      },
    },
  }
}

export const DEFAULT_VISUAL_KEYWORDS: readonly string[] = [
  '位置',
  '颜色',
  '图标',
  '遮挡',
  '对齐',
  '样式',
  '红',
  '绿',
  '蓝',
  '黄',
  '居中',
  '高亮',
  '左边',
  '右边',
  '上方',
  '下方',
  '重叠',
  '透明',
  '粗体',
  '字体',
  '背景',
  '间距',
  '边框',
  '隐藏',
  '遮盖',
  '显示在',
  '排在',
  '字号',
  '尺寸',
  '大小',
]

export interface AriaBranchAdmissionOptions {
  command: AiCommand
  preferAriaTree?: boolean
  hasSensitiveSelectors?: boolean
  visualKeywords?: readonly string[]
}

export interface AriaBranchAdmissionResult {
  admitted: boolean
  reason?: string
}

/**
 * 语义树分支准入检查（完全确定性，不消耗模型）。
 * 必须全部满足才尝试语义树优先分支，任一不满足立即回退或走常规视觉路径。
 */
export function isAriaBranchAdmitted(options: AriaBranchAdmissionOptions): AriaBranchAdmissionResult {
  // 1. 步骤类型必须是 ai_assert 或 ai_extract（ai_action 永不进入）
  if (options.command.type !== 'ai_assert' && options.command.type !== 'ai_extract') {
    return { admitted: false, reason: `step_type_unsupported: ${options.command.type}` }
  }

  // 2. 策略开关必须开启（出厂默认关闭）
  if (!options.preferAriaTree) {
    return { admitted: false, reason: 'policy_disabled' }
  }

  // 3. 敏感选择器守卫（PAS-P3 未通过前严格阻断）
  if (options.hasSensitiveSelectors) {
    return { admitted: false, reason: 'has_sensitive_selectors' }
  }

  // 4. 视觉关键词过滤
  const instruction = options.command.instruction ?? ''
  const keywords = options.visualKeywords ?? DEFAULT_VISUAL_KEYWORDS
  for (const kw of keywords) {
    if (instruction.includes(kw)) {
      return { admitted: false, reason: `contains_visual_keyword: ${kw}` }
    }
  }

  return { admitted: true }
}

/**
 * 机械核对引用行（Citations Mechanical Verification）。
 * 规则：
 * 1. citations 必须为非空数组；
 * 2. 其中的每一行必须逐字存在于无障碍树快照中；
 * 3. 满足条件才返回 true，否则一律返回 false（导致回退）。
 */
export function verifyCitations(citations: unknown, snapshotText: string): boolean {
  if (!Array.isArray(citations) || citations.length === 0) return false
  const snapshotLines = snapshotText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const rawCitation of citations) {
    if (typeof rawCitation !== 'string') return false
    const citationLines = rawCitation
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (citationLines.length === 0) return false

    for (const trimmed of citationLines) {
      // 检查是否能在快照行中找到完全匹配或作为快照某一行的完整子串
      const matched = snapshotLines.some(
        (line) => line === trimmed || line.includes(trimmed) || trimmed.includes(line),
      )
      if (!matched) return false
    }
  }
  return true
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 校验提取结果中所有文本和数值字段是否能在快照中溯源。
 * 若有任一字符串或数值无法在快照中找到对应原文，返回 false。
 */
export function verifyExtractionProvenance(output: unknown, snapshotText: string): boolean {
  if (typeof output === 'string') {
    const trimmed = output.trim()
    return trimmed.length === 0 || snapshotText.includes(trimmed)
  }
  if (typeof output === 'number') {
    const numStr = String(output)
    const regex = new RegExp(`(?<!\\d)${escapeRegex(numStr)}(?!\\d)`)
    return regex.test(snapshotText)
  }
  if (typeof output === 'boolean' || output === null || output === undefined) {
    return true
  }
  if (Array.isArray(output)) {
    return output.every((item) => verifyExtractionProvenance(item, snapshotText))
  }
  if (typeof output === 'object') {
    return Object.values(output as Record<string, unknown>).every((value) =>
      verifyExtractionProvenance(value, snapshotText),
    )
  }
  return true
}

export function buildAriaAssertPrompt(instruction: string, snapshotText: string): {
  system: string
  user: string
} {
  const system = `你是一个严格的无障碍语义树（Aria Snapshot）断言分析引擎。
你的职责是依据用户提供的页面无障碍树结构，客观判断给定的断言条件是否成立。
无障碍树中 heading 节点代表页面或区块标题（一级标题 level=1 通常为页面标题），button 对应按钮，link 对应链接，textbox 对应输入框，combobox 对应下拉选择/选择字段等。

【判定规则】
1. 只依据所提供的无障碍树内容判断，绝对不要主观臆测、脑补或假设树中未列出的信息。
2. 如果无障碍树中的内容足以确凿证明断言成立，输出 verdict: "pass"。
3. 如果无障碍树中的内容足以确凿证明断言不成立，输出 verdict: "fail"。
4. 如果断言涉及无法在无障碍树中确定的视觉属性（例如颜色、像素位置、图标外观、遮挡关系等），或者树中信息不足以做出确凿结论，必须输出 verdict: "undecidable"。
5. citations: 必须提供你做出判断所依据的无障碍树中的完整文本行（精确逐字引用）。无论是 "pass" 还是 "fail"，都必须至少包含一条有效且真实的引用行；如果是 "undecidable"，citations 可以为空。

【输出格式】
必须严格输出合法的 JSON 对象，格式如下：
{
  "verdict": "pass" | "fail" | "undecidable",
  "citations": ["无障碍树中的原文本行1", "无障碍树中的原文本行2"],
  "reason": "简明判定理由"
}`

  const user = `【无障碍树快照】
${snapshotText}

【断言条件】
${instruction}`

  return { system, user }
}

export function buildAriaExtractPrompt(
  instruction: string,
  snapshotText: string,
  schema: unknown,
): {
  system: string
  user: string
} {
  const schemaStr = JSON.stringify(schema, null, 2)
  const system = `你是一个严格的无障碍语义树（Aria Snapshot）数据提取分析引擎。
你的职责是依据用户提供的页面无障碍树结构，按照给定的数据 Schema 提取信息。

【提取规则】
1. 只依据所提供的无障碍树内容提取，绝对不要编造或推测。
2. 提取的所有文本和数值，必须能在无障碍树快照中找到完全一致的原文字符。
3. 如果无障碍树中缺失关键字段或无法提取，必须返回 {"ok": false, "reason": "无法从无障碍树中提取所需字段"}。
4. 如果提取成功，返回 {"ok": true, "data": <符合 Schema 的提取对象>}。

【Schema 要求】
${schemaStr}

【输出格式】
必须严格输出合法的 JSON 对象：
{"ok": true, "data": { ... }} 或 {"ok": false, "reason": "..."}`

  const user = `【无障碍树快照】
${snapshotText}

【提取指令】
${instruction}`

  return { system, user }
}

export interface AriaBranchExecutionResult {
  handled: boolean
  fallbackReason?: string
  result?: AiResult
  snapshot?: string
  citations?: string[]
}

/**
 * 在页面上尝试语义树断言分支。
 */
export async function tryAriaAssertBranch(input: {
  page: Page
  command: AiCommand
  client: OpenAiLike
  modelName: string
  modelFamily?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<AriaBranchExecutionResult> {
  // 提取无障碍树快照（受管会话中调用，已自动完成脱敏和长度保护）
  const snapshotRes = await getAriaSnapshot(input.page, {
    timeoutMs: Math.min(input.timeoutMs, 5000),
    mode: 'default',
    signal: input.signal,
  })

  // 准入规则 5：快照被截断时，语义树分支直接回退
  if (snapshotRes.truncated) {
    return { handled: false, fallbackReason: 'snapshot_truncated' }
  }

  const prompt = buildAriaAssertPrompt(input.command.instruction!, snapshotRes.text)

  const isReasoningFamily =
    input.modelFamily?.includes('doubao') ||
    input.modelFamily?.includes('deepseek') ||
    input.modelName.includes('seed') ||
    input.modelName.includes('r1')

  let completion: unknown
  try {
    completion = await input.client.chat.completions.create(
      {
        model: input.modelName,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.1,
        ...(isReasoningFamily ? { thinking: { type: 'disabled' } } : {}),
      },
      { signal: input.signal ?? AbortSignal.timeout(input.timeoutMs) },
    )
  } catch (error) {
    return {
      handled: false,
      fallbackReason: `model_call_error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const content = extractCompletionContent(completion)
  if (!content) {
    return { handled: false, fallbackReason: 'empty_model_response' }
  }

  const parsed = parseJsonSafe<{ verdict?: string; citations?: unknown; reason?: string }>(content)
  if (!parsed) {
    return { handled: false, fallbackReason: 'malformed_json_response' }
  }

  if (parsed.verdict === 'undecidable') {
    return {
      handled: false,
      fallbackReason: `model_undecidable: ${parsed.reason ?? '无障碍树无法判定，需视觉回退'}`,
      snapshot: snapshotRes.text,
    }
  }

  if (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') {
    return {
      handled: false,
      fallbackReason: `invalid_verdict: ${String(parsed.verdict)}`,
      snapshot: snapshotRes.text,
    }
  }

  // 机械核对 citations
  const citationsValid = verifyCitations(parsed.citations, snapshotRes.text)
  if (!citationsValid) {
    return {
      handled: false,
      fallbackReason: 'citations_verification_failed',
      snapshot: snapshotRes.text,
    }
  }

  const passed = parsed.verdict === 'pass'
  const reason = parsed.reason ?? (passed ? '条件成立' : '条件不成立')
  const citations = Array.isArray(parsed.citations) ? (parsed.citations as string[]) : []

  return {
    handled: true,
    result: {
      ok: true,
      output: {
        passed,
        reason,
        citations,
        route: 'aria_text',
      },
      summary: reason,
    },
    snapshot: snapshotRes.text,
    citations,
  }
}

/**
 * 在页面上尝试语义树提取分支。
 */
export async function tryAriaExtractBranch(input: {
  page: Page
  command: AiCommand
  client: OpenAiLike
  modelName: string
  modelFamily?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<AriaBranchExecutionResult> {
  const schema = input.command.outputSchema
  if (!schema) {
    return { handled: false, fallbackReason: 'missing_output_schema' }
  }

  const snapshotRes = await getAriaSnapshot(input.page, {
    timeoutMs: Math.min(input.timeoutMs, 5000),
    mode: 'default',
    signal: input.signal,
  })

  if (snapshotRes.truncated) {
    return { handled: false, fallbackReason: 'snapshot_truncated' }
  }

  const prompt = buildAriaExtractPrompt(input.command.instruction!, snapshotRes.text, schema)

  const isReasoningFamily =
    input.modelFamily?.includes('doubao') ||
    input.modelFamily?.includes('deepseek') ||
    input.modelName.includes('seed') ||
    input.modelName.includes('r1')

  let completion: unknown
  try {
    completion = await input.client.chat.completions.create(
      {
        model: input.modelName,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.1,
        ...(isReasoningFamily ? { thinking: { type: 'disabled' } } : {}),
      },
      { signal: input.signal ?? AbortSignal.timeout(input.timeoutMs) },
    )
  } catch (error) {
    return {
      handled: false,
      fallbackReason: `model_call_error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const content = extractCompletionContent(completion)
  if (!content) {
    return { handled: false, fallbackReason: 'empty_model_response' }
  }

  const parsed = parseJsonSafe<{ ok?: boolean; data?: unknown; reason?: string }>(content)
  if (!parsed) {
    return { handled: false, fallbackReason: 'malformed_json_response' }
  }

  if (!parsed.ok || parsed.data === undefined) {
    return {
      handled: false,
      fallbackReason: `extract_failed_or_undecidable: ${parsed.reason ?? '未提取到有效数据'}`,
      snapshot: snapshotRes.text,
    }
  }

  // Schema 严格校验
  const schemaValidation = parseAiOutput(parsed.data, schema)
  if (!schemaValidation.ok) {
    return {
      handled: false,
      fallbackReason: `schema_validation_failed: ${schemaValidation.message}`,
      snapshot: snapshotRes.text,
    }
  }

  // 溯源校验：提取出的所有文本和数值必须能在快照中找到
  const provenanceValid = verifyExtractionProvenance(schemaValidation.value, snapshotRes.text)
  if (!provenanceValid) {
    return {
      handled: false,
      fallbackReason: 'extraction_provenance_failed',
      snapshot: snapshotRes.text,
    }
  }

  return {
    handled: true,
    result: {
      ok: true,
      output: schemaValidation.value,
      summary: '数据提取成功',
    },
    snapshot: snapshotRes.text,
  }
}

function extractCompletionContent(completion: unknown): string | null {
  if (!completion || typeof completion !== 'object') return null
  const choices = (completion as { choices?: Array<{ message?: { content?: unknown } }> }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const content = choices[0]?.message?.content
  return typeof content === 'string' ? content : null
}

function parseJsonSafe<T>(raw: string): T | null {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  }
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0]) as T
      } catch {
        return null
      }
    }
    return null
  }
}
