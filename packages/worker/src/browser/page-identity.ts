import { randomUUID } from 'node:crypto'
import type { Frame, Page, Request } from 'playwright'
import { urlAllowedByCompiledScope, type CompiledAccessScope, type PageRef } from '@cairn/shared'

export type ManagedPageKind = 'base' | 'run' | 'popup'

export type ManagedPageEntry = {
  pageId: string
  documentEpoch: number
  page: Page
  runId: string
  kind: ManagedPageKind
  lastNavigationMethod?: string
  retarget?: Promise<void>
  dispose?: () => void
}

export function createManagedPage(input: {
  page: Page
  runId: string
  kind: ManagedPageKind
  lastNavigationMethod?: string
  dispose?: () => void
}): ManagedPageEntry {
  const entry: ManagedPageEntry = {
    pageId: randomUUID(),
    documentEpoch: 0,
    page: input.page,
    runId: input.runId,
    kind: input.kind,
  }
  if (typeof input.page.on === 'function') {
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === input.page.mainFrame()) {
        let source: Request | null = request
        let method = 'GET'
        while (source) { if (source.method() !== 'GET') method = source.method(); source = source.redirectedFrom() }
        entry.lastNavigationMethod = method
      }
    }
    const onNavigation = (frame: Frame) => {
      if (typeof input.page.mainFrame === 'function' && frame === input.page.mainFrame()) entry.documentEpoch += 1
    }
    input.page.on('request', onRequest)
    input.page.on('framenavigated', onNavigation)
    entry.dispose = () => { input.page.off?.('request', onRequest); input.page.off?.('framenavigated', onNavigation) }

  }
  return entry
}

export function pageRefFor(
  sessionId: string,
  sessionGeneration: number,
  entry: ManagedPageEntry,
): PageRef {
  return {
    sessionId,
    sessionGeneration,
    pageId: entry.pageId,
    documentEpoch: entry.documentEpoch,
  }
}

export function originAllowed(
  url: string,
  allowedOrigins: readonly string[],
  scope?: CompiledAccessScope,
): boolean {
  try {
    const parsed = new URL(url)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !allowedOrigins.includes(parsed.origin)
    ) {
      return false
    }
    return scope ? urlAllowedByCompiledScope(url, scope) : true
  } catch {
    return false
  }
}

export function pickPopupHandoff(
  candidates: Array<{ page: Page; url: string }>,
  allowedOrigins: readonly string[],
  scope?: CompiledAccessScope,
):
  | { ok: true; page: Page }
  | { ok: false; code: 'PAGE_HANDOFF_NO_POPUP' | 'PAGE_HANDOFF_AMBIGUOUS' | 'PAGE_HANDOFF_OUT_OF_SCOPE' | 'PAGE_HANDOFF_CLOSED' } {
  const open = candidates.filter((item) => !item.page.isClosed())
  if (open.length === 0) return { ok: false, code: 'PAGE_HANDOFF_NO_POPUP' }
  const inScope = open.filter((item) => originAllowed(item.url, allowedOrigins, scope))
  if (inScope.length === 0) return { ok: false, code: 'PAGE_HANDOFF_OUT_OF_SCOPE' }
  if (inScope.length > 1) return { ok: false, code: 'PAGE_HANDOFF_AMBIGUOUS' }
  const chosen = inScope[0]!
  if (chosen.page.isClosed()) return { ok: false, code: 'PAGE_HANDOFF_CLOSED' }
  return { ok: true, page: chosen.page }
}
