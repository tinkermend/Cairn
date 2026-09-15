import type { LocatorCandidate, TargetDescriptor, TargetObservation } from '@cairn/shared'
import type { Page } from './runtime'
import { locatorForCandidate, resolveFramePath, scopeForAnchor } from './runtime'
import { locate } from './surface'

const DEFAULT_LOCATE_MS = 8_000

type PickedElement = {
  testId?: string
  role?: string
  accessibleName?: string
  label?: string
  text?: string
  title?: string
  css?: string
  cssFragile?: boolean
  tag?: string
  box?: { x: number; y: number; width: number; height: number }
  framePath: Array<{ urlPattern?: string; name?: string; selector?: string }>
  anchor?: { withinText: string; scope: 'row' | 'nearest' }
}

export async function highlightOnPage(page: Page, target: TargetDescriptor): Promise<TargetObservation> {
  const located = await locate(page, target)
  const url = page.url()
  const title = await page.title().catch(() => undefined)
  const alternatives = located.kind === 'miss' ? await alternativesFor(page, target, located.outcome, located.diagnostics.candidatesTried) : undefined
  if (located.kind !== 'found') {
    return {
      outcome: located.outcome,
      target,
      page: { url, title },
      diagnostics: located.diagnostics,
      source: 'managed',
      ...(alternatives?.length ? { alternatives } : {}),
    }
  }
  const box = await located.locator.boundingBox().catch(() => null)
  const tag = await located.locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => undefined)
  const text = await located.locator.innerText().catch(() => undefined)
  return {
    outcome: 'FOUND',
    target,
    page: { url, title },
    preview: {
      ...(box ? { box } : {}),
      tag,
      text: text?.trim().slice(0, 80),
    },
    diagnostics: located.diagnostics,
    source: 'managed',
  }
}

