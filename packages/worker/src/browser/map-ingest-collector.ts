import type { Locator, Page } from 'playwright'
// The callbacks below execute in the page, while this package compiles against Node libs.
declare const document: any
declare const location: { href: string }
declare const Node: { TEXT_NODE: number }
declare const HTMLInputElement: any
declare const HTMLSelectElement: any
type Element = any
type HTMLElement = any
import {
  accessPathMatches,
  buildPageKey,
  buildPresentationStateKey,
  buildViewStateKey,
  computeControlFingerprint,
  isUnsafeActionText,
  sanitizeExplorationUrl,
  syncSha256,
  urlAllowedByAccessRules,
  type MapIngestCursor,
  type MapIngestElement,
  type MapIngestPageSnapshot,
  type MapIngestQueueNode,
  type MapIngestStep,
  type MapMenuEntry,
  type TargetAccessPolicy,
  type TargetDescriptor,
} from '@cairn/shared'
import { affectsCapturedSurface, type BlockedRequestRecord, type DialogRecord,
  type ExploreGuardController } from './explore-network-guard.js'

type MenuNode = {
  label: string
  href?: string
  ancestors: string[]
  role: string
  hasChildren: boolean
  expanded: boolean
}
type MenuScan = { found: boolean; heuristic: boolean; fingerprint: string; selector: string; index: number; popupIds: string[]; nodes: MenuNode[] }
export type IngestNodeResult = { label: string; code: string; pageKey?: string }
export type IngestSliceResult = {
  cursor: MapIngestCursor
  nodes: IngestNodeResult[]
  detectedMenus: Array<{ label: string; url?: string; menuAnchor: { label: string }; hasChildren: boolean }>
  blockedPostPaths: Array<{ path: string; count: number }>
  inferredReadPostPaths: Array<{ path: string; count: number }>
  inferredReadPostCount: number
  blockedReasonCounts: Array<{ reason: string; count: number }>
  blockedImpactCounts: { unclassified: number; unreadable_ping: number; verified_non_content_rule: number }
  blockedRequests: BlockedRequestRecord[]
  dialogs: number
  dialogRecords: DialogRecord[]
}

function guardSummary(guard: ExploreGuardController): Pick<IngestSliceResult,
  'blockedPostPaths' | 'inferredReadPostPaths' | 'inferredReadPostCount'
  | 'blockedReasonCounts' | 'blockedImpactCounts' | 'blockedRequests' | 'dialogs' | 'dialogRecords'> {
  const blockedPost = new Map<string, number>()
  const inferredReadPost = new Map<string, number>()
  const blockedReasons = new Map<string, number>()
  const blockedImpactCounts = { unclassified: 0, unreadable_ping: 0, verified_non_content_rule: 0 }
  for (const request of guard.getBlockedRequests()) {
    blockedReasons.set(request.reason, (blockedReasons.get(request.reason) ?? 0) + 1)
    const basis = request.resourceType === 'ping' ? 'unreadable_ping'
      : request.impactBasis === 'verified_non_content_rule' ? 'verified_non_content_rule' : 'unclassified'
    blockedImpactCounts[basis]++
    if (request.method === 'POST') blockedPost.set(request.url, (blockedPost.get(request.url) ?? 0) + 1)
  }
  for (const request of guard.getInferredReadPosts())
    inferredReadPost.set(request.url, (inferredReadPost.get(request.url) ?? 0) + 1)
  return {
    blockedPostPaths: [...blockedPost].sort((left, right) => right[1] - left[1]).slice(0, 20)
      .map(([path, count]) => ({ path, count })),
    inferredReadPostPaths: [...inferredReadPost].sort((left, right) => right[1] - left[1]).slice(0, 20)
      .map(([path, count]) => ({ path, count })),
    inferredReadPostCount: guard.getInferredReadPosts().length,
    blockedReasonCounts: [...blockedReasons].sort((left, right) => right[1] - left[1]).slice(0, 20)
      .map(([reason, count]) => ({ reason, count })),
    blockedImpactCounts,
    blockedRequests: guard.getBlockedRequests().slice(0, 20),
    dialogs: guard.getDialogs().length, dialogRecords: guard.getDialogs().slice(0, 20),
  }
}

function blockedSurfaceCount(guard: ExploreGuardController): number {
  return guard.getBlockedRequests().filter(affectsCapturedSurface).length
}

function norm(value: string): string { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase() }
function limitedKey(value: string): string { return value.length <= 512 ? value : value.slice(0, 420) + ':' + syncSha256(value) }

function routePath(url: URL, hashPrefixes: readonly string[]): string {
  for (const prefix of hashPrefixes) {
    if (url.hash.startsWith(prefix)) {
      const suffix = url.hash.slice(prefix.length).split('?')[0] ?? ''
      return '/' + suffix.replace(/^\/+/, '')
    }
  }
  return url.pathname
}

function routePattern(url: URL, hashPrefixes: readonly string[]): string {
  const hashRoute = hashPrefixes.some(prefix => url.hash.startsWith(prefix))
  return url.origin + url.pathname + (hashRoute ? '#' + routePath(url, hashPrefixes) : '')
}

function urlAllowedForMenu(url: string, policy: TargetAccessPolicy, hashPrefixes: readonly string[]): boolean {
  if (!urlAllowedByAccessRules(url, policy.rules, ['business_surface'])) return false
  try {
    const parsed = new URL(url)
    if (!hashPrefixes.some(prefix => parsed.hash.startsWith(prefix))) return true
    const virtualPath = routePath(parsed, hashPrefixes)
    return !policy.rules.some(rule => rule.purpose === 'business_surface' && rule.effect === 'deny'
      && new URL(rule.origin).origin === parsed.origin
      && accessPathMatches(virtualPath, rule.pathPrefix ?? '/'))
  } catch { return false }
}

/** R1 DOM ancestry, then R2 segment-safe URL prefix; only nodes inside a detected menu reach this function. */
export function belongsToMenuSubtree(node: MenuNode, entry: MapMenuEntry, hashPrefixes: readonly string[] = ['#/']): boolean {
  const anchor = norm(entry.menuAnchor?.label ?? entry.name)
  if (node.ancestors.some(label => norm(label) === anchor)) return true
  if (!entry.url || !node.href) return false
  try {
    const parent = new URL(entry.url)
    const child = new URL(node.href)
    const parentHashRoute = hashPrefixes.some(prefix => parent.hash.startsWith(prefix))
    const childHashRoute = hashPrefixes.some(prefix => child.hash.startsWith(prefix))
    return child.origin === parent.origin && parentHashRoute === childHashRoute
      && accessPathMatches(routePath(child, hashPrefixes), routePath(parent, hashPrefixes))
  } catch { return false }
}

