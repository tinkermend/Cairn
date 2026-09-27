import { useEffect, useRef } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  useAssistantStore,
  type AssistantBoundContext,
} from '@/stores/assistant-store'

function bindingSignature(context: AssistantBoundContext | null): string {
  if (!context) return ''
  return JSON.stringify([
    context.page,
    context.filters ? JSON.stringify(context.filters) : null,
    Boolean(context.listHasFailures),
    context.entityId ?? null,
    context.runId ?? null,
    context.scenarioId ?? null,
    context.targetId ?? null,
    context.targetAccountId ?? null,
    context.sessionId ?? null,
    context.selectedStepId ?? null,
    Boolean(context.selectedStepFailed),
    Boolean(context.hasCssSelector),
    context.draftRevision ?? null,
    context.versionId ?? null,
    context.statusSummary ?? null,
    context.statusLabel ?? null,
    context.statusTone ?? null,
    context.summaryText ?? null,
    Boolean(context.isDirty),
    (context.chips ?? []).map((chip) => [chip.label, chip.question, chip.capabilityHint ?? null]),
  ])
}

export function useAssistantContextBinding(
  context: AssistantBoundContext | null,
) {
  const bindPageContext = useAssistantStore((s) => s.bindPageContext)
  const unbindPageContext = useAssistantStore((s) => s.unbindPageContext)
  const signature = bindingSignature(context)
  const contextRef = useRef(context)
  contextRef.current = context
  const ownerTokenRef = useRef(
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `owner-${Math.random().toString(36).slice(2)}`,
  )

  useEffect(() => {
    const current = contextRef.current
    bindPageContext(current, ownerTokenRef.current)
  }, [signature, bindPageContext])

  useEffect(() => {
    const token = ownerTokenRef.current
    return () => {
      unbindPageContext(token)
    }
  }, [unbindPageContext])
}

/**
 * 监听路由变更，自动清除失效的跨页面 Quote
 */
export function useAssistantQuoteRouteGuard() {
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname
  const prevPathRef = useRef(currentPath)
  const activeQuote = useAssistantStore((s) => s.activeQuote)
  const clearQuote = useAssistantStore((s) => s.clearQuote)

  useEffect(() => {
    if (prevPathRef.current !== currentPath) {
      if (activeQuote) {
        clearQuote()
        toast.info('页面已切换，已自动清理先前选取的步骤引用')
      }
      prevPathRef.current = currentPath
    }
  }, [currentPath, activeQuote, clearQuote])
}
