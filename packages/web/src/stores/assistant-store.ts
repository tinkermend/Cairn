import { create } from 'zustand'
import type {
  AssistantCapabilityId,
  AssistantCapabilitiesResponse,
  AssistantConversation,
  AssistantPageContext,
  AssistantProposal,
  AssistantQuoteContext,
  AssistantStage,
  AssistantTurn,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import {
  createAssistantConversation,
  createAssistantTurn,
  cancelAssistantTurn,
  observeAssistantTurn,
  fetchAssistantCapabilities,
  fetchAssistantConversations,
  fetchAssistantTurns,
} from '@/lib/assistant-api'

export const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000

export function filterRecentConversations(
  items: AssistantConversation[],
  now = Date.now()
): AssistantConversation[] {
  const cutoff = now - FIVE_DAYS_MS
  return items.filter((item) => {
    const time = new Date(item.updatedAt || item.createdAt).getTime()
    return !Number.isNaN(time) && time >= cutoff
  })
}

export function summarizeConversationTitle(question: string, maxLen = 30): string {
  const clean = question.replace(/\s+/g, ' ').trim()
  if (!clean) return '新对话'
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

export type AssistantAdoptHandler = (
  proposal: AssistantProposal,
) => Promise<{ ok: true; digest?: string } | { ok: false; reason: string }>

export type AssistantRollbackHandler = (
  proposal: AssistantProposal,
) => Promise<{ ok: true } | { ok: false; reason: string }>

export type AssistantWindowMode = 'floating' | 'docked'

export interface AssistantBoundContext {
  page: AssistantPageContext['page']
  entityId?: string
  runId?: string
  scenarioId?: string
  targetId?: string
  selectedStepId?: string
  draftRevision?: number
  versionId?: string
  statusSummary?: string
  statusLabel?: string
  statusTone?: 'success' | 'error' | 'warning' | 'info' | 'neutral'
  summaryText?: string
  isDirty?: boolean
  chips?: Array<{
    label: string
    question: string
    capabilityHint?: AssistantCapabilityId
  }>
}

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
  rollbackHandler: AssistantRollbackHandler | null
  activeTurnId: string | null
  activeStage: AssistantStage | 'queued' | null
  activeQueuePosition: number | null
  thinkingText: string
  thinkingStream: boolean

  // 进阶一形态与引用
  mode: AssistantWindowMode
  dockWidth: number
  activeQuote: AssistantQuoteContext | null
  boundContext: AssistantBoundContext | null

  // 进阶二业务协同控制
  trackedRunId: string | null
  previewStepId: string | null
  lastAdoptedProposalId: string | null
  lastAdoptedDigest: string | null

  // 进阶三会话生命周期与受控历史
  conversations: AssistantConversation[]
  historyOpen: boolean
  historyLoading: boolean

  openPanel: (input?: {
    question?: string
    pageContext?: AssistantPageContext
    capabilityHint?: AssistantCapabilityId
    quote?: AssistantQuoteContext
    mode?: AssistantWindowMode
  }) => void
  closePanel: () => void
  setQuestion: (question: string) => void
  setPageContext: (pageContext: AssistantPageContext | null) => void
  registerAdoptHandler: (handler: AssistantAdoptHandler | null) => void
  registerRollbackHandler: (handler: AssistantRollbackHandler | null) => void
  loadCapabilities: () => Promise<void>
  submit: () => Promise<void>
  cancel: () => void
  cancelCurrentTask: (turnId?: string) => Promise<void>

  setMode: (mode: AssistantWindowMode) => void
  toggleMode: () => void
  setDockWidth: (width: number) => void
  setQuote: (quote: AssistantQuoteContext | null) => void
  clearQuote: () => void
  bindPageContext: (context: AssistantBoundContext | null) => void

  setTrackedRunId: (runId: string | null) => void
  setPreviewStepId: (stepId: string | null) => void
  setLastAdopted: (info: { proposalId: string; digest: string } | null) => void

  newConversation: () => void
  fetchRecentConversations: () => Promise<void>
  switchConversation: (id: string) => Promise<void>
  setHistoryOpen: (open: boolean) => void
  deleteConversationLocally: (id: string) => void
}

let activeObserverCleanup: (() => void) | null = null

const MODE_KEY = 'cairn:assistant:window_mode'
const DOCK_WIDTH_KEY = 'cairn:assistant:dock_width'
const DEFAULT_DOCK_WIDTH = 400

function getSavedMode(): AssistantWindowMode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'docked' || saved === 'floating') return saved
  } catch {}
  return 'floating'
}

function getSavedDockWidth(): number {
  try {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= 320 && saved <= 600) return saved
  } catch {}
  return DEFAULT_DOCK_WIDTH
}