export async function scanMenu(
  page: Page, preferredLabels: readonly string[] = [], relatedEntryUrl?: string,
  allowedSpaHashPrefixes: readonly string[] = ['#/'],
): Promise<MenuScan> {
  const result = await page.evaluate(({ labels, entryUrl, hashPrefixes }) => {
    let selector = 'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tree"],.ant-menu,.el-menu,.arco-menu,.ivu-menu,.t-menu,.n-menu'
    const itemSelector = '[role="menuitem"],[role="treeitem"],a[href],button,[role="button"],.ant-menu-item,.ant-menu-submenu-title,.el-menu-item,.el-sub-menu__title'
    let roots: HTMLElement[] = [...document.querySelectorAll(selector)]
    const wanted = new Set(labels.map(label => label.trim().replace(/\s+/g, ' ').toLocaleLowerCase()))
    const semanticCandidates = roots.map((root, rootIndex) => {
      const items = [...root.querySelectorAll(itemSelector)].filter(item => {
        const rect = item.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !item.closest('form')
      })
      const matches = items.filter(item => wanted.has((item.getAttribute('aria-label') || item.textContent || '')
        .trim().replace(/\s+/g, ' ').toLocaleLowerCase())).length
      return { rootIndex, count: items.length, matches }
    }).filter(item => item.count > 0)
      .sort((a, b) => b.matches - a.matches || b.count - a.count || a.rootIndex - b.rootIndex)
    let index = semanticCandidates[0]?.rootIndex ?? -1
    let heuristic = false
    if (index < 0) {
      selector = 'aside,header,[class*="sidebar"],[class*="Sidebar"]'
      roots = [...document.querySelectorAll(selector)]
      const viewportWidth = document.documentElement.clientWidth
      const viewportHeight = document.documentElement.clientHeight
      const candidates = roots.map((root, rootIndex) => ({ root, rootIndex, rect: root.getBoundingClientRect() }))
        .filter(({ root, rect }) => rect.width > 0 && rect.height > 0
          && (rect.left < viewportWidth * 0.35 || rect.top < viewportHeight * 0.2)
          && [...root.querySelectorAll(itemSelector)].filter(item => {
            const text = (item.getAttribute('aria-label') || item.textContent || '').trim()
            return text.length > 0 && text.length <= 48 && !item.closest('form')
          }).length >= 3)
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
      index = candidates[0]?.rootIndex ?? -1
      heuristic = index >= 0
    }
    if (index < 0) return { found: false, heuristic: false, selector, index: 0, popupIds: [], nodes: [] }
    const root = roots[index]!
    const nameOf = (element: Element): string => {
      const labelled = element.getAttribute('aria-label') || element.getAttribute('title')
      if (labelled) return labelled.trim().replace(/\s+/g, ' ').slice(0, 128)
      const direct = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent ?? '').join(' ').trim().replace(/\s+/g, ' ')
      if (direct) return direct.slice(0, 128)
      return (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 128)
    }
    const nodes: MenuNode[] = []
    const seen = new Set<string>()
    const popupIds: string[] = []
    const pending: Array<{ container: HTMLElement; inherited: string[]; routeBound: boolean }> = [
      { container: root, inherited: [], routeBound: false },
    ]
    let relatedRoute: ((raw: string) => boolean) | undefined
    if (entryUrl && labels.length === 1) {
      try {
        const entry = new URL(entryUrl)
        const route = (url: URL) => {
          for (const prefix of hashPrefixes) if (url.hash.startsWith(prefix))
            return '/' + url.hash.slice(prefix.length).split('?')[0]!.replace(/^\/+/, '')
          return url.pathname
        }
        const base = route(entry).replace(/\/+$/, '') || '/'
        relatedRoute = raw => {
          try {
            const url = new URL(raw, location.href)
            const path = route(url)
            return url.origin === entry.origin && (path === base || path.startsWith(base + '/'))
          } catch { return false }
        }
        for (const other of roots) {
          if (pending.length >= 5) break
          if (other === root || root.contains(other) || other.contains(root)) continue
          const rect = other.getBoundingClientRect()
          if (!rect.width || !rect.height) continue
          const linked = [...other.querySelectorAll('a[href]')].some(link => {
            const linkRect = link.getBoundingClientRect()
            return linkRect.width > 0 && linkRect.height > 0 && relatedRoute!(link.getAttribute('href')!)
          })
          if (linked) pending.push({ container: other, inherited: [labels[0]!], routeBound: true })
        }
      } catch { /* An invalid entry URL cannot authorize another menu root. */ }
    }
    const visited = new Set<Element>()
    while (pending.length && nodes.length < 500) {
      const next = pending.shift()!
      if (visited.has(next.container)) continue
      visited.add(next.container)
      for (const element of next.container.querySelectorAll(itemSelector) as HTMLElement[]) {
        if (nodes.length >= 500) break
        if (element.closest('form') || element.matches('button[type="submit"],input')) continue
        if (element.querySelector(':scope > a[href]') && !element.hasAttribute('aria-controls')
          && !element.hasAttribute('aria-expanded')) continue
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        const label = nameOf(element)
        if (!label) continue
        const ancestors: string[] = [...next.inherited]
        const local: string[] = []
        let parent = element.parentElement
        while (parent && parent !== next.container) {
          if (parent.matches('li,[role="menuitem"],[role="treeitem"],.ant-menu-submenu,.el-sub-menu')) {
            const title = parent.querySelector(':scope > .ant-menu-submenu-title,:scope > .el-sub-menu__title,:scope > [role="menuitem"],:scope > a')
            const ancestor = nameOf(title ?? parent)
            if (ancestor && ancestor !== label && !local.includes(ancestor)) local.unshift(ancestor)
          }
          parent = parent.parentElement
        }
        ancestors.push(...local)
        const rawHref = element.getAttribute('href') ?? element.closest('a[href]')?.getAttribute('href')
        let href: string | undefined
        if (rawHref && rawHref !== '#') {
          try { href = new URL(rawHref, location.href).href } catch { /* ignored */ }
        }
        if (next.routeBound && (!href || !relatedRoute?.(href))) continue
        const role = element.getAttribute('role') || element.tagName.toLowerCase()
        const hasChildren = element.hasAttribute('aria-expanded')
          || element.hasAttribute('aria-controls') || element.hasAttribute('aria-owns')
          || !!element.closest('.ant-menu-submenu,.el-sub-menu')
          || !!element.querySelector('[role="menuitem"],[role="treeitem"],a[href]')
        const key = [label, href, ancestors.join('>')].join('|')
        if (!seen.has(key)) {
          seen.add(key)
          nodes.push({ label, href, ancestors, role, hasChildren, expanded: element.getAttribute('aria-expanded') === 'true' })
        }
        const controlled = [element.getAttribute('aria-controls'), element.getAttribute('aria-owns')].filter(Boolean) as string[]
        const dataId = element.getAttribute('data-menu-id')
        if (dataId) for (const popup of document.querySelectorAll('.ant-menu-submenu-popup[id]') as HTMLElement[]) {
          if (popup.id.startsWith(dataId + '-popup')) controlled.push(popup.id)
        }
        for (const id of controlled) {
          const popup = document.getElementById(id)
          if (!popup || root.contains(popup) || visited.has(popup)) continue
          if (!popup.matches('[role="menu"],.ant-menu-submenu-popup,.ant-menu,.el-menu')
            && !popup.querySelector('[role="menu"],.ant-menu,.el-menu')) continue
          popupIds.push(id)
          pending.push({ container: popup, inherited: [...ancestors, label], routeBound: next.routeBound })
        }
      }
    }
    return { found: true, heuristic, selector, index, popupIds: [...new Set(popupIds)], nodes }
  }, { labels: [...preferredLabels], entryUrl: relatedEntryUrl, hashPrefixes: [...allowedSpaHashPrefixes] })
  return { ...result, fingerprint: syncSha256(result.nodes.filter(node => node.ancestors.length === 0)
    .map(node => norm(node.label)).join('|')) }
}

