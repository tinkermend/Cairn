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

  let primaryRef: { kind: 'run' | 'scenario' | 'target' | 'session' | 'schedule' | 'dataset'; id: string } | undefined
  if (context.page === 'run' && runId) {
    primaryRef = { kind: 'run', id: runId }
  } else if ((context.page === 'studio' || context.page === 'scenario') && scenarioId) {
    primaryRef = { kind: 'scenario', id: scenarioId }
  } else if (context.page === 'target' && targetId) {
    primaryRef = { kind: 'target', id: targetId }
  } else if (context.page === 'session' && context.entityId) {
    primaryRef = { kind: 'session', id: context.entityId }
  } else if (context.page === 'schedule' && context.entityId) {
    primaryRef = { kind: 'schedule', id: context.entityId }
  } else if (context.page === 'dataset' && context.entityId) {
    primaryRef = { kind: 'dataset', id: context.entityId }
  }

  return {
    version: 2,
    routeKey: context.page,
    pageKind: context.page,
    page: context.page,
    ...(primaryRef ? { primaryRef } : {}),
    ...(runId ? { runId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(context.selectedStepId ? { stepId: context.selectedStepId } : {}),
    ...(draftRevision ? { draftRevision } : {}),
    ...(context.versionId ? { versionId: context.versionId } : {}),
    ...(context.isDirty !== undefined || draftRevision !== undefined
      ? {
          draft: {
            isDirty: Boolean(context.isDirty),
            savedRevision: draftRevision,
          },
        }
      : {}),
    ...(context.selectedStepId
      ? {
          view: {
            selectedRef: { kind: 'step' as const, id: context.selectedStepId },
          },
        }
      : {}),
  }
}

export function useAssistantContextBinding(
  context: AssistantBoundContext | null,
) {
  const bindPageContext = useAssistantStore((s) => s.bindPageContext)
  const unbindPageContext = useAssistantStore((s) => s.unbindPageContext)
  const setPageContext = useAssistantStore((s) => s.setPageContext)
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
    setPageContext(current ? toPageContext(current) : null)
  }, [signature, bindPageContext, setPageContext])

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
