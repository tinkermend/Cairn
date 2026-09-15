import type { Page } from 'playwright'

export type PageResidue = {
  popupListeners: number
  loadListeners: number
  midsceneInterceptor: boolean
  elementInspector: boolean
  selectRenderingStyle: boolean
}

async function pageFlag(page: Page, expression: string): Promise<boolean> {
  return page
    .evaluate(expression)
    .then((value) => value === true)
    .catch(() => false)
}

export async function snapshotResidue(page: Page): Promise<PageResidue> {
  const emitter = page as Page & { listenerCount?: (event: string) => number }
  return {
    popupListeners: emitter.listenerCount?.('popup') ?? 0,
    loadListeners: emitter.listenerCount?.('load') ?? 0,
    midsceneInterceptor: await pageFlag(page, 'Boolean(globalThis.__MIDSCENE_NEW_TAB_INTERCEPTOR_INITIALIZED__)'),
    elementInspector: await pageFlag(page, 'Boolean(globalThis.midscene_element_inspector)'),
    selectRenderingStyle: await pageFlag(
      page,
      "Boolean(document.getElementById('midscene-force-select-rendering'))",
    ),
  }
}

export function unregisteredResidue(before: PageResidue, after: PageResidue): string[] {
  const hits: string[] = []
  if (after.popupListeners > before.popupListeners) hits.push('popup')
  if (after.loadListeners > before.loadListeners) hits.push('load')
  if (after.midsceneInterceptor && !before.midsceneInterceptor) hits.push('tab-interceptor')
  if (after.elementInspector && !before.elementInspector) hits.push('element-inspector')
  if (after.selectRenderingStyle && !before.selectRenderingStyle) hits.push('select-rendering-style')
  return hits
}

export async function readLabEvents(page: Page): Promise<Array<{ type: string; id?: string }>> {
  return page.evaluate(() => {
    const events = (globalThis as { __labEvents?: Array<{ type: string; id?: string }> }).__labEvents
    return Array.isArray(events) ? events : []
  })
}
