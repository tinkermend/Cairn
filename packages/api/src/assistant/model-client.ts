import {
  buildPlatformAiChatBody,
  postPlatformAiChatCompletion,
  readPlatformAiChatResult,
  streamPlatformAiChatCompletion,
  type PlatformAiProvider,
  type PlatformAiThinkingMode,
} from '@cairn/shared'

export type PlatformModelMessage = { role: 'system' | 'user'; content: string }

export type PlatformModelResult = {
  text: string
  reasoningText?: string
  model: string
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export type PlatformModelClient = {
  complete(input: {
    baseUrl: string
    apiKey: string
    model: string
    provider: PlatformAiProvider
    thinkingMode: PlatformAiThinkingMode
    messages: PlatformModelMessage[]
    maxTokens: number
    timeoutMs: number
    json?: boolean
    signal?: AbortSignal
    onThinkingDelta?: (delta: string) => void
    stream?: boolean
  }): Promise<PlatformModelResult>
}

export function createOpenAiCompatibleClient(): PlatformModelClient {
  return {
    async complete(input) {
      const body = buildPlatformAiChatBody({
        provider: input.provider,
        thinkingMode: input.thinkingMode,
        model: input.model,
        messages: input.messages,
        maxTokens: input.maxTokens,
        json: input.json,
      })

      if (input.stream || input.onThinkingDelta) {
        try {
          const streamed = await streamPlatformAiChatCompletion({
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            body,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
            onChunk: (chunk) => {
              if (chunk.reasoningDelta) {
                input.onThinkingDelta?.(chunk.reasoningDelta)
              }
            },
          })
          if (streamed.text) {
            return {
              text: streamed.text,
              reasoningText: streamed.reasoningText,
              model: streamed.model ?? input.model,
              finishReason: streamed.finishReason,
              usage: streamed.usage,
            }
          }
        } catch (streamErr) {
          if (input.signal?.aborted) throw streamErr
          // Fall through to non-streaming fallback
        }
      }

      const raw = await postPlatformAiChatCompletion({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        body,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      })
      const result = readPlatformAiChatResult(raw, 'business')
      return {
        text: result.text,
        reasoningText: result.reasoningText,
        model: result.model ?? input.model,
        finishReason: result.finishReason,
        usage: result.usage,
      }
    },
  }
}
