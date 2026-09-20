import { and, asc, eq, gt, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import {
  deriveMapEvidenceAvailability,
  isNoiseMapRoute,
  mapAssetRefSchema,
  mapConditionSnapshotSchema,
  mapDescriptorFeaturesSchema,
  mapDimensionStatSchema,
  MAP_QUERY_PAGE_CANDIDATE_MAX,
  type MapConditionSnapshot,
  type MapConditionTri,
  type MapDescriptorFeatures,
  type MapDimensionStat,
  type MapLifecycle,
  type MapListQuery,
  type MapOverlayLifecycle,
  type MapQueryClues,
  type MapQueryRequest,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { driverOf, schemaFor } from '../native.js'
import {
  assetKey,
  assetRef,
  loadOverlays,
  resolveAssetOverlay,
  type ResolvedMapView,
} from './view.js'

export const DEFAULT_UNKNOWN_FIELDS = [
  'permissionProfile',
  'workspace',
  'locale',
  'viewport',
  'featureVersion',
] as const

export type MapConditionEvaluator = (
  required: MapConditionSnapshot,
  observed: MapConditionSnapshot,
) => MapConditionTri

export type HydratedViewAsset = {
  assetRefKey: string
  assetRef: ReturnType<typeof assetRef>
  pageId?: string
  objectId?: string
  implementationKey?: string
  descriptorVersion?: number
  lifecycle: MapLifecycle
  overlayLifecycle?: MapOverlayLifecycle
  importance: number
  executable: boolean
  rejectReasons: string[]
  dimensions: MapDimensionStat[]
  lastVerifiedAt?: string
  sampleCount: number
  changeCount: number
  condition?: MapConditionSnapshot
  features?: MapDescriptorFeatures
  routeTemplate?: string
  evidenceAvailability: 'available' | 'partial' | 'unavailable'
  unknownFields: string[]
  name?: string
}

type AssetRefFilter = NonNullable<MapQueryRequest['assetRef']>

type ReadQuery = {
  objectId?: string
  afterKey?: string
  limit?: number
  search?: string
  changeOnly?: boolean
  group?: 'objects' | 'pages'
  assetRef?: AssetRefFilter
  routeTemplate?: string
  clues?: Pick<MapQueryClues, 'region' | 'role' | 'name'>
  countOnly?: boolean
}

type JoinRow = {
  assetRefKey: string
  pageId: string | null
  objectId: string | null
  implementationKey: string | null
  descriptorVersion: number | null
  lifecycle: MapLifecycle
  importance: number
  executable: number
  rejectReasons: string[]
  dimensions: unknown
  lastVerifiedAt: Date | string | null
  sampleCount: number
  changeCount: number
  routeTemplate: string | null
  features: unknown
  conditionSnapshot: unknown
}

function asNumber(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function jsonText(db: Db, column: SQLWrapper, path: string): SQL {
  const jsonPath = `$.${path}`
  if (driverOf(db) === 'mysql') return sql`json_unquote(json_extract(${column}, ${jsonPath}))`
  if (driverOf(db) === 'sqlite') return sql`json_extract(${column}, ${jsonPath})`
  return sql`${column}->>${path}`
}

function unknownFieldsLength(db: Db, column: SQLWrapper): SQL {
  if (driverOf(db) === 'mysql') return sql`coalesce(json_length(json_extract(${column}, '$.unknownFields')), 0)`
  if (driverOf(db) === 'sqlite') return sql`coalesce(json_array_length(${column}, '$.unknownFields'), 0)`
  return sql`coalesce(jsonb_array_length(${column}->'unknownFields'), 0)`
}

function idText(db: Db, column: SQLWrapper): SQL {
  return driverOf(db) === 'mysql' ? sql`cast(${column} as char(36))` : sql`cast(${column} as text)`
}

function containsInsensitive(column: SQLWrapper, needle: string): SQL {
  return sql`lower(${column}) like ${`%${escapeLike(needle.toLowerCase())}%`}`
}

function businessRouteSql(column: SQLWrapper): SQL {
  return sql`(
    (${column} like 'http://%' or ${column} like 'https://%')
    and ${column} not like '%unknown.invalid%'
  )`
}

function pageIdFromListKey(key: string): string | undefined {
  const suffix = ':o:x:i:x:d:0'
  if (!key.startsWith('p:') || !key.endsWith(suffix)) return undefined
  return key.slice(2, key.length - suffix.length) || undefined
}

function listSortKey(targetId: string, kind: 'objects' | 'pages', item: HydratedViewAsset): string {
  return kind === 'pages' && item.pageId ? assetKey({ targetId, pageId: item.pageId }) : item.assetRefKey
}

export function matchesSearch(
  item: { name?: string; routeTemplate?: string; assetRefKey: string },
  search?: string,
): boolean {
  if (!search) return true
  const needle = search.toLowerCase()
  return [item.name, item.routeTemplate, item.assetRefKey].some((value) => value?.toLowerCase().includes(needle))
}

export function matchesLifecycle(item: { lifecycle: MapLifecycle }, lifecycle?: MapListQuery['lifecycle']): boolean {
  return !lifecycle || item.lifecycle === lifecycle
}

export function matchesCondition(
  item: { condition?: MapConditionSnapshot },
  query: Pick<MapListQuery, 'conditionSnapshot'>,
  evaluate?: MapConditionEvaluator,
): boolean {
  if (!query.conditionSnapshot) return true
  if (!evaluate) throw new Error('Map condition evaluator is required')
  return !item.condition || evaluate(item.condition, query.conditionSnapshot) !== 'unsatisfied'
}

function parseFeatures(value: unknown): MapDescriptorFeatures | undefined {
  if (!value) return undefined
  const parsed = mapDescriptorFeaturesSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parseCondition(value: unknown): MapConditionSnapshot | undefined {
  if (!value) return undefined
  const parsed = mapConditionSnapshotSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parseDimensions(value: unknown): MapDimensionStat[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = mapDimensionStatSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function searchFilters(
  db: Db,
  search: string | undefined,
  kind: 'objects' | 'pages' | undefined,
  columns: { assetRefKey: SQLWrapper; pageId: SQLWrapper; routeTemplate: SQLWrapper; features: SQLWrapper },
): SQL[] {
  if (!search) return []
  const name = jsonText(db, columns.features, 'semanticName')
  if (kind === 'pages') {
    return [
      or(
        containsInsensitive(columns.routeTemplate, search),
        containsInsensitive(idText(db, columns.pageId), search),
        containsInsensitive(columns.assetRefKey, search),
      )!,
    ]
  }
  return [
    or(
      containsInsensitive(columns.assetRefKey, search),
      containsInsensitive(columns.routeTemplate, search),
      containsInsensitive(name, search),
    )!,
  ]
}

function clueFilters(
  db: Db,
  clues: ReadQuery['clues'],
  routeTemplate: string | undefined,
  columns: { routeTemplate: SQLWrapper; features: SQLWrapper },
): SQL[] {
  const filters: SQL[] = []
  if (routeTemplate) {
    filters.push(or(isNull(columns.routeTemplate), eq(columns.routeTemplate, routeTemplate))!)
  }
  if (!clues) return filters
  for (const [path, value] of [
    ['regionKey', clues.region],
    ['role', clues.role],
    ['semanticName', clues.name],
  ] as const) {
    if (!value) continue
    const text = jsonText(db, columns.features, path)
    filters.push(sql`${text} = ${value}`)
  }
  return filters
}

function applyOverlay(
  targetId: string,
  overlays: Map<string, MapOverlayLifecycle>,
  item: HydratedViewAsset,
): HydratedViewAsset {
  const overlay = resolveAssetOverlay(overlays, item.assetRef)
  return {
    ...item,
    overlayLifecycle: overlay,
    lifecycle: overlay ?? item.lifecycle,
    executable: overlay !== 'RETIRED' && item.executable,
  }
}

function hydrateRow(
  targetId: string,
  view: ResolvedMapView,
  row: JoinRow,
  extras: {
    importance?: number
    rejectReasons?: string[]
    dimensions?: MapDimensionStat[]
    lastVerifiedAt?: string
    sampleCount?: number
    changeCount?: number
  },
): HydratedViewAsset {
  const condition = parseCondition(row.conditionSnapshot)
  const features = parseFeatures(row.features)
  const lastVerifiedAt =
    extras.lastVerifiedAt ??
    (row.lastVerifiedAt instanceof Date
      ? row.lastVerifiedAt.toISOString()
      : row.lastVerifiedAt ?? undefined)
  return {
    assetRefKey: row.assetRefKey,
    assetRef: assetRef({
      targetId,
      pageId: row.pageId,
      objectId: row.objectId,
      implementationKey: row.implementationKey,
      descriptorVersion: row.descriptorVersion,
    }),
    pageId: row.pageId ?? undefined,
    objectId: row.objectId ?? undefined,
    implementationKey: row.implementationKey ?? undefined,
    descriptorVersion: row.descriptorVersion ?? undefined,
    lifecycle: row.lifecycle,
    importance: extras.importance ?? asNumber(row.importance),
    executable: row.executable === 1,
    rejectReasons: extras.rejectReasons ?? row.rejectReasons ?? [],
    dimensions: extras.dimensions ?? parseDimensions(row.dimensions),
    lastVerifiedAt,
    sampleCount: extras.sampleCount ?? asNumber(row.sampleCount),
    changeCount: extras.changeCount ?? asNumber(row.changeCount),
    condition,
    features,
    routeTemplate: row.routeTemplate ?? undefined,
    evidenceAvailability:
      view.kind === 'release'
        ? 'available'
        : deriveMapEvidenceAvailability({
            sealed: false,
            projectionStatus: view.status,
            rebuildCompleteness: view.rebuildCompleteness,
            lastVerifiedAt,
            changeCount: extras.changeCount ?? asNumber(row.changeCount),
            hasDimensions: (extras.dimensions ?? parseDimensions(row.dimensions)).length > 0,
          }),
    unknownFields: condition?.unknownFields ?? [...DEFAULT_UNKNOWN_FIELDS],
    name: features?.semanticName,
  }
}

async function queryProjection(db: Db, view: ResolvedMapView, input: ReadQuery): Promise<JoinRow[] | number> {
  const { mapProjectionAssets: assets, mapPages: pages, mapObjectDescriptors: descriptors } = schemaFor(db)
  const columns = {
    assetRefKey: assets.assetRefKey,
    pageId: assets.pageId,
    routeTemplate: pages.routeTemplate,
    features: descriptors.features,
  }
  const filters: SQL[] = [eq(assets.projectionId, view.projectionId!)]
  if (input.objectId) filters.push(eq(assets.objectId, input.objectId))
  if (input.changeOnly) filters.push(sql`${assets.changeCount} > 0`)
  if (input.group === 'objects') filters.push(sql`${assets.objectId} is not null`)
  if (input.group === 'pages') filters.push(sql`${assets.pageId} is not null`)
  if (input.assetRef?.pageId) filters.push(eq(assets.pageId, input.assetRef.pageId))
  if (input.assetRef?.objectId) filters.push(eq(assets.objectId, input.assetRef.objectId))
  if (input.assetRef?.implementationKey) filters.push(eq(assets.implementationKey, input.assetRef.implementationKey))
  if (input.assetRef?.descriptorVersion) filters.push(eq(assets.descriptorVersion, input.assetRef.descriptorVersion))
  filters.push(
    ...clueFilters(db, input.clues, input.routeTemplate, {
      routeTemplate: pages.routeTemplate,
      features: descriptors.features,
    }),
    ...searchFilters(db, input.search, input.group, columns),
    businessRouteSql(pages.routeTemplate),
  )
  const scope = and(...filters)!
  if (input.group) {
    const partition = input.group === 'objects' ? assets.objectId : assets.pageId
    filters.push(sql`${assets.id} in (
      select ranked.id from (
        select ${assets.id} as id,
          row_number() over (
            partition by ${partition}
            order by coalesce(${assets.descriptorVersion}, 0) desc, ${assets.assetRefKey} asc
          ) as rn
        from ${assets}
        left join ${pages} on ${pages.id} = ${assets.pageId}
        left join ${descriptors}
          on ${descriptors.objectId} = ${assets.objectId}
          and ${descriptors.implementationKey} = ${assets.implementationKey}
          and ${descriptors.descriptorVersion} = ${assets.descriptorVersion}
        where ${scope}
      ) ranked
      where ranked.rn = 1
    )`)
  }
  if (input.group === 'pages' && input.afterKey) {
    const pageId = pageIdFromListKey(input.afterKey)
    if (pageId) filters.push(sql`${idText(db, assets.pageId)} > ${pageId}`)
    else filters.push(gt(assets.assetRefKey, input.afterKey))
  } else if (input.afterKey) {
    filters.push(gt(assets.assetRefKey, input.afterKey))
  }
  const where = and(...filters)!
  const joined = db
    .select({
      assetRefKey: assets.assetRefKey,
      pageId: assets.pageId,
      objectId: assets.objectId,
      implementationKey: assets.implementationKey,
      descriptorVersion: assets.descriptorVersion,
      lifecycle: assets.lifecycle,
      importance: assets.importance,
      executable: assets.executable,
      rejectReasons: assets.rejectReasons,
      dimensions: assets.dimensions,
      lastVerifiedAt: assets.lastVerifiedAt,
      sampleCount: assets.sampleCount,
      changeCount: assets.changeCount,
      routeTemplate: pages.routeTemplate,
      features: descriptors.features,
      conditionSnapshot: descriptors.conditionSnapshot,
    })
    .from(assets)
    .leftJoin(pages, eq(pages.id, assets.pageId))
    .leftJoin(
      descriptors,
      and(
        eq(descriptors.objectId, assets.objectId),
        eq(descriptors.implementationKey, assets.implementationKey),
        eq(descriptors.descriptorVersion, assets.descriptorVersion),
      ),
    )
    .where(where)
  if (input.countOnly) {
    const [row] = await db
      .select({ n: sql<number>`count(*)`.as('n') })
      .from(assets)
      .leftJoin(pages, eq(pages.id, assets.pageId))
      .leftJoin(
        descriptors,
        and(
          eq(descriptors.objectId, assets.objectId),
          eq(descriptors.implementationKey, assets.implementationKey),
          eq(descriptors.descriptorVersion, assets.descriptorVersion),
        ),
      )
      .where(scope)
    return asNumber(row?.n)
  }
  const ordered =
    input.group === 'pages'
      ? joined.orderBy(sql`${idText(db, assets.pageId)}`)
      : joined.orderBy(asc(assets.assetRefKey))
  return await (input.limit ? ordered.limit(input.limit) : ordered)
}

async function queryRelease(db: Db, view: ResolvedMapView, input: ReadQuery): Promise<JoinRow[] | number> {
  const { mapReleaseItems: items, mapPages: pages } = schemaFor(db)
  const columns = {
    assetRefKey: items.assetRefKey,
    pageId: items.pageId,
    routeTemplate: pages.routeTemplate,
    features: items.features,
  }
  const filters: SQL[] = [eq(items.releaseId, view.releaseId!)]
  if (input.objectId) filters.push(eq(items.objectId, input.objectId))
  if (input.group === 'objects') filters.push(sql`${items.objectId} is not null`)
  if (input.group === 'pages') filters.push(sql`${items.pageId} is not null`)
  if (input.assetRef?.pageId) filters.push(eq(items.pageId, input.assetRef.pageId))
  if (input.assetRef?.objectId) filters.push(eq(items.objectId, input.assetRef.objectId))
  if (input.assetRef?.implementationKey) filters.push(eq(items.implementationKey, input.assetRef.implementationKey))
  if (input.assetRef?.descriptorVersion) filters.push(eq(items.descriptorVersion, input.assetRef.descriptorVersion))
  filters.push(
    ...clueFilters(db, input.clues, input.routeTemplate, {
      routeTemplate: pages.routeTemplate,
      features: items.features,
    }),
    ...searchFilters(db, input.search, input.group, columns),
    businessRouteSql(pages.routeTemplate),
  )
  if (input.changeOnly) filters.push(sql`1 = 0`)
  const scope = and(...filters)!
  if (input.group) {
    const partition = input.group === 'objects' ? items.objectId : items.pageId
    filters.push(sql`${items.id} in (
      select ranked.id from (
        select ${items.id} as id,
          row_number() over (
            partition by ${partition}
            order by coalesce(${items.descriptorVersion}, 0) desc, ${items.assetRefKey} asc
          ) as rn
        from ${items}
        left join ${pages} on ${pages.id} = ${items.pageId}
        where ${scope}
      ) ranked
      where ranked.rn = 1
    )`)
  }
  if (input.group === 'pages' && input.afterKey) {
    const pageId = pageIdFromListKey(input.afterKey)
    if (pageId) filters.push(sql`${idText(db, items.pageId)} > ${pageId}`)
    else filters.push(gt(items.assetRefKey, input.afterKey))
  } else if (input.afterKey) {
    filters.push(gt(items.assetRefKey, input.afterKey))
  }
  const where = and(...filters)!
  if (input.countOnly) {
    const [row] = await db
      .select({ n: sql<number>`count(*)`.as('n') })
      .from(items)
      .leftJoin(pages, eq(pages.id, items.pageId))
      .where(scope)
    return asNumber(row?.n)
  }
  const joined = db
    .select({
      assetRefKey: items.assetRefKey,
      pageId: items.pageId,
      objectId: items.objectId,
      implementationKey: items.implementationKey,
      descriptorVersion: items.descriptorVersion,
      lifecycle: items.lifecycle,
      executable: items.executable,
      routeTemplate: pages.routeTemplate,
      features: items.features,
      conditionSnapshot: items.conditionSnapshot,
    })
    .from(items)
    .leftJoin(pages, eq(pages.id, items.pageId))
    .where(where)
  const ordered =
    input.group === 'pages' ? joined.orderBy(sql`${idText(db, items.pageId)}`) : joined.orderBy(asc(items.assetRefKey))
  const rows = await (input.limit ? ordered.limit(input.limit) : ordered)
  return rows.map((row) => ({
    ...row,
    importance: 0,
    rejectReasons: [],
    dimensions: [],
    lastVerifiedAt: null,
    sampleCount: 0,
    changeCount: 0,
  }))
}

function emptyView(view: ResolvedMapView): boolean {
  return !view.projectionId && !view.releaseId
}

async function queryRows(db: Db, view: ResolvedMapView, input: ReadQuery): Promise<JoinRow[] | number> {
  if (emptyView(view)) return input.countOnly ? 0 : []
  return view.kind === 'release' ? queryRelease(db, view, input) : queryProjection(db, view, input)
}

function hydrateRows(targetId: string, view: ResolvedMapView, rows: JoinRow[]): HydratedViewAsset[] {
  return rows.map((row) =>
    hydrateRow(targetId, view, row, view.kind === 'release' ? { importance: 0, rejectReasons: [], dimensions: [], sampleCount: 0, changeCount: 0 } : {}),
  )
}

async function overlaysFor(db: Db, view: ResolvedMapView): Promise<Map<string, MapOverlayLifecycle>> {
  return view.kind === 'release' ? new Map() : loadOverlays(db, view.targetId)
}

export async function loadHydratedViewAssets(
  db: Db,
  view: ResolvedMapView,
  input: Omit<ReadQuery, 'countOnly' | 'group'> & { group?: ReadQuery['group'] } = {},
): Promise<HydratedViewAsset[]> {
  const rows = (await queryRows(db, view, input)) as JoinRow[]
  const overlays = await overlaysFor(db, view)
  return hydrateRows(view.targetId, view, rows).map((item) => applyOverlay(view.targetId, overlays, item))
}

export async function countMatchCandidates(
  db: Db,
  view: ResolvedMapView,
  input: Pick<ReadQuery, 'assetRef' | 'routeTemplate' | 'clues'>,
): Promise<number> {
  return (await queryRows(db, view, { ...input, countOnly: true })) as number
}

export async function pageViewListAssets(
  db: Db,
  view: ResolvedMapView,
  kind: 'objects' | 'pages',
  query: MapListQuery,
  afterKey: string | undefined,
  evaluate?: MapConditionEvaluator,
): Promise<HydratedViewAsset[]> {
  const overlays = await overlaysFor(db, view)
  const want = query.limit + 1
  const needsScan = Boolean(query.lifecycle || query.conditionSnapshot)
  const fetchSize = needsScan ? Math.max(want * 4, 64) : want
  const collected: HydratedViewAsset[] = []
  let after = afterKey
  while (collected.length < want) {
    const rows = (await queryRows(db, view, {
      group: kind,
      afterKey: after,
      limit: fetchSize,
      search: query.search,
    })) as JoinRow[]
    if (!rows.length) break
    const hydrated = hydrateRows(view.targetId, view, rows).map((item) => applyOverlay(view.targetId, overlays, item))
    collected.push(
      ...hydrated.filter(
        (item) =>
          !isNoiseMapRoute(item.routeTemplate) &&
          matchesLifecycle(item, query.lifecycle) &&
          matchesCondition(item, query, evaluate),
      ),
    )
    after = listSortKey(view.targetId, kind, hydrated.at(-1)!)
    if (rows.length < fetchSize || !needsScan) break
  }
  return collected.slice(0, want)
}

export async function pageViewChangedAssets(
  db: Db,
  view: ResolvedMapView,
  query: MapListQuery,
  afterKey: string | undefined,
  evaluate?: MapConditionEvaluator,
): Promise<HydratedViewAsset[]> {
  const overlays = await overlaysFor(db, view)
  const want = query.limit + 1
  const needsScan = Boolean(query.search || query.lifecycle || query.conditionSnapshot)
  const fetchSize = needsScan ? Math.max(want * 4, 64) : want
  const collected: HydratedViewAsset[] = []
  let after = afterKey
  while (collected.length < want) {
    const rows = (await queryRows(db, view, {
      changeOnly: true,
      afterKey: after,
      limit: fetchSize,
      search: query.search,
    })) as JoinRow[]
    if (!rows.length) break
    const hydrated = hydrateRows(view.targetId, view, rows)
      .map((item) => applyOverlay(view.targetId, overlays, item))
      .filter(
        (item) =>
          !isNoiseMapRoute(item.routeTemplate) &&
          matchesSearch(item, query.search) &&
          matchesLifecycle(item, query.lifecycle) &&
          matchesCondition(item, query, evaluate),
      )
    collected.push(...hydrated)
    after = rows.at(-1)!.assetRefKey
    if (rows.length < fetchSize || !needsScan) break
  }
  return collected.slice(0, want)
}

export async function summarizeViewAssets(
  db: Db,
  view: ResolvedMapView,
  query: MapListQuery,
  evaluate?: MapConditionEvaluator,
): Promise<{ pageCount: number; objectCount: number; unknownConditionCount: number; changeCount: number }> {
  if (emptyView(view)) return { pageCount: 0, objectCount: 0, unknownConditionCount: 0, changeCount: 0 }
  if (!query.search && !query.lifecycle && !query.conditionSnapshot) {
    if (view.kind === 'release') {
      const { mapReleaseItems: items, mapPages: pages } = schemaFor(db)
      const [row] = await db
        .select({
          pageCount: sql<number>`count(distinct ${items.pageId})`.as('page_count'),
          objectCount: sql<number>`count(distinct ${items.objectId})`.as('object_count'),
          unknownConditionCount: sql<number>`coalesce(sum(case when ${items.conditionSnapshot} is null or ${unknownFieldsLength(db, items.conditionSnapshot)} > 0 then 1 else 0 end), 0)`.as(
            'unknown_condition_count',
          ),
        })
        .from(items)
        .leftJoin(pages, eq(pages.id, items.pageId))
        .where(and(eq(items.releaseId, view.releaseId!), businessRouteSql(pages.routeTemplate)))
      return {
        pageCount: asNumber(row?.pageCount),
        objectCount: asNumber(row?.objectCount),
        unknownConditionCount: asNumber(row?.unknownConditionCount),
        changeCount: 0,
      }
    }
    const { mapProjectionAssets: assets, mapObjectDescriptors: descriptors, mapPages: pages } = schemaFor(db)
    const [row] = await db
      .select({
        pageCount: sql<number>`count(distinct ${assets.pageId})`.as('page_count'),
        objectCount: sql<number>`count(distinct ${assets.objectId})`.as('object_count'),
        changeCount: sql<number>`coalesce(sum(case when ${assets.changeCount} > 0 then 1 else 0 end), 0)`.as(
          'change_count',
        ),
        unknownConditionCount: sql<number>`coalesce(sum(case when ${descriptors.id} is null or ${unknownFieldsLength(db, descriptors.conditionSnapshot)} > 0 then 1 else 0 end), 0)`.as(
          'unknown_condition_count',
        ),
      })
      .from(assets)
      .leftJoin(pages, eq(pages.id, assets.pageId))
      .leftJoin(
        descriptors,
        and(
          eq(descriptors.objectId, assets.objectId),
          eq(descriptors.implementationKey, assets.implementationKey),
          eq(descriptors.descriptorVersion, assets.descriptorVersion),
        ),
      )
      .where(and(eq(assets.projectionId, view.projectionId!), businessRouteSql(pages.routeTemplate)))
    return {
      pageCount: asNumber(row?.pageCount),
      objectCount: asNumber(row?.objectCount),
      unknownConditionCount: asNumber(row?.unknownConditionCount),
      changeCount: asNumber(row?.changeCount),
    }
  }
  const pages = new Set<string>()
  const objects = new Set<string>()
  let unknownConditionCount = 0
  let changeCount = 0
  let after: string | undefined
  const overlays = await overlaysFor(db, view)
  while (true) {
    const rows = (await queryRows(db, view, { afterKey: after, limit: 200, search: query.search })) as JoinRow[]
    if (!rows.length) break
    for (const item of hydrateRows(view.targetId, view, rows)
      .map((row) => applyOverlay(view.targetId, overlays, row))
      .filter(
        (row) =>
          !isNoiseMapRoute(row.routeTemplate) &&
          matchesLifecycle(row, query.lifecycle) &&
          matchesCondition(row, query, evaluate),
      )) {
      if (item.pageId) pages.add(item.pageId)
      if (item.objectId) objects.add(item.objectId)
      if (item.unknownFields.length > 0) unknownConditionCount += 1
      if (item.changeCount > 0) changeCount += 1
    }
    after = rows.at(-1)!.assetRefKey
    if (rows.length < 200) break
  }
  return { pageCount: pages.size, objectCount: objects.size, unknownConditionCount, changeCount }
}

export function matchViewOverflow(count: number): boolean {
  return count > MAP_QUERY_PAGE_CANDIDATE_MAX
}

export function toQueryViewAsset(item: HydratedViewAsset) {
  return {
    assetRef: mapAssetRefSchema.parse(item.assetRef),
    assetRefKey: item.assetRefKey,
    lifecycle: item.lifecycle,
    importance: item.importance,
    executable: item.executable,
    rejectReasons: item.rejectReasons,
    dimensions: item.dimensions,
    lastVerifiedAt: item.lastVerifiedAt,
    sampleCount: item.sampleCount,
    changeCount: item.changeCount,
    condition: item.condition,
    features: item.features,
    routeTemplate: item.routeTemplate,
    evidenceAvailability: item.evidenceAvailability,
  }
}
