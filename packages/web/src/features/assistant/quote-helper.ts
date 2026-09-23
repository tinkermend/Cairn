import type { AssistantQuoteContext } from '@cairn/shared'

export function buildStepQuote(
  step: {
    id: string
    stepId?: string
    name?: string
    type: string
    ordinal?: number
    index?: number
    title?: string
  },
  error?: string,
): AssistantQuoteContext {
  let sanitizedSummary = error || step.name || step.title || step.type
  if (step.type === 'fill') {
    const isSensitive =
      Boolean((step as { input?: { sensitive?: boolean } }).input?.sensitive) ||
      /password|token|secret|pin|credential/i.test(
        String((step as { input?: { key?: string; target?: unknown } }).input?.key ?? ''),
      )
    if (isSensitive) {
      sanitizedSummary = error ? `[敏感填充步骤报错] ${error}` : '[敏感填充步骤: 字段值已脱密保护]'
    }
  }

  const idx = typeof step.ordinal === 'number' ? step.ordinal : step.index
  const idxText = typeof idx === 'number' ? `#${idx + 1}` : ''
  const nameText = step.name || step.title || step.type
  const stepDefinitionId = step.stepId ?? step.id

  return {
    type: error ? 'step_failure' : 'scenario_step',
    targetId: stepDefinitionId,
    objectRef: { kind: 'step', id: stepDefinitionId },
    title: `步骤 ${idxText ? `${idxText} ` : ''}: ${nameText}`.trim(),
    summary: sanitizedSummary.slice(0, 1000),
    metadata: {
      stepType: step.type,
      hasError: Boolean(error),
      ...(typeof idx === 'number' ? { ordinal: idx } : {}),
    },
  }
}

export function buildDiagnosticQuote(
  targetId: string,
  title: string,
  summary: string,
  metadata?: Record<string, unknown>,
): AssistantQuoteContext {
  return {
    type: 'compile_diagnostic',
    targetId,
    title: title.slice(0, 200),
    summary: summary.slice(0, 1000),
    metadata,
  }
}
