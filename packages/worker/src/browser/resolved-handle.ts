import { isCrossCheckContainerTag } from '@cairn/shared'

export { RESOLVED_ATTRIBUTE, cssAttrEscape, resolvedSelector } from '@cairn/shared'

/** Midscene 1.12.6：`aiLocate.center` 是缩放后的截图像素，`dpr` 来自 `uiContext.deprecatedDpr`。 */
export const MIDSCENE_LOCATE_SDK = '1.12.6' as const
export const CROSS_CHECK_TEXT_MAX = 80

export function cssViewportPoint(center: readonly [number, number], dpr: number): { x: number; y: number } {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return { x: center[0] / scale, y: center[1] / scale }
}

export function truncateCrossCheckText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, CROSS_CHECK_TEXT_MAX)
}

export function collectCrossCheckTexts(input: {
  accessibleName?: string | null
  ariaLabel?: string | null
  title?: string | null
  placeholder?: string | null
  ownText?: string | null
  innerText?: string | null
  container?: boolean
}): string[] {
  const texts = [input.accessibleName, input.ariaLabel, input.title, input.placeholder, input.ownText]
  if (!input.container) texts.push(input.innerText)
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of texts) {
    const trimmed = item ? truncateCrossCheckText(item) : ''
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export type BindResolvedReason = 'AI_NOT_FOUND' | 'FRAME_UNSUPPORTED' | 'AI_AMBIGUOUS_POINT'

export type BindResolvedInspect =
  | { ok: true; tagName: string; texts: string[]; container: boolean }
  | { ok: false; reason: BindResolvedReason }

export function inspectPointElement(input: {
  element: { tagName: string } | null
  texts?: readonly string[]
  container?: boolean
}): BindResolvedInspect {
  if (!input.element) return { ok: false, reason: 'AI_NOT_FOUND' }
  const tag = input.element.tagName.toUpperCase()
  if (tag === 'IFRAME' || tag === 'FRAME') return { ok: false, reason: 'FRAME_UNSUPPORTED' }
  const container = input.container ?? isCrossCheckContainerTag(tag)
  return {
    ok: true,
    tagName: tag,
    container,
    texts: (input.texts ?? []).filter((item) => Boolean(item && item.trim())),
  }
}