async function scanSettledMenu(
  page: Page, preferredLabels: readonly string[], settleSeconds: number, signal: AbortSignal,
): Promise<MenuScan> {
  let scan = await scanMenu(page, preferredLabels)
  const deadline = Date.now() + settleSeconds * 1000
  while (!scan.found && !signal.aborted && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(250, deadline - Date.now()))
    scan = await scanMenu(page, preferredLabels)
  }
  return scan
}

async function resolveDescriptor(scope: Page | Locator, descriptor?: TargetDescriptor): Promise<Locator | null> {
  if (!descriptor || descriptor.framePath.length || descriptor.anchor) return null
  for (const candidate of descriptor.candidates) {
    let locator: Locator
    try {
      switch (candidate.by) {
        case 'role': locator = scope.getByRole(candidate.value as Parameters<Page['getByRole']>[0],
          candidate.name ? { name: candidate.name, exact: true } : {}); break
        case 'label': locator = scope.getByLabel(candidate.value, { exact: true }); break
        case 'text': locator = scope.getByText(candidate.value, { exact: true }); break
        case 'title': locator = scope.getByTitle(candidate.value, { exact: true }); break
        case 'testId': locator = scope.getByTestId(candidate.value); break
        case 'css': locator = scope.locator(candidate.value); break
      }
      if (await locator.count() === 1 && await locator.isVisible()) return locator
    } catch { /* Try the next deterministic candidate. */ }
  }
  return null
}

async function menuItem(page: Page, scan: MenuScan, label: string, descriptor?: TargetDescriptor, entryUrl?: string) {
  const root = page.locator(scan.selector).nth(scan.index)
  const anchored = await resolveDescriptor(root, descriptor)
  if (anchored) return anchored
  if (entryUrl) {
    const links = root.getByRole('link', { name: label, exact: true })
    for (let index = 0; index < Math.min(await links.count(), 64); index++) {
      const link = links.nth(index)
      const href = await link.getAttribute('href')
      if (!href) continue
      try {
        if (new URL(href, page.url()).href === entryUrl && await link.isVisible()) return link
      } catch { /* The label fallback below remains available. */ }
    }
  }
  const roles = root.getByRole('menuitem', { name: label, exact: true })
  if (await roles.count() === 1) return roles
  const tree = root.getByRole('treeitem', { name: label, exact: true })
  if (await tree.count() === 1) return tree
  const text = root.getByText(label, { exact: true })
  if (await text.count() === 1) return text
  const popupRole = page.getByRole('menuitem', { name: label, exact: true })
  if (await popupRole.count() !== 1) return null
  const inPopup = await popupRole.evaluate((element, popupIds) => popupIds.some(id => document.getElementById(id)?.contains(element)), scan.popupIds)
  return inPopup ? popupRole : null
}

async function arrivedAtEntry(page: Page, entry: MapMenuEntry): Promise<boolean> {
  if (await resolveDescriptor(page, entry.arrivalTarget)) return true
  const title = await page.title().catch(() => '')
  return Boolean(entry.arrivalName && norm(title).includes(norm(entry.arrivalName)))
}

async function waitForEntryArrival(page: Page, entry: MapMenuEntry, settleSeconds: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + settleSeconds * 1000
  while (!signal.aborted) {
    if (await arrivedAtEntry(page, entry)) return true
    if (Date.now() >= deadline) break
    await page.waitForTimeout(Math.min(250, deadline - Date.now()))
  }
  return false
}

