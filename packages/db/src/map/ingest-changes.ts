import { canonicalJson, type MapIngestPageSnapshot, type MapIngestSummary } from '@cairn/shared'

type PageView = Pick<MapIngestPageSnapshot, 'pageKey' | 'viewStateKey' | 'elements'>
type Change = MapIngestSummary['changes'][number]

export function diffMapIngestPages(
  previous: readonly PageView[],
  current: readonly PageView[],
  allowRemovals: boolean,
  limit = 2000,
): { changes: Change[]; truncated: boolean } {
  const changes: Change[] = []
  let truncated = false
  const add = (change: Change) => {
    if (changes.length < limit) changes.push(change)
    else truncated = true
  }
  const beforePages = new Set(previous.map(page => page.pageKey))
  const nowPages = new Set(current.map(page => page.pageKey))
  for (const key of nowPages) if (!beforePages.has(key)) add({ kind: 'page_added', pageKey: key })
  if (allowRemovals) for (const key of beforePages) if (!nowPages.has(key)) add({ kind: 'page_removed', pageKey: key })

  const beforeViews = new Map(previous.map(view => [view.viewStateKey, view]))
  const nowViews = new Map(current.map(view => [view.viewStateKey, view]))
  for (const [key, view] of nowViews) {
    const before = beforeViews.get(key)
    if (!before) {
      if (beforePages.has(view.pageKey)) add({ kind: 'view_added', pageKey: view.pageKey })
      continue
    }
    const oldElements = new Map(before.elements.map(element => [element.fingerprint, element]))
    const newElements = new Map(view.elements.map(element => [element.fingerprint, element]))
    for (const [fingerprint, element] of newElements) {
      const old = oldElements.get(fingerprint)
      if (!old) {
        add({ kind: 'element_added', pageKey: view.pageKey, name: element.name })
        continue
      }
      if (canonicalJson(old.locator ?? null) !== canonicalJson(element.locator ?? null))
        add({ kind: 'locator_changed', pageKey: view.pageKey, name: element.name })
      if (canonicalJson([...(old.options ?? [])].sort()) !== canonicalJson([...(element.options ?? [])].sort()))
        add({ kind: 'options_changed', pageKey: view.pageKey, name: element.name })
    }
    if (allowRemovals) for (const [fingerprint, element] of oldElements)
      if (!newElements.has(fingerprint)) add({ kind: 'element_removed', pageKey: view.pageKey, name: element.name })
  }
  if (allowRemovals) for (const [key, view] of beforeViews)
    if (!nowViews.has(key) && nowPages.has(view.pageKey)) add({ kind: 'view_removed', pageKey: view.pageKey })
  return { changes, truncated }
}
