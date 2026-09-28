import { create } from 'zustand'
import type {
  AssistantActiveForm,
  AssistantAuthoringProposal,
  AssistantCapabilityId,
  AssistantCapabilitiesResponse,
  AssistantConversation,
  AssistantPageContext,
  AssistantProposal,
  AssistantQuoteContext,
  AssistantStage,
  AssistantTurn,
  TargetFormProposal,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import {
  createAssistantConversation,
  createAssistantTurn,
  cancelAssistantTurn,
  deleteAssistantConversation,
  observeAssistantTurn,
  fetchAssistantCapabilities,
  fetchAssistantConversations,
  fetchAssistantTurn,
  fetchAssistantTurns,
} from '@/lib/assistant-api'
import { toPageContext, type AssistantRouteContext } from '@/features/assistant/route-context'

export function summarizeConversationTitle(question: string, maxLen = 30): string {
  const clean = question.replace(/\s+/g, ' ').trim()
  if (!clean) return '新对话'
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

export type AssistantAdoptHandler = (
  proposal: AssistantProposal | AssistantAuthoringProposal | TargetFormProposal,
) => Promise<{ ok: true; digest?: string } | { ok: false; reason: string }>

export type AssistantRollbackHandler = (
  proposal: AssistantProposal | AssistantAuthoringProposal | TargetFormProposal,
) => Promise<{ ok: true } | { ok: false; reason: string }>

export type AssistantWindowMode = 'floating' | 'docked'

export interface AssistantBoundContext {
  page: AssistantPageContext['page']
  routeKey?: string
  filters?: Record<string, string | number | boolean>
  listHasFailures?: boolean
  entityId?: string
  runId?: string
  scenarioId?: string
  targetId?: string
  targetAccountId?: string
  sessionId?: string
  selectedStepId?: string
  selectedStepFailed?: boolean
  hasCssSelector?: boolean
  draftRevision?: number
  versionId?: string
  statusSummary?: string
  statusLabel?: string
  statusTone?: 'neutral' | 'success' | 'warning' | 'destructive' | 'info' | 'error'
  summaryText?: string
  isDirty?: boolean
  chips?: Array<{
    id?: string
    label: string
    question: string
    capabilityHint?: AssistantCapabilityId
    badge?: string
    priority?: number
  }>
  activeForm?: AssistantActiveForm
}

type AssistantState = {
  open: boolean
  conversationId: string | null
  turns: AssistantTurn[]
  question: string
  busy: boolean
  cancelling: boolean
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
  routeContext: AssistantRouteContext | null
  currentBindingOwnerToken: string | null

  // 进阶二业务协同控制
  trackedRunId: string | null
  previewStepId: string | null
  lastAdoptedProposalId: string | null
  lastAdoptedDigest: string | null

  // 进阶三会话生命周期与受控历史
  conversations: AssistantConversation[]
  historyOpen: boolean
  historyLoading: boolean
  historyLoadingMore: boolean
  historyNextCursor: string | null
  historyError: string | null

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
  submit: (options?: { selectedOptionId?: string; replyToTurnId?: string }) => Promise<void>
  cancel: () => Promise<void>
  cancelCurrentTask: (turnId?: string) => Promise<void>

  setMode: (mode: AssistantWindowMode) => void
  toggleMode: () => void
  setDockWidth: (width: number) => void
  setQuote: (quote: AssistantQuoteContext | null) => void
  clearQuote: () => void
  bindPageContext: (context: AssistantBoundContext | null, ownerToken?: string) => void
  unbindPageContext: (ownerToken?: string) => void
  setRouteContext: (routeContext: AssistantRouteContext | null) => void

  setTrackedRunId: (runId: string | null) => void
  setPreviewStepId: (stepId: string | null) => void
  setLastAdopted: (info: { proposalId: string; digest: string } | null) => void

  newConversation: () => void
  fetchRecentConversations: () => Promise<void>
  fetchMoreConversations: () => Promise<void>
  switchConversation: (id: string) => Promise<void>
  setHistoryOpen: (open: boolean) => void
  deleteConversation: (id: string) => Promise<void>
  deleteConversationLocally: (id: string) => void
}

let activeObserverCleanup: (() => void) | null = null
let activeReconnectTimer: ReturnType<typeof setTimeout> | null = null
let observationGeneration = 0

function stopActiveObservation() {
  observationGeneration += 1
  activeObserverCleanup?.()
  activeObserverCleanup = null
  if (activeReconnectTimer !== null) {
    clearTimeout(activeReconnectTimer)
    activeReconnectTimer = null
  }
}

const MODE_KEY = 'cairn:assistant:window_mode'
const DOCK_WIDTH_KEY = 'cairn:assistant:dock_width'
const DEFAULT_DOCK_WIDTH = 400

function getSavedMode(): AssistantWindowMode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'docked' || saved === 'floating') return saved
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
  return 'floating'
}