async function waitForVisibleSurface(page: Page, settleSeconds: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + settleSeconds * 1000
  let stableFallback = 0
  let previousSignature = ''
  while (!signal.aborted) {
    const surface = await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const selectors = 'h1,h2,h3,h4,h5,h6,[role="heading"],a[href],button,[role="button"],input,textarea,select,[role="combobox"],th,[role="columnheader"],[role="tab"],[role="menuitem"],.ant-card-head-title,.ant-statistic-title,.ant-descriptions-item-label'
      const controls = [...document.querySelectorAll(selectors)].filter(visible)
      const content = [...document.querySelectorAll('main,[role="main"],.ant-layout-content,.content-wrapper,.rightBody')]
        .filter(visible).find(element => !element.closest('nav,aside,header,[role="navigation"]'))
      const contentControls = content ? controls.filter(element => content.contains(element)) : []
      const contentText = (content as HTMLElement | undefined)?.innerText?.trim() ?? ''
      return {
        visible: controls.length > 0,
        hasContentRoot: Boolean(content),
        contentReady: Boolean(content && (contentText.length >= 24 || contentControls.some(element =>
          element.matches('h1,h2,h3,h4,h5,h6,[role="heading"],button,input,select,th,[role="columnheader"]')))),
        signature: `${controls.length}:${document.body.innerText.length}`,
      }
    })
    if (surface.contentReady) return true
    if (surface.visible && !surface.hasContentRoot) {
      stableFallback = surface.signature === previousSignature ? stableFallback + 1 : 0
      if (stableFallback >= 3) return true
    }
    previousSignature = surface.signature
    if (Date.now() >= deadline) break
    await page.waitForTimeout(Math.min(250, deadline - Date.now()))
  }
  return false
}

function withinEntryRoute(currentUrl: string, entryUrl: string, hashPrefixes: readonly string[]): boolean {
  try {
    const current = new URL(currentUrl)
    const entry = new URL(entryUrl)
    const currentHashRoute = hashPrefixes.some(prefix => current.hash.startsWith(prefix))
    const entryHashRoute = hashPrefixes.some(prefix => entry.hash.startsWith(prefix))
    return current.origin === entry.origin && currentHashRoute === entryHashRoute
      && accessPathMatches(routePath(current, hashPrefixes), routePath(entry, hashPrefixes))
  } catch { return false }
}

async function captureElements(page: Page, maxOptionReads: number) {
  return page.evaluate((maxReads) => {
    const selectors = 'h1,h2,h3,h4,h5,h6,[role="heading"],a[href],button,[role="button"],input,textarea,select,[role="combobox"],th,[role="columnheader"],[role="tab"],[role="menuitem"],.ant-card-head-title,.ant-statistic-title,.ant-descriptions-item-label'
    const items: Array<{ category: 'navigation' | 'input' | 'action_button' | 'table_column' | 'display'; role: string; name: string; testId?: string; id?: string; options?: string[]; section?: string }> = []
    let reads = 0
    for (const element of document.querySelectorAll(selectors) as HTMLElement[]) {
      if (items.length >= 500) break
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      if (element instanceof HTMLInputElement && ['hidden', 'password'].includes(element.type)) continue
      const tag = element.tagName.toLowerCase()
      const role = element.getAttribute('role') || (tag === 'input'
        ? element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.type : 'textbox'
        : /^h[1-6]$/.test(tag) ? 'heading' : tag === 'a' ? 'link' : tag === 'th' ? 'columnheader' : tag)
      const ownLabel = (element instanceof HTMLInputElement || element instanceof HTMLSelectElement)
        ? [...(element.labels?.[0]?.childNodes ?? [])].filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent ?? '').join(' ') : ''
      const name = (element.getAttribute('aria-label')
        || ownLabel
        || element.getAttribute('placeholder')
        || element.getAttribute('title') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 128)
      if (!name) continue
      const category = tag === 'input' || tag === 'textarea' || tag === 'select' || role === 'combobox'
        ? 'input' : tag === 'th' || role === 'columnheader' ? 'table_column'
        : tag === 'button' || role === 'button' ? 'action_button'
        : tag === 'a' || role === 'menuitem' ? 'navigation' : 'display'
      let options: string[] | undefined
      if (element instanceof HTMLSelectElement && reads < maxReads) {
        options = [...element.options].map(option => option.text.trim().slice(0, 128)).filter(Boolean).slice(0, 50)
        reads++
      }
      const heading = element.closest('section,[role="region"],form')?.querySelector('h1,h2,h3,[role="heading"]')
      items.push({ category, role, name, testId: element.getAttribute('data-testid') ?? undefined,
        id: element.id || undefined, options, section: heading?.textContent?.trim().slice(0, 128) })
    }
    return { title: document.title.slice(0, 200), items }
  }, maxOptionReads)
}

async function readCustomOptions(
  page: Page, limit: number, deadlineMs: number, guard: ExploreGuardController, dialogsBefore: number,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  const controls = page.locator('[role="combobox"],.ant-select-selector,.el-select .el-input')
  const count = Math.min(await controls.count(), 64)
  let attempts = 0
  for (let index = 0; index < count; index++) {
    if (attempts >= limit || Date.now() >= deadlineMs || guard.getDialogs().length > dialogsBefore) break
    const control = controls.nth(index)
    if (!await control.isVisible().catch(() => false)) continue
    const inContent = await control.evaluate(element => !element.closest(
      'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tree"],aside,header,[class*="sidebar"],[class*="Sidebar"],form',
    ))
    if (!inContent) continue
    const name = (await control.getAttribute('aria-label')
      || await control.getAttribute('placeholder')
      || await control.getAttribute('title')
      || await control.textContent() || '').trim().replace(/\s+/g, ' ').slice(0, 128)
    if (!name || isUnsafeActionText(name)) continue
    attempts++
    try {
      await control.click({ timeout: Math.max(50, Math.min(1500, deadlineMs - Date.now())) })
      const labels = await page.locator('[role="option"],.ant-select-item-option,.el-select-dropdown__item')
        .allTextContents()
      found.set(name, [...new Set(labels.map(value => value.trim().slice(0, 128)).filter(Boolean))].slice(0, 50))
    } catch { /* no option evidence */ }
    finally { await page.keyboard.press('Escape').catch(() => {}) }
  }
  return found
}

