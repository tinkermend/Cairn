import {
  classifyOutcomeText,
  sanitizeLocatorLabel,
  type AssertExpect,
  type LocatorCandidate,
  type TargetDescriptor,
  type TargetObservation,
} from '@cairn/shared'

const FALLBACK_LABEL = /^#\d+$/

export type ApplyPickedExtras = {
  previewText?: string
  addOutcome?: boolean
}

export function expectFromPreviewText(text: string): AssertExpect {
  const value = text.trim()
  const classified = classifyOutcomeText(value)
  if (classified.suggestedKind === 'text_equals') {
    return { kind: 'text_equals', value }
  }
  if (classified.suggestedKind === 'text_contains') {
    return { kind: 'text_contains', value }
  }
  const numeric = parseLooseNumber(value)
  if (numeric !== undefined) {
    return { kind: 'number_compare', op: 'eq', value: numeric }
  }
  return { kind: 'exists' }
}

export function targetFromPickedLabel(
  label: string,
  base?: TargetDescriptor,
): TargetDescriptor {
  const value = label.trim()
  return {
    framePath: base?.framePath ?? [],
    candidates: [{ by: 'text', value }],
    semantic: value,
    ...(base?.anchor ? { anchor: base.anchor } : {}),
  }
}

export function alternativeLabels(observation?: TargetObservation): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const item of observation?.alternatives ?? []) {
    for (const label of labelsFromAlternative(item.reason, item.label)) {
      if (seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }
  }
  return labels
}

export function observationPreviewText(observation?: TargetObservation): string {
  return observation?.preview?.text?.replace(/\s+/g, ' ').trim() ?? ''
}

export function normalizePickLabel(value: string): string {
  return sanitizeLocatorLabel(value)
}

export function pickLabelMismatch(seen: string, willClick: string): boolean {
  const left = normalizePickLabel(seen)
  const right = normalizePickLabel(willClick)
  return Boolean(left && right && left !== right)
}

export function resolvedCandidate(
  observation?: TargetObservation,
): LocatorCandidate | undefined {
  if (!observation?.target || observation.outcome !== 'FOUND') return undefined
  const unique = observation.diagnostics.candidatesTried.find((item) => item.matches === 1)
  if (!unique) return undefined
  return observation.target.candidates[unique.index]
}

export function locatorCandidateSummary(candidate: LocatorCandidate): string {
  const name = normalizePickLabel(candidate.name ?? '')
  const value = normalizePickLabel(candidate.value)
  if (candidate.by === 'role') return name ? `角色 ${candidate.value}「${name}」` : `角色 ${candidate.value}`
  if (candidate.by === 'label') return `标签「${value}」`
  if (candidate.by === 'text') return `文本「${value}」`
  if (candidate.by === 'title') return `标题「${value}」`
  if (candidate.by === 'testId') return `测试ID "${candidate.value}"`
  return `${candidate.by}: ${candidate.value}`
}

export function candidateCompareText(candidate: LocatorCandidate): string {
  return candidate.by === 'role' ? (candidate.name ?? '') : candidate.value
}

function labelsFromAlternative(reason: string, label?: string): string[] {
  const raw = []
  if (label?.trim()) raw.push(label)
  const grouped = reason.match(/^匹配\s*\d+\s*个：\s*(.+)$/)
  if (grouped?.[1]) {
    raw.push(...grouped[1].split(/\s*\/\s*/))
  } else if (!label?.trim()) {
    raw.push(reason)
  }
  return raw.map((item) => item.replace(/\s+/g, ' ').trim()).filter(usableLabel)
}

function usableLabel(label: string): boolean {
  if (!label || label === '…' || label === '...') return false
  if (FALLBACK_LABEL.test(label)) return false
  return label.length >= 1 && label.length <= 80
}

function parseLooseNumber(text: string): number | undefined {
  const matched = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!matched) return undefined
  const value = Number(matched[0])
  return Number.isFinite(value) ? value : undefined
}