function newClientTurnId(): string {
  if (typeof crypto.randomUUID === 'function') return `turn-${crypto.randomUUID()}`
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `turn-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function isEntityId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
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
  rollbackHandler: null,
  activeTurnId: null,
  activeStage: null,
  activeQueuePosition: null,
  thinkingText: '',
  thinkingStream: false,

  mode: getSavedMode(),
  dockWidth: getSavedDockWidth(),
  activeQuote: null,
  boundContext: null,

  trackedRunId: null,
  previewStepId: null,
  lastAdoptedProposalId: null,
  lastAdoptedDigest: null,

  conversations: [],
  historyOpen: false,
  historyLoading: false,

  openPanel: (input) =>
    set((state) => ({
      open: true,
      error: null,
      question: input?.question ?? state.question,
      pageContext: input?.pageContext ?? state.pageContext,
      capabilityHint: input?.capabilityHint ?? state.capabilityHint,
      activeQuote: input?.quote ?? state.activeQuote,
      mode: input?.mode ?? state.mode,
    })),
  closePanel: () => {
    set({ open: false })
  },
  setQuestion: (question) => set({ question, capabilityHint: undefined }),
  setPageContext: (pageContext) => set({ pageContext }),
  registerAdoptHandler: (handler) => set({ adoptHandler: handler }),
  registerRollbackHandler: (handler) => set({ rollbackHandler: handler }),
  setTrackedRunId: (trackedRunId) => set({ trackedRunId }),
  setPreviewStepId: (previewStepId) => set({ previewStepId }),
  setLastAdopted: (info) =>
    set({
      lastAdoptedProposalId: info?.proposalId ?? null,
      lastAdoptedDigest: info?.digest ?? null,
    }),
  loadCapabilities: async () => {
    const capabilities = await fetchAssistantCapabilities()
    set({ capabilities })
  },
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {}
    set({ mode })
  },
  toggleMode: () => {
    const nextMode = get().mode === 'docked' ? 'floating' : 'docked'
    try {
      localStorage.setItem(MODE_KEY, nextMode)
    } catch {}
    set({ mode: nextMode })
  },
  setDockWidth: (dockWidth) => {
    const clamped = Math.max(320, Math.min(600, dockWidth))
    try {
      localStorage.setItem(DOCK_WIDTH_KEY, String(clamped))
    } catch {}
    set({ dockWidth: clamped })
  },
  setQuote: (activeQuote) => {
    set({ activeQuote, open: true })
  },
  clearQuote: () => set({ activeQuote: null }),
  bindPageContext: (boundContext) => set({ boundContext }),

  submit: async () => {
    const { question, conversationId, pageContext, capabilityHint, busy, activeQuote } = get()
    const trimmed = question.trim()
    if (!trimmed || busy) return

    activeObserverCleanup?.()
    activeObserverCleanup = null

    set({
      busy: true,
      error: null,
      activeStage: 'accepted',
      activeQueuePosition: null,
      thinkingText: '',
      thinkingStream: false,
    })

    try {
      let activeConversationId = conversationId
      if (!activeConversationId) {
        const title = summarizeConversationTitle(trimmed)
        const conversation = await createAssistantConversation({
          idempotencyKey: `conv-${newClientTurnId().slice(5, 21)}`,
          title,
          question: trimmed,
        })
        const effectiveTitle =
          conversation.title && conversation.title !== '新对话' && conversation.title !== '新会话'
            ? conversation.title
            : title
        const conversationWithTitle = { ...conversation, title: effectiveTitle }
        activeConversationId = conversation.id
        set((state) => ({
          conversationId: activeConversationId,
          conversations: [
            conversationWithTitle,
            ...state.conversations.filter((c) => c.id !== conversation.id),
          ],
        }))
      } else {
        const currentConv = get().conversations.find((c) => c.id === activeConversationId)
        if (
          currentConv &&
          (currentConv.title === '新对话' || currentConv.title === '新会话') &&
          get().turns.length === 0
        ) {
          const newTitle = summarizeConversationTitle(trimmed)
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === activeConversationId ? { ...c, title: newTitle } : c,
            ),
          }))
        }
      }

      // Merge quote into pageContext if quote is set
      const finalPageContext: AssistantPageContext | undefined = pageContext
        ? {
            ...pageContext,
            quote: activeQuote ?? pageContext.quote,
          }
        : activeQuote
          ? {
              page: 'other',
              quote: activeQuote,
            }
          : undefined

      // Submit turn immediately
      const isDirty = Boolean(get().boundContext?.isDirty)
      const effectiveQuestion = isDirty
        ? `⚠️ 当前分析基于已保存版本；若需分析刚刚编辑的步骤，请先保存（Ctrl+S）\n\n${trimmed}`
        : trimmed

      const latestTurnId = get().turns[0]?.id
      const replyToTurnId = latestTurnId && isEntityId(latestTurnId) ? latestTurnId : undefined
      const accepted = await createAssistantTurn(activeConversationId, {
        clientTurnId: newClientTurnId(),
        question: effectiveQuestion,
        pageContext: finalPageContext,
        ...(replyToTurnId ? { replyToTurnId } : {}),
        capabilityHint,
      })

      set({
        activeTurnId: accepted.turnId,
        activeStage: accepted.stage,
        activeQueuePosition: accepted.queuePosition,
        question: '',
        activeQuote: null, // quote consumed for this turn
        capabilityHint: undefined,
      })

      // Start observing via SSE
      activeObserverCleanup = observeAssistantTurn(activeConversationId, accepted.turnId, {
        onReady: (data) => {
          set({ thinkingStream: data.thinkingStream })
        },
        onEvent: (event) => {
          set({ activeStage: event.stage })
        },
        onThinking: (delta) => {
          set((state) => ({ thinkingText: state.thinkingText + delta }))
        },
        onTurn: (turn) => {
          set((state) => {
            const exists = state.turns.some((t) => t.id === turn.id)
            const updatedTurns = exists
              ? state.turns.map((t) => (t.id === turn.id ? turn : t))
              : [turn, ...state.turns]

            const isDone = turn.status !== 'RUNNING' && turn.status !== 'QUEUED'
            if (isDone) {
              activeObserverCleanup?.()
              activeObserverCleanup = null
              return {
                turns: updatedTurns,
                busy: false,
                activeTurnId: null,
                activeStage: null,
                activeQueuePosition: null,
              }
            }
            return {
              turns: updatedTurns,
              activeStage: (turn.stage as AssistantStage | 'queued') ?? state.activeStage,
              activeQueuePosition: turn.queuePosition ?? state.activeQueuePosition,
            }
          })
        },
        onError: () => {
          // If SSE disconnected, fetch turn directly as catch-up
          if (activeConversationId) {
            void fetchAssistantTurns(activeConversationId, { limit: 50 }).then((history) => {
              set({ turns: history.items, busy: false, activeTurnId: null, activeStage: null })
            })
          }
        },
      })
    } catch (error) {
      activeObserverCleanup?.()
      activeObserverCleanup = null
      set({
        busy: false,
        activeTurnId: null,
        activeStage: null,
        activeQueuePosition: null,
        error: error instanceof ApiRequestError ? error.message : '助手请求失败',
      })
    }
  },
  cancel: () => {
    const { conversationId, activeTurnId } = get()
    activeObserverCleanup?.()
    activeObserverCleanup = null

    if (conversationId && activeTurnId) {
      void cancelAssistantTurn(conversationId, activeTurnId).catch(() => undefined)
    }

    set({
      busy: false,
      activeTurnId: null,
      activeStage: null,
      activeQueuePosition: null,
    })
  },

  cancelCurrentTask: async (turnId?: string) => {
    const { conversationId, turns } = get()
    const targetTurnId = turnId ?? turns[0]?.id
    if (conversationId && targetTurnId) {
      try {
        await cancelAssistantTurn(conversationId, targetTurnId)
        const refreshed = await fetchAssistantTurns(conversationId, { limit: 50 })
        set({ turns: refreshed.items, busy: false })
      } catch {
        // ignore
      }
    }
  },

  newConversation: () => {
    const { conversationId, activeTurnId, busy } = get()
    activeObserverCleanup?.()
    activeObserverCleanup = null

    if (conversationId && activeTurnId && busy) {
      void cancelAssistantTurn(conversationId, activeTurnId).catch(() => undefined)
    }

    set({
      conversationId: null,
      turns: [],
      question: '',
      busy: false,
      error: null,
      activeTurnId: null,
      activeStage: null,
      activeQueuePosition: null,
      thinkingText: '',
      thinkingStream: false,
      activeQuote: null,
      historyOpen: false,
    })
  },

  fetchRecentConversations: async () => {
    set({ historyLoading: true })
    try {
      const res = await fetchAssistantConversations({ limit: 50 })
      const filtered = filterRecentConversations(res.items)
      const currentActiveId = get().conversationId
      const currentConv = get().conversations.find((c) => c.id === currentActiveId)
      const merged =
        currentConv && !filtered.some((c) => c.id === currentActiveId)
          ? [currentConv, ...filtered]
          : filtered
      set({ conversations: merged, historyLoading: false })
    } catch {
      set({ historyLoading: false })
    }
  },

  switchConversation: async (id: string) => {
    const { conversationId, activeTurnId, busy } = get()
    if (conversationId === id) {
      set({ historyOpen: false })
      return
    }

    activeObserverCleanup?.()
    activeObserverCleanup = null

    if (conversationId && activeTurnId && busy) {
      void cancelAssistantTurn(conversationId, activeTurnId).catch(() => undefined)
    }

    set({
      conversationId: id,
      turns: [],
      question: '',
      busy: true,
      error: null,
      activeTurnId: null,
      activeStage: null,
      activeQueuePosition: null,
      thinkingText: '',
      thinkingStream: false,
      historyOpen: false,
    })

    try {
      const turnList = await fetchAssistantTurns(id, { limit: 50 })
      set({ turns: turnList.items, busy: false })
    } catch (err) {
      set({
        busy: false,
        error: err instanceof ApiRequestError ? err.message : '获取会话历史失败',
      })
    }
  },

  setHistoryOpen: (open: boolean) => {
    set({ historyOpen: open })
    if (open) {
      void get().fetchRecentConversations()
    }
  },

  deleteConversationLocally: (id: string) => {
    const currentId = get().conversationId
    const isCurrent = currentId === id
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      ...(isCurrent
        ? {
            conversationId: null,
            turns: [],
            question: '',
            activeQuote: null,
          }
        : {}),
    }))
  },
}))