async function captureExpandablePanels(
  page: Page, deadlineMs: number, guard: ExploreGuardController, dialogsBefore: number,
  read: () => ReturnType<typeof captureElements>,
): Promise<{
  captured: Awaited<ReturnType<typeof captureElements>>; restoreFailed: boolean
}> {
  const headers = page.locator('[aria-expanded],.ant-collapse-header')
  const opened: Array<{ index: number; label: string }> = []
  let attempts = 0
  let restoreFailed = false
  let captured: Awaited<ReturnType<typeof captureElements>> | undefined
  try {
    const count = Math.min(await headers.count(), 64)
    for (let index = 0; index < count; index++) {
      if (attempts >= 8 || Date.now() >= deadlineMs || guard.getDialogs().length > dialogsBefore) break
      const header = headers.nth(index)
      if (!await header.isVisible().catch(() => false)) continue
      const label = (await header.getAttribute('aria-label') || await header.textContent() || '').trim().replace(/\s+/g, ' ').slice(0, 128)
      if (!label || isUnsafeActionText(label)) continue
      const safe = await header.evaluate(element => !element.closest(
        'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tree"],aside,header,[class*="sidebar"],[class*="Sidebar"],form',
      )
        && !element.matches('input,button[type="submit"]')
        && element.getAttribute('aria-expanded') !== 'true'
        && (element.classList.contains('ant-collapse-header') || Boolean(element.getAttribute('aria-controls'))))
      if (!safe) continue
      attempts++
      try {
        await header.click({ timeout: Math.max(50, Math.min(1500, deadlineMs - Date.now())) })
        if (guard.getDialogs().length > dialogsBefore) break
        opened.push({ index, label })
      } catch { restoreFailed = true; break }
    }
    captured = await read()
  } finally {
    for (const item of opened.reverse()) {
      const header = headers.nth(item.index)
      try {
        const label = (await header.getAttribute('aria-label') || await header.textContent() || '').trim().replace(/\s+/g, ' ').slice(0, 128)
        if (label !== item.label) { restoreFailed = true; break }
        await header.click({ timeout: 1500 })
      } catch { restoreFailed = true; break }
    }
  }
  return { captured: captured!, restoreFailed }
}

async function capturePage(
  page: Page, input: {
    jobId: string; entryId: string; targetId: string; targetAccountId: string; menuPath: string[]
    maxOptionReads: number; variant?: string; blocked: boolean; dialog: boolean
    arrivalUnverified?: boolean; surfaceUnresolved?: boolean
    allowedSpaHashPrefixes: readonly string[]; ignoreQueryParams: readonly string[]
    arrivalMethod: MapIngestPageSnapshot['arrivalMethod']
    deadlineMs: number
    guard: ExploreGuardController
  },
): Promise<MapIngestPageSnapshot> {
  const url = new URL(page.url())
  const rawPageKey = buildPageKey({ targetId: input.targetId, url: page.url(),
    allowedSpaHashPrefixes: input.allowedSpaHashPrefixes, ignoreQueryParams: input.ignoreQueryParams })
  const pageKey = limitedKey(rawPageKey)
  const viewStateKey = limitedKey(buildViewStateKey({ pageKey, ruleVersion: 1, variantKey: input.variant }))
  const presentationStateKey = limitedKey(buildPresentationStateKey({ viewStateKey, ancestorPath: input.menuPath }))
  const blockedBefore = blockedSurfaceCount(input.guard)
  const dialogsBefore = input.guard.getDialogs().length
  const customOptions = await readCustomOptions(page, input.maxOptionReads, input.deadlineMs,
    input.guard, dialogsBefore)
  const expanded = input.guard.getDialogs().length > dialogsBefore
    ? { captured: await captureElements(page, input.maxOptionReads), restoreFailed: false }
    : await captureExpandablePanels(page, input.deadlineMs, input.guard, dialogsBefore,
      () => captureElements(page, input.maxOptionReads))
  const captured = expanded.captured
  const elements: MapIngestElement[] = captured.items.map(item => {
    const candidates: Array<{ by: 'testId' | 'role' | 'css'; value: string; name?: string }> = []
    if (item.testId) candidates.push({ by: 'testId', value: item.testId })
    candidates.push({ by: 'role', value: item.role, name: item.name })
    if (item.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(item.id))
      candidates.push({ by: 'css', value: '#' + item.id })
    return {
      fingerprint: computeControlFingerprint({ role: item.role, accessibleName: item.name, ancestorPath: item.section ? [item.section] : [] }),
      category: item.category, role: item.role, name: item.name,
      locator: { framePath: [], candidates },
      ...((item.options || customOptions.get(item.name)) ? { options: item.options ?? customOptions.get(item.name) } : {}),
      ...(isUnsafeActionText(item.name) ? { unsafeAction: true } : {}),
    }
  })
  for (const element of elements.slice(0, 100)) {
    if (Date.now() >= input.deadlineMs || !element.locator) break
    let measured = false
    for (const candidate of element.locator.candidates) {
      if (Date.now() >= input.deadlineMs) break
      try {
        const locator = candidate.by === 'testId' ? page.getByTestId(candidate.value)
          : candidate.by === 'role' ? page.getByRole(candidate.value as Parameters<Page['getByRole']>[0],
            candidate.name ? { name: candidate.name, exact: true } : {})
            : candidate.by === 'css' ? page.locator(candidate.value) : null
        if (!locator) continue
        const count = await locator.count()
        measured = true
        if (count !== 1) continue
        element.locator = { ...element.locator,
          candidates: [candidate, ...element.locator.candidates.filter(other => other !== candidate)] }
        element.locatorUnique = true
        break
      } catch { /* 不可解析的候选不升级稳定度。 */ }
    }
    if (measured && element.locatorUnique !== true) element.locatorUnique = false
  }
  return {
    jobId: input.jobId, entryId: input.entryId, targetId: input.targetId, targetAccountId: input.targetAccountId,
    pageKey, viewStateKey, presentationStateKey, arrivalMethod: input.arrivalMethod,
    menuPath: input.menuPath.slice(0, 8), title: captured.title,
    urlPattern: routePattern(url, input.allowedSpaHashPrefixes), elements,
    completeness: input.blocked || input.dialog || input.arrivalUnverified || input.surfaceUnresolved
      || blockedSurfaceCount(input.guard) > blockedBefore
      || input.guard.getDialogs().length > dialogsBefore || expanded.restoreFailed
      || Date.now() >= input.deadlineMs ? 'partial' : 'complete',
    reasons: [...(input.blocked || blockedSurfaceCount(input.guard) > blockedBefore ? ['navigation_blocked' as const] : []),
      ...(input.arrivalUnverified ? ['anchor_unresolved' as const] : []),
      ...(input.surfaceUnresolved ? ['view_unresolved' as const] : []),
      ...(input.dialog || input.guard.getDialogs().length > dialogsBefore ? ['dialog_dismissed' as const] : []),
      ...(expanded.restoreFailed ? ['view_unresolved' as const] : []),
      ...(Date.now() >= input.deadlineMs ? ['page_timeout' as const] : [])],
    observedAt: new Date().toISOString(),
  }
}

