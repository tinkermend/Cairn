export type MessageRole = 'system' | 'user' | 'assistant'

export type TextContentPart = {
  type: 'text'
  text: string
}

export type ImageContentPart = {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}

export type MessageContentPart = TextContentPart | ImageContentPart

export type ModelMessage = {
  role: MessageRole
  content: string | MessageContentPart[]
}

export interface ModelCompletionOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: { type: 'text' | 'json_object' }
  signal?: AbortSignal
}

export interface ModelTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ModelCompletionResult {
  content: string
  model: string
  usage?: ModelTokenUsage
  rawResponse?: unknown
}

export interface IModelClient {
  complete(messages: ModelMessage[], options?: ModelCompletionOptions): Promise<ModelCompletionResult>
}
