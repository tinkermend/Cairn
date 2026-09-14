import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import type { PageRef } from '@cairn/shared'

export type ManagedPageKind = 'base' | 'run' | 'popup'

export type ManagedPageEntry = {
  pageId: string
  documentEpoch: number
  page: Page
  runId: string
  kind: ManagedPageKind
}

export function createManagedPage(input: {
  page: Page
  runId: string
  kind: ManagedPageKind
}): ManagedPageEntry {
  const entry: ManagedPageEntry = {
    pageId: randomUUID(),
    documentEpoch: 0,
    page: input.page,
    runId: input.runId,
    kind: input.kind,
  }
  if (typeof input.page.on === 'function') {
    input.page.on('framenavigated', (frame) => {
      if (typeof input.page.mainFrame === 'function' && frame === input.page.mainFrame()) {
        entry.documentEpoch += 1
      }
    })
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

export function originAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  try {
    const parsed = new URL(url)
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      allowedOrigins.includes(parsed.origin)
    )
  } catch {
    return false
  }
}

export function pickPopupHandoff(
  candidates: Array<{ page: Page; url: string }>,
  allowedOrigins: readonly string[],
):
  | { ok: true; page: Page }
  | { ok: false; code: 'PAGE_HANDOFF_NO_POPUP' | 'PAGE_HANDOFF_AMBIGUOUS' | 'PAGE_HANDOFF_OUT_OF_SCOPE' | 'PAGE_HANDOFF_CLOSED' } {
  const open = candidates.filter((item) => !item.page.isClosed())
  if (open.length === 0) return { ok: false, code: 'PAGE_HANDOFF_NO_POPUP' }
  const inScope = open.filter((item) => originAllowed(item.url, allowedOrigins))
  if (inScope.length === 0) return { ok: false, code: 'PAGE_HANDOFF_OUT_OF_SCOPE' }
  if (inScope.length > 1) return { ok: false, code: 'PAGE_HANDOFF_AMBIGUOUS' }
  const chosen = inScope[0]!
  if (chosen.page.isClosed()) return { ok: false, code: 'PAGE_HANDOFF_CLOSED' }
  return { ok: true, page: chosen.page }
}
