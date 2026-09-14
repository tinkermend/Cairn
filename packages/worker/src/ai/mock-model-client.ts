import type { OpenAiLike } from './midscene/model-client.js'
import type {
  IModelClient,
  ModelCompletionOptions,
  ModelCompletionResult,
  ModelMessage,
} from './model-types.js'

export type ChaosConfig = {
  /** 延迟毫秒数，若设置可结合 signal 模拟超时 */
  delayMs?: number
  /** 是否直接抛出超时异常 */
  timeout?: boolean
  /** 模拟 429 限流，包含可选的 retryAfterSeconds */
  rateLimit?: {
    retryAfterSeconds?: number
    message?: string
  }
  /** 模拟输出损坏的非合法 JSON 字符串 */
  malformedJson?: boolean
  /** 模拟大模型幻觉（返回不存在的选择器或非法 Schema） */
  hallucination?: {
    kind: 'non_existent_element' | 'invalid_schema'
    details?: unknown
  }
  /** 直接抛出指定的自定义异常 */
  customError?: Error
  /** 若为 true，仅在第 1 次调用时触发注入，后续重试调用自动恢复正常 */
  once?: boolean
}

export type MockModelCall = {
  callNumber: number
  params: unknown
  timestamp: Date
}

export class ModelClientError extends Error {
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(message: string, options?: { status?: number; retryAfterSeconds?: number }) {
    super(message)
    this.name = 'ModelClientError'
    this.status = options?.status
    this.retryAfterSeconds = options?.retryAfterSeconds
  }
}

/**
 * 结构化构建符合 OpenAI chat completion 规范的响应对象
 */
export function buildChatCompletionResponse(content: string, options?: { model?: string; finishReason?: string }): unknown {
  return {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: options?.model ?? 'cairn-mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: options?.finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50,
    },
  }
}

/**
 * 识途通用 MockModelClient：
 * 1. 符合 OpenAiLike 契约；
 * 2. 符合通用 IModelClient SPI；
 * 3. 具备 Chaos 故障注入能力（超时、429、损坏 JSON、Schema 幻觉）；
 * 4. 支持队列响应、自定义逻辑与调用历史回溯。
 */
export class MockModelClient implements OpenAiLike, IModelClient {
  private _calls: MockModelCall[] = []
  private _chaos?: ChaosConfig
  private _chaosTriggered = false
  private _responseQueue: unknown[] = []
  private _defaultResponse: unknown = buildChatCompletionResponse(JSON.stringify({ ok: true }))
  private _customHandler?: (params: unknown, callNumber: number) => Promise<unknown> | unknown

  constructor(options?: {
    chaos?: ChaosConfig
    defaultResponse?: unknown
    handler?: (params: unknown, callNumber: number) => Promise<unknown> | unknown
  }) {
    this._chaos = options?.chaos
    if (options?.defaultResponse !== undefined) {
      this._defaultResponse = options.defaultResponse
    }
    this._customHandler = options?.handler
  }

  get calls(): readonly MockModelCall[] {
    return this._calls
  }

  get callCount(): number {
    return this._calls.length
  }

  setChaos(chaos: ChaosConfig | undefined): void {
    this._chaos = chaos
    this._chaosTriggered = false
  }

  enqueueResponse(response: unknown): void {
    this._responseQueue.push(response)
  }

  enqueueTextResponse(content: string): void {
    this._responseQueue.push(buildChatCompletionResponse(content))
  }

  enqueueJsonResponse(data: unknown): void {
    this._responseQueue.push(buildChatCompletionResponse(JSON.stringify(data)))
  }

  reset(): void {
    this._calls = []
    this._responseQueue = []
    this._chaosTriggered = false
  }

  readonly chat = {
    completions: {
      create: async (params: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
        const callNumber = this._calls.length + 1
        this._calls.push({
          callNumber,
          params,
          timestamp: new Date(),
        })

        const shouldInjectChaos = this._chaos && (!this._chaos.once || !this._chaosTriggered)
        if (shouldInjectChaos && this._chaos) {
          this._chaosTriggered = true

          if (this._chaos.delayMs && this._chaos.delayMs > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, this._chaos!.delayMs)
              if (options?.signal) {
                options.signal.addEventListener('abort', () => {
                  clearTimeout(timer)
                  reject(new Error('AbortError: The operation was aborted'))
                }, { once: true })
              }
            })
          }

          if (options?.signal?.aborted) {
            throw new Error('AbortError: The operation was aborted')
          }

          if (this._chaos.timeout) {
            throw new ModelClientError('Model request timed out', { status: 408 })
          }

          if (this._chaos.rateLimit) {
            throw new ModelClientError(
              this._chaos.rateLimit.message ?? 'Rate limit exceeded, please retry later.',
              { status: 429, retryAfterSeconds: this._chaos.rateLimit.retryAfterSeconds ?? 2 },
            )
          }

          if (this._chaos.customError) {
            throw this._chaos.customError
          }

          if (this._chaos.malformedJson) {
            return buildChatCompletionResponse('{ "status": "incomplete", "partialAction": ')
          }

          if (this._chaos.hallucination) {
            if (this._chaos.hallucination.kind === 'non_existent_element') {
              return buildChatCompletionResponse(
                JSON.stringify({
                  action: 'click',
                  target: { selector: '#ghost-element-never-exists' },
                }),
              )
            }
            if (this._chaos.hallucination.kind === 'invalid_schema') {
              return buildChatCompletionResponse(
                JSON.stringify(this._chaos.hallucination.details ?? { wrongField: 12345 }),
              )
            }
          }
        }

        if (this._customHandler) {
          return this._customHandler(params, callNumber)
        }

        if (this._responseQueue.length > 0) {
          return this._responseQueue.shift()
        }

        return this._defaultResponse
      },
    },
  }

  async complete(
    messages: ModelMessage[],
    options?: ModelCompletionOptions,
  ): Promise<ModelCompletionResult> {
    const raw = await this.chat.completions.create(
      {
        messages,
        model: options?.model ?? 'cairn-mock-model',
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        response_format: options?.responseFormat,
      },
      { signal: options?.signal },
    )

    const typedRaw = raw as {
      model?: string
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }

    const content = typedRaw.choices?.[0]?.message?.content ?? ''
    const model = typedRaw.model ?? options?.model ?? 'cairn-mock-model'
    const usage = typedRaw.usage
      ? {
          promptTokens: typedRaw.usage.prompt_tokens ?? 0,
          completionTokens: typedRaw.usage.completion_tokens ?? 0,
          totalTokens: typedRaw.usage.total_tokens ?? 0,
        }
      : undefined

    return {
      content,
      model,
      usage,
      rawResponse: raw,
    }
  }
}
