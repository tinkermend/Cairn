import {
  assistantCapabilitiesResponseSchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantTurnListSchema,
  assistantTurnSchema,
  createAssistantConversationBodySchema,
  createAssistantTurnBodySchema,
  type AssistantCapabilitiesResponse,
  type AssistantConversation,
  type AssistantConversationList,
  type AssistantTurn,
  type AssistantTurnList,
  type CreateAssistantConversationBody,
  type CreateAssistantTurnBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from './api-client'

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
): Promise<AssistantTurn> {
  return apiFetch(
    `/api/assistant/conversations/${conversationId}/turns`,
    assistantTurnSchema,
    { ...post(createAssistantTurnBodySchema.parse(body)), signal },
  )
}