async function captureTabViews(input: {
  page: Page
  base: MapIngestPageSnapshot
  guard: ExploreGuardController
  maxViews: number
  maxOptionReads: number
  allowedSpaHashPrefixes: readonly string[]
  ignoreQueryParams: readonly string[]
  pageDeadlineMs: number
  onView: (view: MapIngestPageSnapshot) => Promise<void>
}): Promise<{ restoreFailed: boolean; timedOut: boolean; dialogEncountered: boolean }> {
  const tabs = input.page.locator('[role="tab"],.ant-tabs-tab,.el-tabs__item')
  const items: Array<{ label: string; active: boolean }> = []
  for (let index = 0; index < Math.min(await tabs.count(), 64); index++) {
    if (items.length >= input.maxViews) break
    const tab = tabs.nth(index)
    if (!await tab.isVisible().catch(() => false)) continue
    const inContent = await tab.evaluate(element => !element.closest(
      'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tree"],aside,header,[class*="sidebar"],[class*="Sidebar"],form',
    ))
    if (!inContent) continue
    const label = (await tab.getAttribute('aria-label') || await tab.textContent() || '').trim().replace(/\s+/g, ' ').slice(0, 128)
    if (!label || items.some(item => item.label === label)) continue
    items.push({ label, active: await tab.getAttribute('aria-selected') === 'true' })
  }
  const original = items.find(item => item.active)?.label ?? items[0]?.label
  let restoreFailed = false
  let timedOut = false
  let dialogEncountered = false
  for (const item of items) {
    if (Date.now() >= input.pageDeadlineMs) { timedOut = true; break }
    if (isUnsafeActionText(item.label) || item.label === original) continue
    const tab = input.page.getByRole('tab', { name: item.label, exact: true })
    if (await tab.count() !== 1 || await tab.locator('xpath=ancestor::form').count()) continue
    const blocked = blockedSurfaceCount(input.guard)
    const dialogs = input.guard.getDialogs().length
    try {
      await tab.click({ timeout: 1500 })
      if (input.guard.getDialogs().length > dialogs) { restoreFailed = true; break }
      await input.page.waitForTimeout(100)
      const view = await capturePage(input.page, {
        jobId: input.base.jobId, entryId: input.base.entryId,
        targetId: input.base.targetId, targetAccountId: input.base.targetAccountId,
        menuPath: input.base.menuPath, maxOptionReads: input.maxOptionReads,
        allowedSpaHashPrefixes: input.allowedSpaHashPrefixes,
        ignoreQueryParams: input.ignoreQueryParams,
        arrivalMethod: input.base.arrivalMethod,
        deadlineMs: input.pageDeadlineMs,
        variant: item.label, blocked: blockedSurfaceCount(input.guard) > blocked, dialog: false,
        arrivalUnverified: input.base.reasons.includes('anchor_unresolved'),
        guard: input.guard,
      })
      await input.onView(view)
      if (view.reasons.includes('dialog_dismissed')) { dialogEncountered = true; break }
    } catch { restoreFailed = true }
    if (original) {
      const first = input.page.getByRole('tab', { name: original, exact: true })
      try {
        if (await first.count() === 1) await first.click({ timeout: 1500 })
        else restoreFailed = true
      } catch { restoreFailed = true }
    }
    if (restoreFailed) break
    if (Date.now() >= input.pageDeadlineMs) { timedOut = true; break }
  }
  return { restoreFailed, timedOut, dialogEncountered }
}

function initialNode(entry: MapMenuEntry): MapIngestQueueNode {
  return {
    entryId: entry.entryId, kind: entry.url ? 'explicit_url' : 'reveal',
    label: entry.menuAnchor?.label ?? entry.name, ...(entry.url ? { url: entry.url } : {}),
    depth: 0, menuPath: [entry.menuAnchor?.label ?? entry.name],
  }
}

function attemptedNodeKey(node: Pick<MapIngestQueueNode, 'entryId' | 'url' | 'menuPath'>): string {
  return `${node.entryId}|${node.url ?? node.menuPath.join('>')}`
}

