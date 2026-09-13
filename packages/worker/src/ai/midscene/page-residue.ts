import type { Page } from 'playwright'

export type PageResidue = {
  popupListeners: number
  loadListeners: number
  midsceneInterceptor: boolean
}

export async function snapshotResidue(page: Page): Promise<PageResidue> {
  return {
    popupListeners: page.listenerCount('popup'),
    loadListeners: page.listenerCount('load'),
    midsceneInterceptor: await page
      .evaluate(() => Boolean((window as { __MIDSCENE_NEW_TAB_INTERCEPTOR_INITIALIZED__?: boolean }).__MIDSCENE_NEW_TAB_INTERCEPTOR_INITIALIZED__))
      .catch(() => false),
  }
}

export function unregisteredResidue(before: PageResidue, after: PageResidue): string[] {
  const hits: string[] = []
  if (after.popupListeners > before.popupListeners) hits.push('popup')
  if (after.loadListeners > before.loadListeners) hits.push('load')
  if (after.midsceneInterceptor && !before.midsceneInterceptor) hits.push('tab-interceptor')
  return hits
}

export async function readLabEvents(page: Page): Promise<Array<{ type: string; id?: string }>> {
  return page.evaluate(() => {
    const events = (window as { __labEvents?: Array<{ type: string; id?: string }> }).__labEvents
    return Array.isArray(events) ? events : []
  })
}
