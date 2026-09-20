import {
  MAP_FACT_MAX_BYTES,
  assertMapFactSize,
  containsSensitiveMapFields,
  enrichMapCondition,
  type MapCapturePolicy,
  type MapConditionSnapshot,
  type MapMissingReason,
  type MapNodeSetKind,
  type MapObservation,
  type MapSemanticSummary,
  type MapStateSummary,
  type MapStructuralSummary,
  type MapSurfaceCapability,
  type MapViewport,
  type JsonValue,
} from '@cairn/shared'

export type CollectedNamedNode = {
  role: string
  name: string
}

export type CollectedSurface = {
  title: string
  heading: string
  locale: string
  viewport?: MapViewport
  ready: boolean
  empty: boolean
  loading: boolean
  nodeCount: number
  truncated: boolean
  closedShadow: boolean
  canvas: boolean
  landmarks: CollectedNamedNode[]
  named: CollectedNamedNode[]
}

export type SurfaceObservationFields = {
  conditionSnapshot: MapConditionSnapshot
  regionRefs: MapObservation['regionRefs']
  nodeSetKind: MapNodeSetKind
  completeness: MapObservation['completeness']
  truncated: boolean
  missingReasons: MapMissingReason[]
  semanticSummary: MapSemanticSummary
  stateSummary: MapStateSummary
  structuralSummary: MapStructuralSummary
  surfaceCapability: MapSurfaceCapability
}

const HARD_SURFACE_GAPS = new Set<MapMissingReason>(['NOT_APPLICABLE', 'SURFACE_CHANGED'])

/**
 * 必须自包含：Playwright page.evaluate 只序列化本函数，不能引用外部符号。
 * 只读查询 DOM/ARIA，不点击、不调用页面业务函数、不读取输入值。
 */