export async function collectMapIngestSlice(input: {
  page: Page
  step: MapIngestStep['input']
  targetId: string
  targetAccountId: string
  accessPolicy: TargetAccessPolicy
  guard: ExploreGuardController
  signal: AbortSignal
  onProgress: (cursor: MapIngestCursor, page?: MapIngestPageSnapshot) => Promise<void>
}): Promise<IngestSliceResult> {
  const { page, step, guard } = input
  const hashPrefixes = step.allowedSpaHashPrefixes ?? ['#/']
  const ignoreQueryParams = step.ignoreQueryParams ?? []
  const started = Date.now()
  const end = started + step.sliceWorkSeconds * 1000
  const cursor: MapIngestCursor = input.step.cursor
    ? structuredClone(input.step.cursor)
    : { entryIndex: 0, queue: [], visitedPageKeys: [], attemptedNodeKeys: [], entryPageCounts: {}, elapsedSeconds: 0, completedEntries: [], processedNodes: 0 }
  cursor.attemptedNodeKeys ??= []
  const carriedSeconds = cursor.elapsedSeconds
  const persist = async (snapshot?: MapIngestPageSnapshot) => {
    cursor.elapsedSeconds = carriedSeconds + Math.ceil((Date.now() - started) / 1000)
    await input.onProgress(cursor, snapshot)
  }
  const nodes: IngestNodeResult[] = []
  const detectedMenus: IngestSliceResult['detectedMenus'] = []
  await page.goto(step.startUrl, { waitUntil: 'domcontentloaded', timeout: step.policy.ingestNavTimeoutSeconds * 1000 })
  let scan = await scanSettledMenu(page, step.entries.map(entry => entry.menuAnchor?.label ?? entry.name),
    step.policy.ingestSettleTimeoutSeconds, input.signal)
  const startMenu = scan
  if (step.scope === 'detect_top_menus') {
    if (!scan.found) nodes.push({ label: '一级菜单', code: 'menu_container_unresolved' })
    for (const candidate of scan.nodes.filter(node => node.ancestors.length === 0).slice(0, 64)) {
      if (isUnsafeActionText(candidate.label)) continue
      detectedMenus.push({ label: candidate.label, ...(candidate.href ? { url: candidate.href } : {}),
        menuAnchor: { label: candidate.label }, hasChildren: candidate.hasChildren })
    }
    cursor.entryIndex = step.entries.length
    await persist()
    return { cursor, nodes, detectedMenus, ...guardSummary(guard) }
  }
  while (cursor.entryIndex < step.entries.length && Date.now() < end && !input.signal.aborted) {
    const entry = step.entries[cursor.entryIndex]!
    const completeEntryIfDrained = () => {
      if (cursor.queue.length) return
      if (!cursor.completedEntries.includes(entry.entryId)) cursor.completedEntries.push(entry.entryId)
      cursor.entryIndex++
    }
    if (!cursor.queue.length && !cursor.completedEntries.includes(entry.entryId)) cursor.queue.push(initialNode(entry))
    const node = cursor.queue.shift()
    if (!node) {
      completeEntryIfDrained()
      await persist()
      continue
    }
    const nodeKey = attemptedNodeKey(node)
    if (cursor.attemptedNodeKeys.includes(nodeKey)) {
      cursor.processedNodes++
      completeEntryIfDrained()
      await persist()
      continue
    }
    cursor.attemptedNodeKeys.push(nodeKey)
    if (node.depth === 0 && (!startMenu.found || (startMenu.heuristic && !node.url))) {
      nodes.push({ label: entry.name, code: 'menu_container_unresolved' })
      if (!node.url) {
        cursor.processedNodes++
        completeEntryIfDrained()
        await persist()
        continue
      }
    } else if (node.depth === 0 && node.url && !await menuItem(page, startMenu,
      entry.menuAnchor?.label ?? entry.name, entry.menuAnchor?.locator, entry.url)) {
      nodes.push({ label: entry.name, code: 'anchor_unresolved' })
    }
    if (node.depth > step.policy.ingestMaxDepth
      || cursor.visitedPageKeys.length >= step.policy.ingestMaxPagesPerJob
      || (cursor.entryPageCounts[entry.entryId] ?? 0) >= step.policy.ingestMaxPagesPerEntry) {
      nodes.push({ label: node.label, code: 'budget_exhausted' })
      cursor.processedNodes++
      completeEntryIfDrained()
      await persist()
      continue
    }
    if (isUnsafeActionText(node.label)) {
      nodes.push({ label: node.label, code: 'unsafe_label' })
      cursor.processedNodes++
      completeEntryIfDrained()
      await persist()
      continue
    }
    const blockedBefore = blockedSurfaceCount(guard)
    const dialogsBefore = guard.getDialogs().length
    let arrivalUnverified = false
    let surfaceUnresolved = false
    try {
      if (node.url) {
        const safe = sanitizeExplorationUrl(node.url, undefined, { allowedSpaHashPrefixes: hashPrefixes })
        if (!safe.ok || !urlAllowedForMenu(node.url, input.accessPolicy, hashPrefixes)) {
          nodes.push({ label: node.label, code: 'out_of_scope' })
          cursor.processedNodes++
          completeEntryIfDrained()
          await persist()
          continue
        }
        await page.goto(node.url, { waitUntil: 'domcontentloaded', timeout: step.policy.ingestNavTimeoutSeconds * 1000 })
        surfaceUnresolved = !await waitForVisibleSurface(page, step.policy.ingestSettleTimeoutSeconds, input.signal)
      } else {
        await page.goto(step.startUrl, { waitUntil: 'domcontentloaded', timeout: step.policy.ingestNavTimeoutSeconds * 1000 })
        scan = await scanSettledMenu(page, [entry.menuAnchor?.label ?? entry.name],
          step.policy.ingestSettleTimeoutSeconds, input.signal)
        if (!scan.found) {
          nodes.push({ label: node.label, code: 'menu_container_unresolved' })
          cursor.processedNodes++
          completeEntryIfDrained()
          await persist()
          continue
        }
        for (const label of node.menuPath.slice(0, -1)) {
          const ancestor = await menuItem(page, scan, label)
          if (ancestor && await ancestor.getAttribute('aria-expanded') === 'false') {
            await ancestor.click({ timeout: 2000 })
            scan = await scanMenu(page, [entry.menuAnchor?.label ?? entry.name], entry.url, hashPrefixes)
          }
        }
        const item = await menuItem(page, scan, node.label,
          node.depth === 0 ? entry.menuAnchor?.locator : undefined)
        if (!item) {
          nodes.push({ label: node.label, code: 'anchor_unresolved' })
          cursor.processedNodes++
          completeEntryIfDrained()
          await persist()
          continue
        }
        const form = await item.locator('xpath=ancestor::form').count()
        const submit = await item.evaluate(element => element.matches('button[type="submit"],input'))
        if (form || submit) {
          nodes.push({ label: node.label, code: 'unsafe_label' })
          cursor.processedNodes++
          completeEntryIfDrained()
          await persist()
          continue
        }
        await item.click({ timeout: 2000 })
        await page.waitForLoadState('domcontentloaded', { timeout: step.policy.ingestSettleTimeoutSeconds * 1000 }).catch(() => {})
      }
      if (guard.getDialogs().length > dialogsBefore) {
        nodes.push({ label: node.label, code: 'dialog_dismissed' })
        cursor.processedNodes++
        completeEntryIfDrained()
        await persist()
        continue
      }
      if (!urlAllowedForMenu(page.url(), input.accessPolicy, hashPrefixes)) {
        await page.goBack({ timeout: step.policy.ingestNavTimeoutSeconds * 1000 }).catch(() => {})
        nodes.push({ label: node.label, code: 'out_of_scope' })
        cursor.processedNodes++
        completeEntryIfDrained()
        await persist()
        continue
      }
      if (node.depth === 0 && node.url && startMenu.found
        && !await waitForEntryArrival(page, entry, step.policy.ingestSettleTimeoutSeconds, input.signal)) {
        if (!withinEntryRoute(page.url(), node.url, hashPrefixes)) {
          nodes.push({ label: node.label, code: 'navigation_blocked' })
          cursor.processedNodes++
          completeEntryIfDrained()
          await persist()
          continue
        }
        arrivalUnverified = true
        if (!nodes.some(result => result.label === node.label && result.code === 'anchor_unresolved'))
          nodes.push({ label: node.label, code: 'anchor_unresolved' })
      }
      const revealedOnly = node.kind === 'reveal' && page.url() === step.startUrl
      const pageKey = limitedKey(buildPageKey({ targetId: input.targetId, url: page.url(),
        allowedSpaHashPrefixes: hashPrefixes, ignoreQueryParams }))
      let snapshot: MapIngestPageSnapshot | undefined
      if (!revealedOnly && !cursor.visitedPageKeys.includes(pageKey)) {
        const pageStarted = Date.now()
        snapshot = await capturePage(page, {
          jobId: step.jobId, entryId: entry.entryId, targetId: input.targetId,
          targetAccountId: input.targetAccountId, menuPath: node.menuPath,
          maxOptionReads: step.policy.ingestMaxOptionReadsPerPage,
          allowedSpaHashPrefixes: hashPrefixes,
          ignoreQueryParams,
          deadlineMs: pageStarted + step.policy.ingestPageBudgetSeconds * 1000,
          arrivalMethod: node.kind === 'opaque_navigation' ? 'opaque_click'
            : node.kind === 'reveal' ? 'reveal' : 'goto',
          blocked: blockedSurfaceCount(guard) > blockedBefore, arrivalUnverified, surfaceUnresolved,
          dialog: false, guard,
        })
        const viewResult = snapshot.reasons.includes('dialog_dismissed')
          ? { restoreFailed: false, timedOut: false, dialogEncountered: true }
          : await captureTabViews({
          page, base: snapshot, guard,
          maxViews: step.policy.ingestMaxViewsPerPage,
          maxOptionReads: step.policy.ingestMaxOptionReadsPerPage,
          allowedSpaHashPrefixes: hashPrefixes,
          ignoreQueryParams,
          pageDeadlineMs: pageStarted + step.policy.ingestPageBudgetSeconds * 1000,
          onView: view => persist(view),
          })
        const pageTimedOut = viewResult.timedOut || Date.now() - pageStarted > step.policy.ingestPageBudgetSeconds * 1000
        const dialogDuringPage = guard.getDialogs().length > dialogsBefore || viewResult.dialogEncountered
        if (pageTimedOut || viewResult.restoreFailed || dialogDuringPage) {
          snapshot.completeness = 'partial'
          snapshot.reasons = [...new Set([...snapshot.reasons,
            ...(pageTimedOut ? ['page_timeout' as const] : []),
            ...(viewResult.restoreFailed ? ['view_unresolved' as const] : []),
            ...(dialogDuringPage ? ['dialog_dismissed' as const] : [])])].slice(0, 16)
          if (pageTimedOut || viewResult.restoreFailed)
            nodes.push({ label: node.label, code: pageTimedOut ? 'page_timeout' : 'view_unresolved', pageKey })
        }
        if (dialogDuringPage)
          nodes.push({ label: node.label, code: 'dialog_dismissed', pageKey })
        cursor.visitedPageKeys.push(pageKey)
        cursor.entryPageCounts[entry.entryId] = (cursor.entryPageCounts[entry.entryId] ?? 0) + 1
        nodes.push({ label: node.label, code: 'collected', pageKey })
      }
      if (revealedOnly) nodes.push({ label: node.label, code: 'collected' })
      scan = await scanMenu(page, [entry.menuAnchor?.label ?? entry.name], entry.url, hashPrefixes)
      const heuristicStable = !startMenu.heuristic || Boolean((node.url || node.depth > 0) && scan.heuristic
        && scan.fingerprint === startMenu.fingerprint)
      const anchored = heuristicStable && Boolean(await menuItem(page, scan,
        entry.menuAnchor?.label ?? entry.name, entry.menuAnchor?.locator, entry.url))
      if (scan.heuristic && !heuristicStable)
        nodes.push({ label: node.label, code: 'menu_container_unresolved', pageKey })
      if (scan.found && anchored && !arrivalUnverified && node.depth < step.policy.ingestMaxDepth) {
        const known = new Set(cursor.queue.map(queued => queued.url ?? queued.menuPath.join('>')))
        for (const candidate of scan.nodes) {
          if (!belongsToMenuSubtree(candidate, entry, hashPrefixes) || isUnsafeActionText(candidate.label)) continue
          if (candidate.href && entry.url && candidate.href === entry.url) continue
          if (step.entries.slice(0, cursor.entryIndex).some(prior => belongsToMenuSubtree(candidate, prior, hashPrefixes))) continue
          const safe = candidate.href ? sanitizeExplorationUrl(candidate.href, undefined,
            { allowedSpaHashPrefixes: hashPrefixes }) : null
          if (candidate.href && (!safe?.ok || !urlAllowedForMenu(candidate.href, input.accessPolicy, hashPrefixes))) continue
          const menuPath = [...candidate.ancestors, candidate.label].slice(0, 8)
          const depth = Math.max(1, menuPath.length - 1)
          const key = candidate.href ?? menuPath.join('>')
          if (known.has(key) || cursor.attemptedNodeKeys.includes(attemptedNodeKey({ entryId: entry.entryId,
            url: candidate.href, menuPath }))
            || (candidate.href && cursor.visitedPageKeys.includes(limitedKey(buildPageKey({
              targetId: input.targetId, url: candidate.href, allowedSpaHashPrefixes: hashPrefixes, ignoreQueryParams,
            }))))) continue
          if (cursor.queue.length >= 500) break
          cursor.queue.push({ entryId: entry.entryId, kind: candidate.href ? 'explicit_url' : candidate.hasChildren ? 'reveal' : 'opaque_navigation',
            label: candidate.label, ...(candidate.href ? { url: candidate.href } : {}), depth, menuPath })
          known.add(key)
        }
      }
      cursor.processedNodes++
      completeEntryIfDrained()
      await persist(snapshot)
    } catch {
      nodes.push({ label: node.label, code: 'navigation_blocked' })
      cursor.processedNodes++
      completeEntryIfDrained()
      await persist()
    }
  }
  cursor.elapsedSeconds = carriedSeconds + Math.ceil((Date.now() - started) / 1000)
  await persist()
  return { cursor, nodes, detectedMenus, ...guardSummary(guard) }
}
