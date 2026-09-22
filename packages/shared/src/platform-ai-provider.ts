import {
  modelServiceOrigin,
  PLATFORM_AI_PROVIDERS,
  PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE,
  PLATFORM_AI_THINKING_UNSUPPORTED_PROVIDERS,
  type PlatformAiProvider,
  type PlatformAiThinkingMode,
  type PlatformAiThinkingUnsupportedProvider,
} from './platform-config.js'

export const PLATFORM_AI_THINKING_UNSUPPORTED = 'PLATFORM_AI_THINKING_UNSUPPORTED' as const
export const PLATFORM_AI_OUTPUT_LIMIT = 256_000
export const PLATFORM_AI_OUTPUT_LIMIT_CODE = 'PLATFORM_AI_OUTPUT_LIMIT' as const

export type PlatformAiModelPreset = { id: string; hint: string }

/**
 * 各提供商的官方地址与常用模型（2026-09 按各家官方文档核对）。
 * 模型名在存储层仍是自由字符串——中转站、灰度模型可选「自定义」——这里只提供下拉候选。
 * 每家第一个模型即选中该提供商时的默认模型。
 */
export const PLATFORM_AI_PROVIDER_PRESETS: Record<
  PlatformAiProvider,
  { label: string; defaultBaseUrl: string; models: readonly PlatformAiModelPreset[] }
> = {
  glm: {
    label: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.3', hint: '最新旗舰' },
      { id: 'glm-5.2', hint: '上一代旗舰' },
      { id: 'glm-4.7', hint: '均衡' },
      { id: 'glm-4.7-flash', hint: '免费，轻量' },
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-flash', hint: '快速低价' },
      { id: 'deepseek-v4-pro', hint: '高质量' },
    ],
  },
  qwen: {
    label: '通义千问',
    // 百炼推荐改用带 WorkspaceId 的专属域名，但那需要用户自己的 ID，无法出厂预填；旧域名官方确认仍可用。
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-flash', hint: '快速低价' },
      { id: 'qwen3.8-max', hint: '旗舰' },
      { id: 'qwen3.7-plus', hint: '均衡' },
      { id: 'qwen3.7-flash', hint: '快速低价' },
    ],
  },
  minimax: {
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.cn/v1',
    models: [
      { id: 'MiniMax-M3', hint: '最新' },
      { id: 'MiniMax-M2.7', hint: '上一代' },
      { id: 'MiniMax-M2.5', hint: '更早一代' },
    ],
  },
}

export function platformAiDefaultModel(provider: PlatformAiProvider): string {
  return PLATFORM_AI_PROVIDER_PRESETS[provider].models[0]!.id
}

export function isPlatformAiPresetModel(provider: PlatformAiProvider, model?: string): boolean {
  return Boolean(model) && PLATFORM_AI_PROVIDER_PRESETS[provider].models.some((item) => item.id === model)
}

/**
 * 切换提供商时的模型：空值或仍是上一家的候选模型就换成新提供商的默认；
 * 用户手填的自定义模型名（中转站别名等）原样保留，与 nextPlatformAiBaseUrl 同一规则。
 */
export function nextPlatformAiModel(input: {
  previousProvider?: PlatformAiProvider
  currentModel?: string
  nextProvider: PlatformAiProvider
}): string {
  if (!PLATFORM_AI_PROVIDER_PRESETS[input.nextProvider]) return input.currentModel ?? ''
  if (!input.currentModel) return platformAiDefaultModel(input.nextProvider)
  if (input.previousProvider && isPlatformAiPresetModel(input.previousProvider, input.currentModel)) {
    return platformAiDefaultModel(input.nextProvider)
  }
  return input.currentModel
}

export type PlatformAiConnectionFields = {
  baseUrl?: string
  model?: string
  secretRef?: { secretId: string }
  provider?: PlatformAiProvider
}

export function platformAiConnectionReady(ai: PlatformAiConnectionFields): boolean {
  return Boolean(ai.baseUrl && ai.model && ai.secretRef && ai.provider)
}

export function platformAiThinkingUnsupported(
  provider: PlatformAiProvider | undefined,
): provider is PlatformAiThinkingUnsupportedProvider {
  return (
    provider !== undefined &&
    (PLATFORM_AI_THINKING_UNSUPPORTED_PROVIDERS as readonly string[]).includes(provider)
  )
}

