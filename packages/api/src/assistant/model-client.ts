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
      const base = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`
      const response = await fetch(new URL('chat/completions', base), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          max_tokens: input.maxTokens,
          temperature: 0,
          ...(input.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.any(
          [AbortSignal.timeout(input.timeoutMs), input.signal].filter(Boolean) as AbortSignal[],
        ),
      })
      if (!response.ok) {
        throw new Error(`模型服务返回 HTTP ${response.status}`)
      }
      const body = (await response.json()) as {
        model?: string
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = body.choices?.[0]?.message?.content?.trim()
      if (!text) throw new Error('模型没有返回可用文本')
      return {
        text,
        model: body.model ?? input.model,
        usage: {
          promptTokens: body.usage?.prompt_tokens,
          completionTokens: body.usage?.completion_tokens,
        },
      }
    },
  }
}
