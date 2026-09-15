import { create } from 'zustand'
import type {
  AssistantCapabilityId,
  AssistantCapabilitiesResponse,
  AssistantPageContext,
  AssistantProposal,
  AssistantTurn,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import {
  createAssistantConversation,
  createAssistantTurn,
  fetchAssistantCapabilities,
  fetchAssistantTurns,
} from '@/lib/assistant-api'

export type AssistantAdoptHandler = (
  proposal: AssistantProposal,
) => Promise<{ ok: true } | { ok: false; reason: string }>

type AssistantState = {
  open: boolean
  conversationId: string | null
  turns: AssistantTurn[]
  question: string
  busy: boolean
  error: string | null
  pageContext: AssistantPageContext | null
  capabilityHint?: AssistantCapabilityId
  capabilities: AssistantCapabilitiesResponse | null
  adoptHandler: AssistantAdoptHandler | null
  openPanel: (input?: {
    question?: string
    pageContext?: AssistantPageContext
    capabilityHint?: AssistantCapabilityId
  }) => void
  closePanel: () => void
  setQuestion: (question: string) => void
  setPageContext: (pageContext: AssistantPageContext | null) => void
  registerAdoptHandler: (handler: AssistantAdoptHandler | null) => void
  loadCapabilities: () => Promise<void>
  submit: () => Promise<void>
  cancel: () => void
}

let inflight: AbortController | null = null

function newClientTurnId(): string {
  if (typeof crypto.randomUUID === 'function') return `turn-${crypto.randomUUID()}`
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `turn-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  open: false,
  conversationId: null,
  turns: [],
  question: '',
  busy: false,
  error: null,
  pageContext: null,
  capabilityHint: undefined,
  capabilities: null,
  adoptHandler: null,
  openPanel: (input) =>
    set((state) => ({
      open: true,
      error: null,
      question: input?.question ?? state.question,
      pageContext: input?.pageContext ?? state.pageContext,
      capabilityHint: input?.capabilityHint ?? state.capabilityHint,
    })),
  closePanel: () => {
    set({ open: false })
  },
  setQuestion: (question) => set({ question }),
  setPageContext: (pageContext) => set({ pageContext }),
  registerAdoptHandler: (handler) => set({ adoptHandler: handler }),
  loadCapabilities: async () => {
    const capabilities = await fetchAssistantCapabilities()
    set({ capabilities })
  },
  submit: async () => {
    const { question, conversationId, pageContext, capabilityHint, busy } = get()
    const trimmed = question.trim()
    if (!trimmed || busy) return
    inflight?.abort()
    const controller = new AbortController()
    inflight = controller
    set({ busy: true, error: null })
    try {
      let activeConversationId = conversationId
      if (!activeConversationId) {
        const conversation = await createAssistantConversation({
          idempotencyKey: `conv-${newClientTurnId().slice(5, 21)}`,
        })
        activeConversationId = conversation.id
      }
      const turn = await createAssistantTurn(
        activeConversationId,
        {
          clientTurnId: newClientTurnId(),
          question: trimmed,
          pageContext: pageContext ?? undefined,
          capabilityHint,
        },
        controller.signal,
      )
      const history = await fetchAssistantTurns(activeConversationId, { limit: 50 })
      set({
        conversationId: activeConversationId,
        turns: history.items,
        question: '',
        capabilityHint: undefined,
        busy: false,
      })
      void turn
    } catch (error) {
      if (controller.signal.aborted) {
        set({ busy: false })
        return
      }
      set({
        busy: false,
        error: error instanceof ApiRequestError ? error.message : '助手请求失败',
      })
    } finally {
      if (inflight === controller) inflight = null
    }
  },
  cancel: () => {
    inflight?.abort()
    inflight = null
    set({ busy: false })
  },
}))
