import type {
  CandidateTry,
  ExecutionError,
  LocatorCandidate,
  ResolverDiagnostics,
  ResolverOutcome,
} from '@cairn/shared'

export function decideResolverOutcome(tried: { matches: number }[]): Exclude<ResolverOutcome, 'FOUND' | 'SURFACE_LOST' | 'CAPABILITY_MISSING'> {
  if (tried.some((item) => item.matches > 1)) return 'AMBIGUOUS'
  return 'NOT_FOUND'
}

export function pickResolvedCandidate(
  counts: number[],
): { kind: 'found'; index: number } | { kind: 'miss'; outcome: 'NOT_FOUND' | 'AMBIGUOUS' } {
  const index = counts.findIndex((count) => count === 1)
  if (index >= 0) return { kind: 'found', index }
  return { kind: 'miss', outcome: decideResolverOutcome(counts.map((matches) => ({ matches }))) }
}

export function candidateTries(candidates: LocatorCandidate[], matches: number[]): CandidateTry[] {
  return candidates.map((candidate, index) => ({
    index,
    by: candidate.by,
    value: candidate.name ? `${candidate.value}:${candidate.name}` : candidate.value,
    matches: matches[index] ?? 0,
  }))
}

export function errorForOutcome(
  outcome: Exclude<ResolverOutcome, 'FOUND'>,
  diagnostics: ResolverDiagnostics,
): ExecutionError {
  if (outcome === 'AMBIGUOUS') {
    return {
      code: 'TARGET_AMBIGUOUS',
      category: 'EXECUTOR',
      retryable: false,
      safeMessage: `定位到多个匹配：${summarize(diagnostics)}`,
    }
  }
  if (outcome === 'SURFACE_LOST') {
    return {
      code: 'SURFACE_LOST',
      category: 'INFRASTRUCTURE',
      retryable: true,
      safeMessage: '页面或 Frame 已失效，需要重新解析',
    }
  }
  if (outcome === 'CAPABILITY_MISSING') {
    return {
      code: 'BROWSER_CAPABILITY_MISSING',
      category: 'EXECUTOR',
      retryable: false,
      safeMessage: '目标落在 closed Shadow DOM 或 Canvas，本期不支持',
    }
  }
  return {
    code: 'TARGET_NOT_FOUND',
    category: 'EXECUTOR',
    retryable: true,
    safeMessage: `未找到目标：${summarize(diagnostics)}`,
  }
}

function summarize(diagnostics: ResolverDiagnostics): string {
  const parts = diagnostics.candidatesTried.map(
    (item) => `#${item.index} ${item.by}=${item.value}×${item.matches}`,
  )
  const frame = diagnostics.framePathResolved?.join('>') ?? 'main'
  return `${frame}; ${parts.join('; ')}`
}