export function collectAuthorizedSurface(maxNodes: number): CollectedSurface {
  const g = globalThis as typeof globalThis & {
    document?: {
      title?: string
      readyState?: string
      querySelector: (selector: string) => unknown
      querySelectorAll: (selector: string) => Iterable<unknown>
      getElementById?: (id: string) => { textContent?: string | null } | null
    }
    navigator?: { language?: string }
    getComputedStyle?: (el: unknown) => { display: string; visibility: string; opacity: string }
    innerWidth?: number
    innerHeight?: number
  }
  const empty: CollectedSurface = {
    title: '',
    heading: '',
    locale: '',
    ready: false,
    empty: true,
    loading: true,
    nodeCount: 0,
    truncated: false,
    closedShadow: false,
    canvas: false,
    landmarks: [],
    named: [],
  }
  const doc = g.document
  if (!doc) return empty

  const budget = Number.isFinite(maxNodes) ? Math.max(1, Math.min(1_000, Math.floor(maxNodes))) : 100
  const title = sanitizeName(typeof doc.title === 'string' ? doc.title : '')
  const ready = doc.readyState === 'complete'
  const locale = typeof g.navigator?.language === 'string' ? g.navigator.language.slice(0, 64) : ''
  const width = typeof g.innerWidth === 'number' ? g.innerWidth : 0
  const height = typeof g.innerHeight === 'number' ? g.innerHeight : 0
  const viewport =
    width > 0 && height > 0
      ? {
          category: (width >= 1024 ? 'desktop' : width >= 768 ? 'tablet' : width > 0 ? 'mobile' : 'other') as MapViewport['category'],
          widthPx: Math.min(16_384, Math.max(1, Math.floor(width))),
          heightPx: Math.min(16_384, Math.max(1, Math.floor(height))),
        }
      : undefined

  const landmarks: CollectedNamedNode[] = []
  const named: CollectedNamedNode[] = []
  const seen = new Set<string>()
  let nodeCount = 0
  let truncated = false
  let canvas = false
  try {
    canvas = Boolean(doc.querySelector('canvas'))
  } catch {
    canvas = false
  }

  const take = (el: unknown, fallbackRole: string, into: CollectedNamedNode[], allowEmptyName: boolean) => {
    if (truncated || nodeCount >= budget) {
      truncated = true
      return
    }
    if (!isVisible(g, el) || isPasswordField(el)) return
    nodeCount += 1
    const role = implicitRole(el, fallbackRole)
    const name = accessibleName(doc, el)
    if (!name && !allowEmptyName) return
    const key = `${role}|${name}`
    if (seen.has(key)) return
    seen.add(key)
    into.push({ role, name: name || role })
  }

  for (const el of safeQuery(doc, 'header,nav,main,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="search"],[role="form"],[role="region"]')) {
    take(el, 'region', landmarks, true)
    if (truncated) break
  }
  let heading = ''
  for (const el of safeQuery(doc, 'h1,h2,h3,[role="heading"]')) {
    take(el, 'heading', named, false)
    if (!heading) heading = accessibleName(doc, el)
    if (truncated) break
  }
  for (const el of safeQuery(
    doc,
    'a[href],button,[role="link"],[role="button"],[role="menuitem"],[role="tab"],[role="treeitem"],[class*="submenu__title"],[class*="menuLiContainer"],[class*="menu-item"]',
  )) {
    take(el, 'menuitem', named, false)
    if (truncated) break
  }

  return {
    title,
    heading,
    locale,
    viewport,
    ready,
    empty: !title && landmarks.length === 0 && named.length === 0,
    loading: !ready,
    nodeCount,
    truncated,
    closedShadow: false,
    canvas,
    landmarks: landmarks.slice(0, 8),
    named: named.slice(0, budget),
  }

  function safeQuery(root: NonNullable<typeof doc>, selector: string): unknown[] {
    try {
      return [...root.querySelectorAll(selector)]
    } catch {
      return []
    }
  }

  function attr(el: unknown, name: string): string {
    if (!el || typeof el !== 'object' || typeof (el as { getAttribute?: unknown }).getAttribute !== 'function') {
      return ''
    }
    const value = (el as { getAttribute: (key: string) => string | null }).getAttribute(name)
    return typeof value === 'string' ? value : ''
  }

  function implicitRole(el: unknown, fallback: string): string {
    const explicit = sanitizeRole(attr(el, 'role'))
    if (explicit) return explicit
    const tag = String((el as { tagName?: string } | null)?.tagName ?? '').toLowerCase()
    if (tag === 'header') return 'banner'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'aside') return 'complementary'
    if (tag === 'footer') return 'contentinfo'
    if (tag === 'form') return 'form'
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading'
    return sanitizeRole(fallback) || 'region'
  }

  function accessibleName(root: NonNullable<typeof doc>, el: unknown): string {
    const labelled = attr(el, 'aria-label')
    if (labelled) return sanitizeName(labelled)
    const labelledBy = attr(el, 'aria-labelledby').trim().split(/\s+/)[0]
    if (labelledBy && typeof root.getElementById === 'function') {
      const ref = root.getElementById(labelledBy)
      const fromRef = sanitizeName(ref?.textContent ?? '')
      if (fromRef) return fromRef
    }
    const own = ownText(el)
    if (own) return own
    const childCount = Number((el as { childElementCount?: number } | null)?.childElementCount ?? 0)
    if (childCount > 1 || isMenuContainer(el)) {
      const children = (el as { children?: Iterable<unknown> } | null)?.children
      if (children) {
        for (const child of children) {
          if (isNestedMenu(child)) continue
          const nested = firstLabel(child, 0)
          if (nested) return nested
        }
      }
      return ''
    }
    return sanitizeName(typeof (el as { textContent?: string } | null)?.textContent === 'string'
      ? (el as { textContent: string }).textContent
      : '')
  }

  function classNameOf(el: unknown): string {
    const value = (el as { className?: unknown } | null)?.className
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'baseVal' in value) return String((value as { baseVal?: unknown }).baseVal ?? '')
    return ''
  }

  function isNestedMenu(el: unknown): boolean {
    const role = sanitizeRole(attr(el, 'role'))
    if (role === 'menu' || role === 'menubar' || role === 'list' || role === 'group') return true
    const cls = classNameOf(el)
    return /(?:^| )el-menu(?: |$)/.test(cls) && !/el-menu-item|submenu__title/.test(cls)
  }

  function isMenuContainer(el: unknown): boolean {
    const cls = classNameOf(el)
    return /submenu|el-submenu|menuLiContainer/.test(cls) || sanitizeRole(attr(el, 'role')) === 'menuitem'
  }

  function firstLabel(el: unknown, depth: number): string {
    if (!el || depth > 4) return ''
    if (isNestedMenu(el)) return ''
    const own = ownText(el)
    if (own) return own
    const labelled = sanitizeName(attr(el, 'aria-label'))
    if (labelled) return labelled
    const children = (el as { children?: Iterable<unknown> } | null)?.children
    if (!children) return ''
    for (const child of children) {
      const nested = firstLabel(child, depth + 1)
      if (nested) return nested
    }
    return ''
  }

  function ownText(el: unknown): string {
    const nodes = (el as { childNodes?: Iterable<{ nodeType?: number; textContent?: string }> } | null)?.childNodes
    if (!nodes) return ''
    let text = ''
    for (const node of nodes) {
      if (node.nodeType === 3) text += node.textContent ?? ''
    }
    return sanitizeName(text)
  }

  function isVisible(host: typeof g, el: unknown): boolean {
    if (attr(el, 'aria-hidden') === 'true') return false
    if (typeof host.getComputedStyle !== 'function') return true
    try {
      const style = host.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    } catch {
      return true
    }
  }

  function isPasswordField(el: unknown): boolean {
    const tag = String((el as { tagName?: string } | null)?.tagName ?? '').toLowerCase()
    return tag === 'input' && attr(el, 'type').toLowerCase() === 'password'
  }

  function sanitizeName(value: string): string {
    const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, 64)
    if (!cleaned) return ''
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cleaned) && cleaned.length > 24) return ''
    return cleaned
  }

  function sanitizeRole(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
  }
}

export function isHardSurfaceGap(reason: MapMissingReason | undefined): reason is MapMissingReason {
  return Boolean(reason && HARD_SURFACE_GAPS.has(reason))
}

