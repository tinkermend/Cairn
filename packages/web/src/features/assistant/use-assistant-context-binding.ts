import { useEffect, useRef } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { AssistantPageContext } from '@cairn/shared'
import {
  useAssistantStore,
  type AssistantBoundContext,
} from '@/stores/assistant-store'

function bindingSignature(context: AssistantBoundContext | null): string {
  if (!context) return ''
  return JSON.stringify([
    context.page,
    context.entityId ?? null,
    context.runId ?? null,
    context.scenarioId ?? null,
    context.targetId ?? null,
    context.selectedStepId ?? null,
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

function toPageContext(context: AssistantBoundContext): AssistantPageContext {
  const runId = context.runId ?? (context.page === 'run' ? context.entityId : undefined)
  const scenarioId = context.scenarioId ?? (context.page === 'studio' ? context.entityId : undefined)
  const targetId = context.targetId ?? (context.page === 'target' ? context.entityId : undefined)
  const draftRevision =
    typeof context.draftRevision === 'number' && context.draftRevision >= 1
      ? context.draftRevision
      : undefined
  return {
    page: context.page,
    ...(runId ? { runId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(context.selectedStepId ? { stepId: context.selectedStepId } : {}),
    ...(draftRevision ? { draftRevision } : {}),
    ...(context.versionId ? { versionId: context.versionId } : {}),
  }
}

export function useAssistantContextBinding(
  context: AssistantBoundContext | null,
) {
  const bindPageContext = useAssistantStore((s) => s.bindPageContext)
  const setPageContext = useAssistantStore((s) => s.setPageContext)
  const signature = bindingSignature(context)
  const contextRef = useRef(context)
  contextRef.current = context

  useEffect(() => {
    const current = contextRef.current
    bindPageContext(current)
    setPageContext(current ? toPageContext(current) : null)
  }, [signature, bindPageContext, setPageContext])

  useEffect(() => {
    return () => {
      bindPageContext(null)
      setPageContext(null)
    }
  }, [bindPageContext, setPageContext])
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
