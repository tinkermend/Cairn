import {
  assistantCapabilitiesResponseSchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantTurnListSchema,
  assistantTurnSchema,
  cancelResultSchema,
  createAssistantConversationBodySchema,
  createAssistantTurnBodySchema,
  deleteAssistantConversationResultSchema,
  submitAcceptedSchema,
  type AssistantCapabilitiesResponse,
  type AssistantConversation,
  type AssistantConversationList,
  type DeleteAssistantConversationResult,
  type AssistantStage,
  type AssistantTurn,
  type AssistantTurnList,
  type CancelResult,
  type CreateAssistantConversationBody,
  type CreateAssistantTurnBody,
  type SubmitAccepted,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { apiFetch, toQueryString } from './api-client'
import { readSseStream } from './sse'

const post = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function fetchAssistantCapabilities(): Promise<AssistantCapabilitiesResponse> {
  return apiFetch('/api/assistant/capabilities', assistantCapabilitiesResponseSchema)
}

export function createAssistantConversation(
  body: CreateAssistantConversationBody = {},
): Promise<AssistantConversation> {
  return apiFetch(
    '/api/assistant/conversations',
    assistantConversationSchema,
    post(createAssistantConversationBodySchema.parse(body)),
  )
}

export function fetchAssistantConversations(query?: {
  cursor?: string
  limit?: number
}): Promise<AssistantConversationList> {
  return apiFetch(
    `/api/assistant/conversations${toQueryString(query)}`,
    assistantConversationListSchema,
  )
}

export function deleteAssistantConversation(
  conversationId: string,
): Promise<DeleteAssistantConversationResult> {
  return apiFetch(
    `/api/assistant/conversations/${conversationId}/delete`,
    deleteAssistantConversationResultSchema,
    post({}),
  )
}

export function fetchAssistantTurns(
  conversationId: string,
  query?: { cursor?: string; limit?: number },
): Promise<AssistantTurnList> {
  return apiFetch(
    `/api/assistant/conversations/${conversationId}/turns${toQueryString(query)}`,
    assistantTurnListSchema,
  )
}

export function fetchAssistantTurn(conversationId: string, turnId: string): Promise<AssistantTurn> {
  return apiFetch(
    `/api/assistant/conversations/${conversationId}/turns/${turnId}`,
    assistantTurnSchema,
  )
}

export function createAssistantTurn(
  conversationId: string,
  body: CreateAssistantTurnBody,
  signal?: AbortSignal,
): Promise<SubmitAccepted> {
  return apiFetch(
    `/api/assistant/conversations/${conversationId}/turns`,
    submitAcceptedSchema,
    { ...post(createAssistantTurnBodySchema.parse(body)), signal },
  )
}

export function cancelAssistantTurn(
  conversationId: string,
  turnId: string,
): Promise<CancelResult> {
  return apiFetch(
    `/api/assistant/conversations/${conversationId}/turns/${turnId}/cancel`,
    cancelResultSchema,
    post({}),
  )
}

export function observeAssistantTurn(
  conversationId: string,
  turnId: string,
  handlers: {
    onReady?: (data: { realtime: boolean; thinkingStream: boolean }) => void
    onEvent?: (event: { stage: AssistantStage | 'queued'; at: string; note?: string }) => void
    onThinking?: (delta: string) => void
    onOutput?: (delta: string) => void
    onTurn?: (turn: AssistantTurn) => void
    onError?: (error: Error) => void
  },
): () => void {
  const url = `/api/assistant/conversations/${conversationId}/turns/${turnId}/observe`
  const controller = new AbortController()
  const token = useAuthStore.getState().auth.accessToken

  void (async () => {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (!res.ok || !res.body) {
        handlers.onError?.(new Error(`SSE connection failed with status ${res.status}`))
        return
      }

      await readSseStream(
        res.body,
        (frame) => {
          try {
            if (frame.event === 'ready') {
              handlers.onReady?.(JSON.parse(frame.data))
            } else if (frame.event === 'event') {
              handlers.onEvent?.(JSON.parse(frame.data))
            } else if (frame.event === 'thinking') {
              const data = JSON.parse(frame.data)
              handlers.onThinking?.(data.delta ?? '')
            } else if (frame.event === 'output') {
              const data = JSON.parse(frame.data)
              handlers.onOutput?.(data.delta ?? '')
            } else if (frame.event === 'turn') {
              const data = assistantTurnSchema.parse(JSON.parse(frame.data))
              handlers.onTurn?.(data)
            }
          } catch {}
        },
        controller.signal,
      )
    } catch (err) {
      if (!controller.signal.aborted) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return () => {
    controller.abort()
  }
}