export function applyCollectedSurface(input: {
  collected?: CollectedSurface
  condition: MapConditionSnapshot
  capability: MapSurfaceCapability
  stateSummary: MapStateSummary
  collectFailed?: boolean
  framesBlocked?: boolean
  maxBytes?: number
}): SurfaceObservationFields {
  const collected = input.collected
  const missing: MapMissingReason[] = []
  if (input.collectFailed) missing.push('CAPABILITY_MISSING')
  if (input.framesBlocked) missing.push('CAPABILITY_MISSING')
  if (collected?.canvas) missing.push('CAPABILITY_MISSING')
  if (collected?.truncated) missing.push('TRUNCATED')

  const title = collected?.title ?? ''
  const heading = collected?.heading ?? ''
  const label = title || heading || 'document'
  const landmarks = collected?.landmarks ?? []
  const named = collected?.named ?? []
  const regionRefs = regionRefsFrom(landmarks)
  const predicates: MapSemanticSummary['predicates'] = [
    { name: 'role', value: 'document' },
    { name: 'label', value: label },
  ]
  if (title) predicates.push({ name: 'title', value: title })
  if (heading) predicates.push({ name: 'heading', value: heading })
  predicates.push({ name: 'landmarkCount', value: landmarks.length })
  predicates.push({ name: 'namedCount', value: named.length })

  const viewport = collected?.viewport
  const condition = enrichMapCondition(input.condition, {
    locale: collected?.locale,
    viewport,
  })
  const capability: MapSurfaceCapability = {
    ...input.capability,
    a11y: named.length > 0 || landmarks.length > 0 ? (collected?.truncated ? 'limited' : 'ok') : 'missing',
    canvas: collected?.canvas ? 'unsupported' : input.capability.canvas,
    shadow: collected?.closedShadow ? 'closed' : input.capability.shadow,
  }
  const pageState: Record<string, JsonValue> =
    input.stateSummary.regions.page &&
    typeof input.stateSummary.regions.page === 'object' &&
    !Array.isArray(input.stateSummary.regions.page)
      ? { ...(input.stateSummary.regions.page as Record<string, JsonValue>) }
      : {}
  if (collected) {
    pageState.empty = collected.empty
    pageState.ready = collected.ready
    pageState.loading = collected.loading
  }

  let features: MapStructuralSummary['features'] = {
    kind: 'surface-inventory',
    title,
    heading,
    landmarks,
    named,
  }
  let truncated = Boolean(collected?.truncated || input.collectFailed)
  let nodeCount = collected?.nodeCount ?? 0
  const maxBytes = Math.min(input.maxBytes ?? MAP_FACT_MAX_BYTES, MAP_FACT_MAX_BYTES)
  const fit = (candidate: unknown) => {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(candidate)).length
      if (bytes > maxBytes) return false
      assertMapFactSize(candidate, '观察')
      return !containsSensitiveMapFields(candidate)
    } catch {
      return false
    }
  }
  if (!fit(features)) {
    features = { kind: 'surface-inventory', title, heading, landmarks, named: [] }
    truncated = true
    if (!missing.includes('TRUNCATED')) missing.push('TRUNCATED')
  }
  if (!fit(features)) {
    features = { kind: 'surface-inventory', title, heading, landmarks: [], named: [] }
    truncated = true
    if (!missing.includes('REDACTION') && containsSensitiveMapFields({ kind: 'surface-inventory', title, heading, landmarks, named })) {
      missing.push('REDACTION')
    } else if (!missing.includes('TRUNCATED')) missing.push('TRUNCATED')
  }
  if (!fit(features)) {
    features = undefined
    truncated = true
  }

  return {
    conditionSnapshot: condition,
    regionRefs,
    nodeSetKind: 'region',
    completeness: truncated ? 'partial' : nodeCount > 0 ? 'partial' : 'none',
    truncated,
    missingReasons: uniqueReasons(missing),
    semanticSummary: { predicates: predicates.slice(0, 32) },
    stateSummary: { regions: { ...input.stateSummary.regions, page: pageState } },
    structuralSummary: { nodeCount, truncated, ...(features ? { features } : {}) },
    surfaceCapability: capability,
  }
}

function regionRefsFrom(landmarks: readonly CollectedNamedNode[]): MapObservation['regionRefs'] {
  const refs: MapObservation['regionRefs'] = []
  const seen = new Set<string>()
  const kindFor = (role: string): MapNodeSetKind =>
    role === 'navigation' || role === 'banner' || role === 'contentinfo' ? 'chrome' : 'region'
  for (const item of landmarks) {
    const key = (item.role || 'region').slice(0, 64)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ key, kind: kindFor(item.role) })
    if (refs.length >= 8) return refs
  }
  if (refs.length === 0) refs.push({ key: 'main', kind: 'region' })
  return refs
}

function uniqueReasons(values: MapMissingReason[]): MapMissingReason[] {
  return [...new Set(values)].slice(0, 8)
}

export function capturePolicyNodeLimit(policy: MapCapturePolicy): number {
  return Math.max(1, Math.min(policy.maxNodes, 1_000))
}