export async function pickOnPage(page: Page, x: number, y: number): Promise<TargetObservation> {
  const url = page.url()
  const title = await page.title().catch(() => undefined)
  const picked = await page
    .evaluate(
      ({ x, y }) => {
        type DomElement = {
          tagName: string
          classList: Iterable<string>
          textContent: string | null
          parentElement: DomElement | null
          ownerDocument: { defaultView: DomWindow | null; querySelector: (sel: string) => DomElement | null }
          getAttribute: (name: string) => string | null
          getBoundingClientRect: () => { x: number; y: number; width: number; height: number; left: number; top: number }
          closest: (sel: string) => DomElement | null
          contentDocument?: DomDocument | null
        }
        type DomDocument = {
          elementFromPoint: (px: number, py: number) => DomElement | null
          querySelector: (sel: string) => DomElement | null
          defaultView: DomWindow | null
        }
        type DomWindow = {
          name: string
          location: { href: string }
          parent: DomWindow
          frameElement: DomElement | null
        }
        const rootDocument = (globalThis as unknown as { document: DomDocument }).document
        return hitAt(rootDocument, x, y)

        function hitAt(root: DomDocument, px: number, py: number): PickedElement | null {
          const hit = root.elementFromPoint(px, py)
          if (!hit) return null
          if (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') {
            try {
              const doc = hit.contentDocument
              if (doc) {
                const rect = hit.getBoundingClientRect()
                const inner = hitAt(doc, px - rect.left, py - rect.top)
                if (inner) return inner
              }
            } catch {
              // 跨域 iframe 只能指到 frame 元素本身
            }
          }
          return describeElement(hit)
        }

        function describeElement(el: DomElement): PickedElement {
          const testId = attr(el, 'data-testid') || attr(el, 'data-test-id')
          const role = attr(el, 'role') || implicitRole(el)
          const accessibleName = accessibleNameOf(el)
          const label = labelOf(el) || attr(el, 'aria-label')
          const text = visibleText(el)
          const titleAttr = attr(el, 'title')
          const id = attr(el, 'id')
          const name = attr(el, 'name')
          const tag = el.tagName.toLowerCase()
          const rect = el.getBoundingClientRect()
          const css = id
            ? `#${cssIdent(id)}`
            : name
              ? `${tag}[name="${cssAttr(name)}"]`
              : shortCss(el)
          return {
            testId: testId || undefined,
            role: role || undefined,
            accessibleName: accessibleName || undefined,
            label: label || undefined,
            text: text || undefined,
            title: titleAttr || undefined,
            css,
            cssFragile: !id && !name,
            tag,
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            framePath: framePathOf(el),
            anchor: nearestAnchor(el, text),
          }
        }

        function attr(el: DomElement, name: string): string {
          return (el.getAttribute(name) ?? '').trim()
        }

        function implicitRole(el: DomElement): string {
          const tag = el.tagName.toLowerCase()
          if (tag === 'button') return 'button'
          if (tag === 'a' && attr(el, 'href')) return 'link'
          if (tag === 'input') {
            const type = attr(el, 'type') || 'text'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            return 'textbox'
          }
          if (tag === 'select') return 'combobox'
          if (tag === 'textarea') return 'textbox'
          return ''
        }

        function accessibleNameOf(el: DomElement): string {
          return (
            attr(el, 'aria-label') ||
            labelOf(el) ||
            attr(el, 'title') ||
            visibleText(el)
          ).slice(0, 256)
        }

        function labelOf(el: DomElement): string {
          const id = attr(el, 'id')
          if (id) {
            const labelled = el.ownerDocument.querySelector(`label[for="${cssAttr(id)}"]`)
            const text = labelled?.textContent?.trim() ?? ''
            if (text) return text.slice(0, 256)
          }
          const wrap = el.closest('label')
          return (wrap?.textContent ?? '').trim().slice(0, 256)
        }

        function visibleText(el: DomElement): string {
          return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
        }

        function shortCss(el: DomElement): string {
          const tag = el.tagName.toLowerCase()
          const cls = [...el.classList].slice(0, 2).map(cssIdent).join('.')
          if (cls) return `${tag}.${cls}`
          return tag
        }

        function cssIdent(value: string): string {
          return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
        }

        function cssAttr(value: string): string {
          return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        }

        function framePathOf(el: DomElement): Array<{ urlPattern?: string; name?: string; selector?: string }> {
          const frames: Array<{ urlPattern?: string; name?: string; selector?: string }> = []
          let win: DomWindow | null = el.ownerDocument.defaultView
          while (win && win !== win.parent && frames.length < 4) {
            const frameEl = win.frameElement
            const name = (frameEl ? attr(frameEl, 'name') : '') || win.name
            const src = (frameEl ? attr(frameEl, 'src') : '') || win.location.href
            const selector = frameEl && attr(frameEl, 'id') ? `#${cssIdent(attr(frameEl, 'id'))}` : undefined
            frames.unshift({
              ...(name ? { name } : {}),
              ...(src ? { urlPattern: src.slice(0, 512) } : {}),
              ...(selector ? { selector } : {}),
            })
            win = win.parent
          }
          return frames
        }

        function nearestAnchor(el: DomElement, selfText: string): { withinText: string; scope: 'row' | 'nearest' } | undefined {
          const row = el.closest('tr, [role="row"], li')
          const source = row ?? el.parentElement
          if (!source) return undefined
          const text = (source.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (text.length < 2 || text.length > 40) return undefined
          if (/^\d+$/.test(text) || text === selfText) return undefined
          return { withinText: text, scope: row ? 'row' : 'nearest' }
        }
      },
      { x, y },
    )
    .catch(() => null)

  if (!picked) {
    return {
      outcome: 'NOT_FOUND',
      page: { url, title },
      diagnostics: { outcome: 'NOT_FOUND', candidatesTried: [] },
      source: 'managed',
    }
  }

  const target = targetFromPicked(picked)
  const observation = await highlightOnPage(page, target)
  if (!picked.cssFragile) return observation
  return {
    ...observation,
    diagnostics: {
      ...observation.diagnostics,
      framePathResolved: [...(observation.diagnostics.framePathResolved ?? []), 'fragile-css'],
    },
  }
}

function targetFromPicked(picked: PickedElement): TargetDescriptor {
  const candidates: LocatorCandidate[] = []
  if (picked.testId) candidates.push({ by: 'testId', value: picked.testId })
  if (picked.role && picked.accessibleName) {
    candidates.push({ by: 'role', value: picked.role, name: picked.accessibleName })
  }
  if (picked.label) candidates.push({ by: 'label', value: picked.label })
  const textOrTitle =
    picked.text && picked.title
      ? picked.text.length <= picked.title.length
        ? { by: 'text' as const, value: picked.text }
        : { by: 'title' as const, value: picked.title }
      : picked.text
        ? { by: 'text' as const, value: picked.text }
        : picked.title
          ? { by: 'title' as const, value: picked.title }
          : undefined
  if (textOrTitle && !candidates.some((item) => item.value === textOrTitle.value)) {
    candidates.push(textOrTitle)
  }
  if (picked.css) candidates.push({ by: 'css', value: picked.css })
  return {
    framePath: picked.framePath.slice(0, 4),
    candidates: candidates.slice(0, 5),
    ...(picked.anchor ? { anchor: picked.anchor } : {}),
  }
}

async function alternativesFor(
  page: Page,
  target: TargetDescriptor,
  outcome: TargetObservation['outcome'],
  tried: Array<{ index: number; by: string; value: string; matches: number }>,
): Promise<Array<{ index: number; reason: string }> | undefined> {
  if (outcome !== 'AMBIGUOUS') return undefined
  const ambiguous = tried.filter((item) => item.matches > 1)
  if (!ambiguous.length) return undefined
  const { frame } = await resolveFramePath(page, target.framePath, DEFAULT_LOCATE_MS).catch(() => ({
    frame: page.mainFrame(),
  }))
  const scoped = scopeForAnchor(frame, target.anchor)
  const result: Array<{ index: number; reason: string }> = []
  for (const item of ambiguous) {
    const candidate = target.candidates[item.index]
    if (!candidate) {
      result.push({ index: item.index, reason: `${item.by}=${item.value} 匹配 ${item.matches} 个` })
      continue
    }
    const labels: string[] = []
    const locator = locatorForCandidate(scoped, candidate)
    const limit = Math.min(item.matches, 5)
    for (let index = 0; index < limit; index += 1) {
      const text = await locator
        .nth(index)
        .evaluate((el) => {
          const row = el.closest('tr, [role="row"], li')
          return (row?.textContent ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
        })
        .catch(() => '')
      labels.push(text || `#${index + 1}`)
    }
    result.push({
      index: item.index,
      reason: `匹配 ${item.matches} 个：${labels.join(' / ')}`,
    })
  }
  return result
}