function getSavedDockWidth(): number {
  try {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= 320 && saved <= 600) return saved
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
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
  cancelling: false,
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
  routeContext: null,
  currentBindingOwnerToken: null,

  trackedRunId: null,
  previewStepId: null,
  lastAdoptedProposalId: null,
  lastAdoptedDigest: null,

  conversations: [],
  historyOpen: false,
  historyLoading: false,
  historyLoadingMore: false,
  historyNextCursor: null,
  historyError: null,

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
    } catch {
      // Keep the in-memory preference when local storage is unavailable.
    }
    set({ mode })
  },
  toggleMode: () => {
    const nextMode = get().mode === 'docked' ? 'floating' : 'docked'
    try {
      localStorage.setItem(MODE_KEY, nextMode)
    } catch {
      // Keep the in-memory preference when local storage is unavailable.
    }
    set({ mode: nextMode })
  },
  setDockWidth: (dockWidth) => {
    const clamped = Math.max(320, Math.min(600, dockWidth))
    try {
      localStorage.setItem(DOCK_WIDTH_KEY, String(clamped))
    } catch {
      // Keep the in-memory preference when local storage is unavailable.
    }
    set({ dockWidth: clamped })
  },
  setQuote: (activeQuote) => {
    set({ activeQuote, open: true })
  },
  clearQuote: () => set({ activeQuote: null }),
  bindPageContext: (boundContext, ownerToken) => {
    const effective = boundContext ?? get().routeContext
    set({
      boundContext,
      currentBindingOwnerToken: ownerToken ?? null,
      pageContext: toPageContext(effective),
    })
  },
  unbindPageContext: (ownerToken) => {
    const currentToken = get().currentBindingOwnerToken
    if (!ownerToken || currentToken === ownerToken) {
      const routeContext = get().routeContext
      set({
        boundContext: null,
        currentBindingOwnerToken: null,
        pageContext: toPageContext(routeContext),
      })
    }
  },
  setRouteContext: (routeContext) => {
    const boundContext = get().boundContext
    const effective = boundContext ?? routeContext
    set({
      routeContext,
      pageContext: toPageContext(effective),
    })
  },

  submit: async (options?: { selectedOptionId?: string; replyToTurnId?: string }) => {
    const { question, conversationId, pageContext, capabilityHint, busy, activeQuote, capabilities } = get()
    const trimmed = question.trim()
    if (!trimmed || busy) return
    if (capabilities?.modelEnabled === false) {
      set({ error: '平台 AI 尚未启用，请联系管理员检查模型配置。' })
      return
    }
    if (capabilityHint && capabilities && !capabilities.items.some((item) => item.id === capabilityHint && item.available)) {
      set({ error: '当前账号无法使用这项助手功能。' })
      return
    }

    stopActiveObservation()
    const generation = observationGeneration

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
        if (observationGeneration !== generation) return
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
      const effectiveContext = get().boundContext ?? get().routeContext
      const effectivePageContext = pageContext ?? toPageContext(effectiveContext) ?? undefined
      const finalPageContext: AssistantPageContext | undefined = effectivePageContext
        ? {
            ...effectivePageContext,
            quote: activeQuote ?? effectivePageContext.quote,
          }
        : activeQuote
          ? {
              page: 'other',
              quote: activeQuote,
            }
          : undefined

      // Submit turn immediately
      const latestTurnId = get().turns[0]?.id
      const replyToTurnId =
        options?.replyToTurnId ??
        (latestTurnId && isEntityId(latestTurnId) ? latestTurnId : undefined)
      const accepted = await createAssistantTurn(activeConversationId, {
        clientTurnId: newClientTurnId(),
        question: trimmed,
        pageContext: finalPageContext,
        ...(replyToTurnId ? { replyToTurnId } : {}),
        ...(options?.selectedOptionId ? { selectedOptionId: options.selectedOptionId } : {}),
        capabilityHint,
      })
      if (observationGeneration !== generation) return

      set({
        activeTurnId: accepted.turnId,
        activeStage: accepted.stage,
        activeQueuePosition: accepted.queuePosition,
        question: '',
        activeQuote: null, // quote consumed for this turn
        capabilityHint: undefined,
      })

      // A lost stream is reconciled against the durable turn before reconnecting.
      // The token prevents late callbacks from changing another conversation.
      const isCurrent = () =>
        observationGeneration === generation &&
        get().conversationId === activeConversationId &&
        get().activeTurnId === accepted.turnId
      let retryCount = 0
      let recovering = false

      const applyTurn = (turn: AssistantTurn) => {
        if (!isCurrent() || turn.id !== accepted.turnId) return
        const terminal = turn.status !== 'RUNNING' && turn.status !== 'QUEUED'
        if (terminal) stopActiveObservation()
        set((state) => {
          const effectiveThinkingText = turn.thinkingText ?? (state.thinkingText ? state.thinkingText : undefined)
          const mergedTurn: AssistantTurn = {
            ...turn,
            ...(effectiveThinkingText ? { thinkingText: effectiveThinkingText } : {}),
          }
          const exists = state.turns.some((item) => item.id === turn.id)
          const turns = exists
            ? state.turns.map((item) => item.id === turn.id ? mergedTurn : item)
            : [mergedTurn, ...state.turns]
          return terminal
            ? {
                turns,
                busy: false,
                error: null,
                activeTurnId: null,
                activeStage: null,
                activeQueuePosition: null,
                thinkingText: '',
                thinkingStream: false,
              }
            : {
                turns,
                busy: true,
                activeStage: (turn.stage as AssistantStage | 'queued') ?? state.activeStage,
                activeQueuePosition: turn.queuePosition ?? state.activeQueuePosition,
              }
        })
      }

      const reconnect = () => {
        if (!isCurrent() || activeReconnectTimer !== null) return
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retryCount, 4))
        retryCount += 1
        activeReconnectTimer = setTimeout(() => {
          activeReconnectTimer = null
          if (!isCurrent()) return
          if (get().cancelling) {
            reconnect()
            return
          }
          openStream()
        }, delay)
      }

      const recoverDisconnected = () => {
        if (!isCurrent() || recovering) return
        recovering = true
        activeObserverCleanup?.()
        activeObserverCleanup = null
        set({
          busy: true,
          error: '实时进度连接中断，正在读取已保存进度并重连…',
          thinkingStream: false,
        })
        void fetchAssistantTurn(activeConversationId, accepted.turnId)
          .then((turn) => {
            if (!isCurrent()) return
            if (!turn) throw new Error('无法读取任务状态')
            applyTurn(turn)
            if (isCurrent()) reconnect()
          })
          .catch(() => {
            if (!isCurrent()) return
            set({ error: '实时进度连接中断，暂时无法读取已保存进度；正在重连…' })
            reconnect()
          })
          .finally(() => { recovering = false })
      }

      const openStream = () => {
        if (!isCurrent()) return
        const cleanup = observeAssistantTurn(activeConversationId, accepted.turnId, {
          onReady: (data) => {
            if (isCurrent()) set({ thinkingStream: data.thinkingStream, error: null })
          },
          onEvent: (event) => {
            if (isCurrent()) set({ activeStage: event.stage })
          },
          onThinking: (delta) => {
            if (isCurrent()) {
              set((state) => ({ thinkingText: (state.thinkingText || '') + delta }))
            }
          },
          onTurn: applyTurn,
          onError: recoverDisconnected,
        })
        if (isCurrent() && !recovering) activeObserverCleanup = cleanup
        else cleanup()
      }

      openStream()
    } catch (error) {
      if (observationGeneration !== generation) return
      stopActiveObservation()
      set({
        busy: false,
        activeTurnId: null,
        activeStage: null,
        activeQueuePosition: null,
        thinkingText: '',
        thinkingStream: false,
        error: error instanceof ApiRequestError ? error.message : '助手请求失败',
      })
    }
  },
  cancel: async () => {
    const { conversationId, activeTurnId } = get()
    if (!conversationId || !activeTurnId || get().cancelling) return
    set({ cancelling: true, error: null })
    try {
      await cancelAssistantTurn(conversationId, activeTurnId)
      if (get().conversationId === conversationId && get().activeTurnId === activeTurnId) {
        stopActiveObservation()
        set({
          busy: false,
          activeTurnId: null,
          activeStage: null,
          activeQueuePosition: null,
          thinkingText: '',
          thinkingStream: false,
        })
      }
      const refreshed = await fetchAssistantTurns(conversationId, { limit: 50 }).catch(() => null)
      if (get().conversationId === conversationId && !get().activeTurnId && refreshed) {
        set({ turns: refreshed.items })
      }
    } catch {
      if (get().conversationId === conversationId && get().activeTurnId === activeTurnId) {
        set({ error: '停止请求未成功，任务可能仍在运行。请重试。' })
      }
    } finally {
      set({ cancelling: false })
    }
  },

  cancelCurrentTask: async (turnId?: string) => {
    const { conversationId, turns } = get()
    const targetTurnId = turnId ?? turns[0]?.id
    if (conversationId && targetTurnId) {
      try {
        await cancelAssistantTurn(conversationId, targetTurnId)
      } catch {
        set({ error: '取消请求未成功，请重试。' })
        return
      }
      if (get().conversationId === conversationId && get().activeTurnId === targetTurnId) {
        stopActiveObservation()
        set({
          busy: false,
          activeTurnId: null,
          activeStage: null,
          activeQueuePosition: null,
          thinkingText: '',
          thinkingStream: false,
        })
      }
      try {
        const refreshed = await fetchAssistantTurns(conversationId, { limit: 50 })
        if (get().conversationId === conversationId && !get().activeTurnId) {
          set({ turns: refreshed.items })
        }
      } catch {
        set({ error: '取消请求已提交，但最新状态暂时无法刷新。请稍后查看会话记录。' })
      }
    }
  },

  newConversation: () => {
    const { conversationId, activeTurnId, busy } = get()
    stopActiveObservation()

    if (conversationId && activeTurnId && busy) {
      void cancelAssistantTurn(conversationId, activeTurnId).catch(() => undefined)
    }

    set({
      conversationId: null,
      turns: [],
      question: '',
      busy: false,
      cancelling: false,
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
    set({ historyLoading: true, historyError: null, historyNextCursor: null })
    try {
      const res = await fetchAssistantConversations({ limit: 50 })
      const currentActiveId = get().conversationId
      const currentConv = get().conversations.find((c) => c.id === currentActiveId)
      const merged =
        currentConv && !res.items.some((c) => c.id === currentActiveId)
          ? [currentConv, ...res.items]
          : res.items
      set({ conversations: merged, historyLoading: false, historyNextCursor: res.nextCursor ?? null })
    } catch {
      set({ historyLoading: false, historyError: '会话历史加载失败，请重试。' })
    }
  },

  fetchMoreConversations: async () => {
    const cursor = get().historyNextCursor
    if (!cursor || get().historyLoadingMore) return
    set({ historyLoadingMore: true, historyError: null })
    try {
      const res = await fetchAssistantConversations({ cursor, limit: 50 })
      if (get().historyNextCursor !== cursor) return
      set((state) => ({
        conversations: [
          ...state.conversations,
          ...res.items.filter((item) => !state.conversations.some((existing) => existing.id === item.id)),
        ],
        historyNextCursor: res.nextCursor ?? null,
      }))
    } catch {
      set({ historyError: '更多会话加载失败，请重试。' })
    } finally {
      set({ historyLoadingMore: false })
    }
  },

  switchConversation: async (id: string) => {
    const { conversationId, activeTurnId, busy } = get()
    if (conversationId === id) {
      set({ historyOpen: false })
      return
    }

    stopActiveObservation()

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
      if (get().conversationId !== id) return
      set({ turns: turnList.items, busy: false })
    } catch (err) {
      if (get().conversationId !== id) return
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

  deleteConversation: async (id: string) => {
    const currentId = get().conversationId
    const isCurrent = currentId === id
    const previousConversations = get().conversations

    if (isCurrent) {
      stopActiveObservation()
    }

    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      ...(isCurrent
        ? {
            conversationId: null,
            turns: [],
            question: '',
            activeQuote: null,
            busy: false,
            activeTurnId: null,
            activeStage: null,
            activeQueuePosition: null,
            thinkingText: '',
            thinkingStream: false,
          }
        : {}),
    }))

    try {
      await deleteAssistantConversation(id)
    } catch (error) {
      // 若后端删除失败，回滚会话列表并提示错误
      set({
        conversations: previousConversations,
        error: error instanceof ApiRequestError ? error.message : '删除会话失败',
      })
    }
  },

  deleteConversationLocally: (id: string) => {
    void get().deleteConversation(id)
  },
}))
