import { randomUUID } from 'node:crypto'
import { RESOLVED_ATTRIBUTE, sanitizeLocatorLabel, type LocatorCandidate, type TargetDescriptor, type TargetObservation } from '@cairn/shared'
import type { Page } from './runtime'
import { locatorForCandidate, resolveFramePath, scopeForAnchor } from './runtime'
import { generateCandidateFromElement } from './reverse-locator'
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
  const token = randomUUID()
  const picked = await page
    .evaluate(
      ({ x, y, token, resolvedAttr }) => {
        type DomNode = { nodeType: number; textContent: string | null }
        type DomElement = {
          tagName: string
          classList: Iterable<string>
          textContent: string | null
          innerText?: string
          childNodes: Iterable<DomNode>
          parentElement: DomElement | null
          ownerDocument: { defaultView: DomWindow | null; querySelector: (sel: string) => DomElement | null }
          getAttribute: (name: string) => string | null
          setAttribute: (name: string, value: string) => void
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
        const pickRoles = new Set([
          'button',
          'link',
          'menuitem',
          'menuitemcheckbox',
          'menuitemradio',
          'tab',
          'option',
          'checkbox',
          'radio',
          'textbox',
          'searchbox',
          'combobox',
          'switch',
          'heading',
          'img',
          'treeitem',
          'gridcell',
          'cell',
          'columnheader',
          'rowheader',
        ])
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
          const host = bestPickHost(hit)
          host.setAttribute(resolvedAttr, token)
          return describeElement(host)
        }

        function describeElement(el: DomElement): PickedElement {
          const testId = attr(el, 'data-testid') || attr(el, 'data-test-id')
          const role = roleOf(el)
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
          const semantic = Boolean(testId || (role && accessibleName) || label || text)
          return {
            testId: testId || undefined,
            role: role || undefined,
            accessibleName: accessibleName || undefined,
            label: label || undefined,
            text: text || undefined,
            title: titleAttr || undefined,
            css,
            cssFragile: !id && !name && !semantic,
            tag,
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            framePath: framePathOf(el),
            anchor: nearestAnchor(el, text),
          }
        }

        function attr(el: DomElement, name: string): string {
          return (el.getAttribute(name) ?? '').trim()
        }

        function roleOf(el: DomElement): string {
          return attr(el, 'role') || implicitRole(el)
        }

        function implicitRole(el: DomElement): string {
          const tag = el.tagName.toLowerCase()
          if (tag === 'button') return 'button'
          if (tag === 'a' && attr(el, 'href')) return 'link'
          if (tag === 'input') {
            const type = (attr(el, 'type') || 'text').toLowerCase()
            if (type === 'hidden') return ''
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
            return 'textbox'
          }
          if (tag === 'select') return 'combobox'
          if (tag === 'textarea') return 'textbox'
          if (/^h[1-6]$/.test(tag)) return 'heading'
          if (tag === 'img') return 'img'
          if (tag === 'summary') return 'button'
          if (tag === 'option') return 'option'
          if (tag === 'td') return 'cell'
          if (tag === 'th') return 'columnheader'
          return ''
        }

        function ownText(el: DomElement): string {
          let text = ''
          for (const node of el.childNodes) {
            if (node.nodeType === 3) text += node.textContent ?? ''
          }
          return text.replace(/\s+/g, ' ').trim()
        }

        function shortInnerText(el: DomElement): string {
          return (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
        }

        function visibleText(el: DomElement): string {
          const own = ownText(el)
          if (own && own.length <= 80) return own
          const inner = shortInnerText(el)
          if (inner && inner.length <= 40) return inner
          return ''
        }

        function accessibleNameOf(el: DomElement): string {
          const named = attr(el, 'aria-label') || labelOf(el) || attr(el, 'title') || visibleText(el)
          return named.slice(0, 80)
        }

        function isDocumentRoot(el: DomElement): boolean {
          const tag = el.tagName.toLowerCase()
          return tag === 'html' || tag === 'body' || tag === 'main'
        }

        function isInteractive(el: DomElement): boolean {
          const tag = el.tagName.toLowerCase()
          if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true
          if (tag === 'a' && attr(el, 'href')) return true
          if (tag === 'input' && (attr(el, 'type') || 'text').toLowerCase() !== 'hidden') return true
          return pickRoles.has(roleOf(el))
        }

        function hasTestId(el: DomElement): boolean {
          return Boolean(attr(el, 'data-testid') || attr(el, 'data-test-id'))
        }

        function bestPickHost(hit: DomElement): DomElement {
          if (hasTestId(hit) || isInteractive(hit)) return hit
          let current = hit.parentElement
          for (let i = 0; i < 6 && current && !isDocumentRoot(current); i += 1) {
            if (hasTestId(current)) return current
            const name = accessibleNameOf(current)
            if (isInteractive(current) && name && name.length <= 40) return current
            current = current.parentElement
          }
          return hit
        }

        function labelOf(el: DomElement): string {
          const id = attr(el, 'id')
          if (id) {
            const labelled = el.ownerDocument.querySelector(`label[for="${cssAttr(id)}"]`)
            const text = labelled?.textContent?.trim() ?? ''
            if (text) return text.slice(0, 80)
          }
          const wrap = el.closest('label')
          return (wrap?.textContent ?? '').trim().slice(0, 80)
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
      { x, y, token, resolvedAttr: RESOLVED_ATTRIBUTE },
    )
    .catch(() => null)

  let reverseCandidate: LocatorCandidate | undefined
  try {
    if (picked && !picked.testId && picked.framePath.length === 0) {
      const reverse = await generateCandidateFromElement(page, token)
      reverseCandidate = reverse.candidate
    }
  } catch {
    reverseCandidate = undefined
  } finally {
    await page
      .locator(`[${RESOLVED_ATTRIBUTE}="${token}"]`)
      .first()
      .evaluate((el, name) => el.removeAttribute(name), RESOLVED_ATTRIBUTE)
      .catch(() => undefined)
  }

  if (!picked) {
    return {
      outcome: 'NOT_FOUND',
      page: { url, title },
      diagnostics: { outcome: 'NOT_FOUND', candidatesTried: [] },
      source: 'managed',
    }
  }

  const target = mergePickedTarget(targetFromPicked(picked), reverseCandidate)
  const observation = await highlightOnPage(page, target)
  const preview = observation.preview ?? {
    ...(picked.box ? { box: picked.box } : {}),
    tag: picked.tag,
    text: picked.text?.slice(0, 80),
  }
  const unique = observation.diagnostics.candidatesTried.find((item) => item.matches === 1)
  if (unique?.by !== 'css') return { ...observation, preview }
  return {
    ...observation,
    preview,
    diagnostics: {
      ...observation.diagnostics,
      framePathResolved: [...(observation.diagnostics.framePathResolved ?? []), 'fragile-css'],
    },
  }
}

function mergePickedTarget(target: TargetDescriptor, reverse?: LocatorCandidate): TargetDescriptor {
  if (!reverse) return target
  const rest = target.candidates.filter(
    (item) => !(item.by === reverse.by && item.value === reverse.value && item.name === reverse.name),
  )
  return {
    ...target,
    candidates: [reverse, ...rest].slice(0, 5),
  }
}

function targetFromPicked(picked: PickedElement): TargetDescriptor {
  const candidates: LocatorCandidate[] = []
  if (picked.testId) candidates.push({ by: 'testId', value: picked.testId })
  const accessibleName = picked.accessibleName ? sanitizeLocatorLabel(picked.accessibleName) : ''
  if (picked.role && accessibleName) {
    candidates.push({ by: 'role', value: picked.role, name: accessibleName })
  }
  const label = picked.label ? sanitizeLocatorLabel(picked.label) : ''
  if (label) candidates.push({ by: 'label', value: label })
  const text = picked.text ? sanitizeLocatorLabel(picked.text) : ''
  const title = picked.title ? sanitizeLocatorLabel(picked.title) : ''
  const textOrTitle =
    text && title
      ? text.length <= title.length
        ? { by: 'text' as const, value: text }
        : { by: 'title' as const, value: title }
      : text
        ? { by: 'text' as const, value: text }
        : title
          ? { by: 'title' as const, value: title }
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
): Promise<Array<{ index: number; reason: string; label?: string }> | undefined> {
  if (outcome !== 'AMBIGUOUS') return undefined
  const ambiguous = tried.filter((item) => item.matches > 1)
  if (!ambiguous.length) return undefined
  const { frame } = await resolveFramePath(page, target.framePath, DEFAULT_LOCATE_MS).catch(() => ({
    frame: page.mainFrame(),
  }))
  const scoped = scopeForAnchor(frame, target.anchor)
  const result: Array<{ index: number; reason: string; label?: string }> = []
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
    for (const label of labels) {
      result.push({
        index: item.index,
        reason: `匹配 ${item.matches} 个：${label}`,
        label,
      })
    }
  }
  return result
}
