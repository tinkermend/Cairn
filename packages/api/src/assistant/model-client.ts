import {
  buildPlatformAiChatBody,
  postPlatformAiChatCompletion,
  readPlatformAiChatResult,
  type PlatformAiProvider,
  type PlatformAiThinkingMode,
} from '@cairn/shared'

export type PlatformModelMessage = { role: 'system' | 'user'; content: string }

export type PlatformModelResult = {
  text: string
  model: string
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
  }): Promise<PlatformModelResult>
}

export function createOpenAiCompatibleClient(): PlatformModelClient {
  return {
    async complete(input) {
      const raw = await postPlatformAiChatCompletion({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        body: buildPlatformAiChatBody({
          provider: input.provider,
          thinkingMode: input.thinkingMode,
          model: input.model,
          messages: input.messages,
          maxTokens: input.maxTokens,
          json: input.json,
        }),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      })
      const result = readPlatformAiChatResult(raw, 'business')
      return {
        text: result.text,
        model: result.model ?? input.model,
        usage: result.usage,
      }
    },
  }
}