export function platformAiChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL('chat/completions', base).toString()
}

function pathnameOf(url: string): string {
  return new URL(url).pathname.replace(/\/$/, '')
}

export function platformAiBaseUrlsEquivalent(left?: string, right?: string): boolean {
  if (!left || !right) return false
  try {
    return modelServiceOrigin(left) === modelServiceOrigin(right) && pathnameOf(left) === pathnameOf(right)
  } catch {
    return false
  }
}

export function isPlatformAiPresetBaseUrl(provider: PlatformAiProvider, url?: string): boolean {
  return platformAiBaseUrlsEquivalent(url, PLATFORM_AI_PROVIDER_PRESETS[provider].defaultBaseUrl)
}

export function nextPlatformAiBaseUrl(input: {
  previousProvider?: PlatformAiProvider
  currentUrl?: string
  nextProvider: PlatformAiProvider
}): string {
  const preset = PLATFORM_AI_PROVIDER_PRESETS[input.nextProvider]
  if (!preset) return input.currentUrl ?? ''
  const nextDefault = preset.defaultBaseUrl
  if (!input.currentUrl) return nextDefault
  if (input.previousProvider && isPlatformAiPresetBaseUrl(input.previousProvider, input.currentUrl)) {
    return nextDefault
  }
  return input.currentUrl
}

export type PlatformAiChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export function buildPlatformAiChatBody(input: {
  provider: PlatformAiProvider
  thinkingMode: PlatformAiThinkingMode
  model: string
  messages: PlatformAiChatMessage[]
  maxTokens: number
  json?: boolean
}): Record<string, unknown> {
  if (input.thinkingMode === 'on' && platformAiThinkingUnsupported(input.provider)) {
    throw Object.assign(new Error(PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE), {
      code: PLATFORM_AI_THINKING_UNSUPPORTED,
    })
  }
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    max_tokens: input.maxTokens,
    temperature: 0,
  }
  if (input.json) body.response_format = { type: 'json_object' }
  if (input.provider === 'qwen') body.enable_thinking = false
  if ((input.provider === 'glm' || input.provider === 'deepseek') && input.thinkingMode === 'on') {
    body.thinking = { type: 'enabled' }
  }
  return body
}

export type PlatformAiChatRead = {
  text: string
  reasoningText?: string
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export function readPlatformAiChatResult(body: unknown, mode: 'business' | 'probe'): PlatformAiChatRead {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('模型没有返回可用结果')
  }
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.choices)) {
    throw new Error('模型没有返回可用结果')
  }
  const message = (record.choices[0] as { message?: Record<string, unknown> } | undefined)?.message
  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  const reasoningText =
    typeof message?.reasoning_content === 'string' ? message.reasoning_content.trim() : ''
  const usage =
    record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
      ? (record.usage as Record<string, unknown>)
      : undefined
  if (mode === 'business' && !text) {
    throw new Error(
      reasoningText
        ? '模型没有返回可用文本：正文为空，推理内容不能作为结果。请关闭思考模式或更换模型。'
        : '模型没有返回可用文本',
    )
  }
  return {
    text,
    reasoningText: reasoningText || undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
    usage: usage
      ? {
          promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
          completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        }
      : undefined,
  }
}

function concatBytes(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(out)
}

export async function postPlatformAiChatCompletion(input: {
  baseUrl: string
  apiKey: string
  body: Record<string, unknown>
  timeoutMs: number
  signal?: AbortSignal
}): Promise<unknown> {
  const signals = [AbortSignal.timeout(input.timeoutMs), input.signal].filter(
    (value): value is AbortSignal => Boolean(value),
  )
  const response = await fetch(platformAiChatCompletionsUrl(input.baseUrl), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.any(signals),
  })
  if (!response.ok) {
    throw new Error(`模型服务返回 HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('模型没有返回可用结果')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > PLATFORM_AI_OUTPUT_LIMIT) {
        throw Object.assign(new Error('模型输出超过 256KB 上限'), {
          code: PLATFORM_AI_OUTPUT_LIMIT_CODE,
        })
      }
      chunks.push(item.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  try {
    return JSON.parse(concatBytes(chunks)) as unknown
  } catch {
    throw new Error('模型没有返回可用结果')
  }
}

export { PLATFORM_AI_PROVIDERS }
