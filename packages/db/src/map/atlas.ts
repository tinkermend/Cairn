import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  mapAtlasPagesResponseSchema,
  sanitizeRouteTemplate,
  type MapAtlasPagesQuery,
  type MapAtlasPagesResponse,
  type MapPageKind,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { mapRevisionConflict } from './errors.js'
import { businessRouteSql } from './query-read.js'
import { requireLiveTarget, resolveMapView, viewMeta } from './view.js'

export async function listMapAtlasPages(
  db: Db,
  targetId: string,
  query: MapAtlasPagesQuery,
): Promise<MapAtlasPagesResponse> {
  await requireLiveTarget(db, targetId)
  const view = await resolveMapView(db, targetId, {})
  const meta = await viewMeta(db, view)

  const currentProjectionRevision = meta.viewRef.kind === 'projection' ? meta.viewRef.revision : undefined
  if (
    query.expectedProjectionRevision !== undefined &&
    currentProjectionRevision !== undefined &&
    currentProjectionRevision !== query.expectedProjectionRevision
  ) {
    mapRevisionConflict('地图投影修订已变更')
  }
  if (
    query.expectedGovernanceRevision !== undefined &&
    meta.governanceRevision !== query.expectedGovernanceRevision
  ) {
    mapRevisionConflict('地图治理修订已变更')
  }

  if (view.kind === 'projection' && view.status === 'missing') {
    return mapAtlasPagesResponseSchema.parse({
      view: meta,
      presentationRevision: 0,
      totalObservedPages: 0,
      matchedIslands: 0,
      items: [],
      nextCursor: undefined,
    })
  }

  type AggregatedRow = {
    pageId: string | null
    pageKind: string | null
    routeTemplate: string | null
    uniqueObjectCount: number
    uniqueNeedsAttentionCount: number
    lastVerifiedAt: Date | string | null
  }

  let rawRows: AggregatedRow[] = []

  if (view.kind === 'release') {
    const { mapReleaseItems: items, mapPages: pages } = schemaFor(db)
    rawRows = (await db
      .select({
        pageId: items.pageId,
        pageKind: pages.kind,
        routeTemplate: pages.routeTemplate,
        uniqueObjectCount: sql<number>`count(distinct ${items.objectId})`.as('unique_object_count'),
        uniqueNeedsAttentionCount: sql<number>`count(distinct case when ${items.lifecycle} = 'DEGRADED' or ${items.lifecycle} = 'RETIRED' or ${items.executable} = 0 then ${items.objectId} end)`.as(
          'unique_needs_attention_count',
        ),
        lastVerifiedAt: sql<Date | string | null>`null`.as('last_verified_at'),
      })
      .from(items)
      .innerJoin(pages, eq(pages.id, items.pageId))
      .where(and(eq(items.releaseId, view.releaseId!), isNotNull(items.pageId), businessRouteSql(pages.routeTemplate)))
      .groupBy(items.pageId, pages.kind, pages.routeTemplate)) as AggregatedRow[]
  } else {
    const { mapProjectionAssets: assets, mapPages: pages } = schemaFor(db)
    rawRows = (await db
      .select({
        pageId: assets.pageId,
        pageKind: pages.kind,
        routeTemplate: pages.routeTemplate,
        uniqueObjectCount: sql<number>`count(distinct ${assets.objectId})`.as('unique_object_count'),
        uniqueNeedsAttentionCount: sql<number>`count(distinct case when ${assets.lifecycle} = 'DEGRADED' or ${assets.lifecycle} = 'RETIRED' or ${assets.executable} = 0 then ${assets.objectId} end)`.as(
          'unique_needs_attention_count',
        ),
        lastVerifiedAt: sql<Date | string | null>`max(${assets.lastVerifiedAt})`.as('last_verified_at'),
      })
      .from(assets)
      .innerJoin(pages, eq(pages.id, assets.pageId))
      .where(and(eq(assets.projectionId, view.projectionId!), isNotNull(assets.pageId), businessRouteSql(pages.routeTemplate)))
      .groupBy(assets.pageId, pages.kind, pages.routeTemplate)) as AggregatedRow[]
  }

  const allItems = rawRows
    .filter((row): row is AggregatedRow & { pageId: string } => Boolean(row.pageId))
    .map((row) => {
      const routeSummary = sanitizeRouteTemplate(row.routeTemplate)
      let displayName: string
      let nameSource: 'presentation' | 'sanitized_route' | 'fallback_id'

      if (routeSummary && routeSummary !== '/') {
        displayName = routeSummary
        nameSource = 'sanitized_route'
      } else if (routeSummary === '/') {
        displayName = '主站首页 (Root)'
        nameSource = 'sanitized_route'
      } else {
        displayName = `未命名海岛 (${row.pageId.slice(0, 8)})`
        nameSource = 'fallback_id'
      }

      const lastVerifiedAt =
        row.lastVerifiedAt instanceof Date
          ? row.lastVerifiedAt.toISOString()
          : row.lastVerifiedAt ?? undefined

      const pageKind: MapPageKind =
        row.pageKind === 'frame_primary' || row.pageKind === 'composite' ? row.pageKind : 'top'

      return {
        pageId: row.pageId,
        pageKind,
        routeSummary,
        displayName,
        nameSource,
        uniqueObjectCount: Number(row.uniqueObjectCount || 0),
        uniqueNeedsAttentionCount: Number(row.uniqueNeedsAttentionCount || 0),
        lastVerifiedAt,
      }
    })

  const totalObservedPages = allItems.length

  const searchKeyword = query.search?.trim().toLowerCase()
  const filtered = searchKeyword
    ? allItems.filter(
        (item) =>
          item.displayName.toLowerCase().includes(searchKeyword) ||
          item.routeSummary.toLowerCase().includes(searchKeyword) ||
          item.pageId.toLowerCase().includes(searchKeyword),
      )
    : allItems

  // Deterministic sorting: most assets first, stable tie-break on pageId
  filtered.sort((a, b) => {
    if (b.uniqueObjectCount !== a.uniqueObjectCount) {
      return b.uniqueObjectCount - a.uniqueObjectCount
    }
    return a.pageId.localeCompare(b.pageId)
  })

  const matchedIslands = filtered.length

  let offset = 0
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { offset?: number }
      if (typeof parsed?.offset === 'number' && parsed.offset >= 0) {
        offset = parsed.offset
      }
    } catch {
      offset = 0
    }
  }

  const limit = query.limit ?? 16
  const pagedItems = filtered.slice(offset, offset + limit)
  const nextCursor =
    offset + limit < filtered.length
      ? Buffer.from(JSON.stringify({ offset: offset + limit }), 'utf8').toString('base64url')
      : undefined

  return mapAtlasPagesResponseSchema.parse({
    view: meta,
    presentationRevision: 0,
    totalObservedPages,
    matchedIslands,
    items: pagedItems,
    nextCursor,
  })
}
