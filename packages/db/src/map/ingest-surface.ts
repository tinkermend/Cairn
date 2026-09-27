import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import {
  mapIngestSurfaceQuerySchema,
  mapIngestSurfaceResponseSchema,
  type MapIngestSurfaceQuery,
  type MapIngestSurfaceResponse,
  type MapIngestSummary,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { requireLiveTarget } from './view.js'

type PageRow = typeof import('../schema/map-jobs.js').mapIngestPages.$inferSelect
type JobRow = typeof import('../schema/map-jobs.js').mapJobs.$inferSelect
type SurfacePage = MapIngestSurfaceResponse['pages'][number]

export function composeCurrentIngestRows(base: PageRow[], overlays: PageRow[][]): PageRow[] {
  const views = new Map<string, PageRow>()
  for (const row of base) views.set(row.viewStateKey, row)
  for (const batch of overlays) for (const row of batch) views.set(row.viewStateKey, row)
  return [...views.values()]
}

/** Select one account before composing full and partial jobs, so every consumer sees the same coverage. */
export async function loadIngestSurfaceState(db: Db, targetId: string, targetAccountId?: string): Promise<{
  latest: JobRow | undefined
  base: PageRow[]
  previousFull: PageRow[]
  overlays: PageRow[][]
  authorizedEntryIds: Set<string>
  truncatedJobs: boolean
}> {
  const { mapJobs, mapIngestPages } = schemaFor(db)
  const latestWhere = and(eq(mapJobs.targetId, targetId), eq(mapJobs.jobKind, 'map_ingest'),
    eq(mapJobs.jobStatus, 'completed'), ne(mapJobs.scope, 'detect_top_menus'),
    ...(targetAccountId ? [eq(mapJobs.targetAccountId, targetAccountId)] : []))
  const [latest] = await db.select().from(mapJobs).where(latestWhere).orderBy(desc(mapJobs.createdAt)).limit(1)
  if (!latest) return { latest, base: [], previousFull: [], overlays: [],
    authorizedEntryIds: new Set(), truncatedJobs: false }
  const jobs = await db.select().from(mapJobs)
    .where(and(eq(mapJobs.targetId, targetId), eq(mapJobs.targetAccountId, latest.targetAccountId),
      eq(mapJobs.jobKind, 'map_ingest'), eq(mapJobs.jobStatus, 'completed'), ne(mapJobs.scope, 'detect_top_menus')))
    .orderBy(desc(mapJobs.createdAt)).limit(100)
  const baseIndex = jobs.findIndex(job => job.scope === 'full' && job.ingestSummary?.outcome === 'complete')
  const baseJob = baseIndex >= 0 ? jobs[baseIndex]! : undefined
  const previousJob = baseIndex >= 0
    ? jobs.slice(baseIndex + 1).find(job => job.scope === 'full' && job.ingestSummary?.outcome === 'complete') : undefined
  const overlayJobs = baseIndex >= 0 ? jobs.slice(0, baseIndex).reverse() : [...jobs].reverse()
  const relevantIds = [...new Set([baseJob?.id, previousJob?.id, ...overlayJobs.map(job => job.id)]
    .filter((id): id is string => Boolean(id)))]
  const rows = relevantIds.length
    ? await db.select().from(mapIngestPages).where(inArray(mapIngestPages.jobId, relevantIds)) : []
  const byJob = new Map<string, PageRow[]>()
  for (const row of rows) {
    const list = byJob.get(row.jobId) ?? []
    list.push(row)
    byJob.set(row.jobId, list)
  }
  return {
    latest,
    base: baseJob ? byJob.get(baseJob.id) ?? [] : [],
    previousFull: previousJob ? byJob.get(previousJob.id) ?? [] : [],
    overlays: overlayJobs.map(job => byJob.get(job.id) ?? []),
    authorizedEntryIds: new Set(baseJob?.frozenEntriesJson.map(entry => entry.entryId) ?? []),
    truncatedJobs: jobs.length === 100,
  }
}

/** Full runs may retire absent views. Partial and entry runs only overlay what they observed. */
export function buildIngestSurfacePages(input: {
  base: PageRow[]
  previousFull: PageRow[]
  overlays: PageRow[][]
  authorizedEntryIds: Set<string>
  latestChanges: MapIngestSummary['changes']
}): SurfacePage[] {
  const previous = new Map(input.previousFull.map(row => [row.viewStateKey, row]))
  const views = new Map<string, { row: PageRow; lifecycle: 'observed' | 'stale'; staleElements: number }>()
  for (const row of input.base) {
    const before = previous.get(row.viewStateKey)
    const currentFingerprints = new Set(row.elementsJson.map(element => element.fingerprint))
    const staleElements = before?.elementsJson.filter(element => !currentFingerprints.has(element.fingerprint)).length ?? 0
    views.set(row.viewStateKey, { row, lifecycle: 'observed', staleElements })
  }
  for (const row of input.previousFull) {
    if (views.has(row.viewStateKey) || !input.authorizedEntryIds.has(row.entryId)) continue
    views.set(row.viewStateKey, { row, lifecycle: 'stale', staleElements: row.elementsJson.length })
  }
  for (const batch of input.overlays) {
    for (const row of batch) views.set(row.viewStateKey, { row, lifecycle: 'observed', staleElements: 0 })
  }

  const byPage = new Map<string, Array<typeof views extends Map<string, infer V> ? V : never>>()
  for (const value of views.values()) {
    const list = byPage.get(value.row.pageKey) ?? []
    list.push(value)
    byPage.set(value.row.pageKey, list)
  }
  return [...byPage].map(([pageKey, states]): SurfacePage => {
    const newest = [...states].sort((a, b) => b.row.observedAt.getTime() - a.row.observedAt.getTime())[0]!
    const observed = states.filter(state => state.lifecycle === 'observed')
    const visible = observed.length ? observed : states
    const unique = new Set<string>()
    const categories: SurfacePage['categories'] = {
      navigation: 0, input: 0, action_button: 0, table_column: 0, display: 0,
    }
    for (const state of visible) for (const element of state.row.elementsJson) {
      const key = element.category + ':' + element.fingerprint
      if (unique.has(key)) continue
      unique.add(key)
      categories[element.category]++
    }
    return {
      entryId: newest.row.entryId, pageKey, title: newest.row.title,
      urlPattern: newest.row.urlPattern, menuPath: newest.row.menuPathJson,
      observedAt: newest.row.observedAt.toISOString(),
      elementCount: unique.size, viewCount: states.length,
      categories,
      completeness: observed.some(state => state.row.completeness === 'partial') ? 'partial' : 'complete',
      lifecycle: observed.length ? 'observed' : 'stale',
      staleElements: states.reduce((count, state) => count + state.staleElements, 0),
      changeKinds: [...new Set(input.latestChanges.filter(change => change.pageKey === pageKey)
        .map(change => change.kind))].slice(0, 8),
    }
  }).sort((a, b) => a.entryId.localeCompare(b.entryId)
    || a.menuPath.join('/').localeCompare(b.menuPath.join('/')) || a.title.localeCompare(b.title))
}

export async function getMapIngestSurface(
  db: Db, targetId: string, query: MapIngestSurfaceQuery = {},
): Promise<MapIngestSurfaceResponse> {
  await requireLiveTarget(db, targetId)
  const parsed = mapIngestSurfaceQuerySchema.parse(query)
  const state = await loadIngestSurfaceState(db, targetId, parsed.targetAccountId)
  const { latest } = state
  if (!latest) return mapIngestSurfaceResponseSchema.parse({
    targetId, targetAccountId: parsed.targetAccountId ?? null, sourceJobId: null, truncated: false, pages: [],
  })
  const pages = buildIngestSurfacePages({
    base: state.base,
    previousFull: state.previousFull,
    overlays: state.overlays,
    authorizedEntryIds: state.authorizedEntryIds,
    latestChanges: latest.ingestSummary?.changes ?? [],
  })
  return mapIngestSurfaceResponseSchema.parse({
    targetId, targetAccountId: latest.targetAccountId, sourceJobId: latest.id,
    truncated: state.truncatedJobs || pages.length > 1000, pages: pages.slice(0, 1000),
  })
}
