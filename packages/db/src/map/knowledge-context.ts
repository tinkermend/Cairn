import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  canonicalJson,
  mapConditionSnapshotSchema,
  targetKnowledgeContextQuerySchema,
  targetKnowledgeContextSchema,
  type MapIngestElement,
  type TargetKnowledgeContext,
  type TargetKnowledgeContextQuery,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { composeCurrentIngestRows, loadIngestSurfaceState } from './ingest-surface.js'
import { requireLiveTarget } from './view.js'

function redact(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/((?:password|token|secret|api[_-]?key|口令|密码)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;，；]+)/gi, '$1***')
    .slice(0, 512)
}

function relevance(text: string, intent: string): number {
  if (!intent) return 0
  const normalized = text.toLocaleLowerCase()
  const query = intent.toLocaleLowerCase().trim()
  if (normalized.includes(query)) return 100
  const words = query.split(/[\s,，。:：;；]+/).filter(word => word.length > 1)
  let score = words.filter(word => normalized.includes(word)).length * 8
  if (!words.length && query.length >= 2) {
    for (let index = 0; index < query.length - 1; index++)
      if (normalized.includes(query.slice(index, index + 2))) score++
  }
  return score
}

export function scoreKnowledgePage(input: {
  title: string
  urlPattern: string
  menuPath: string[]
  elements: Array<Pick<MapIngestElement, 'name' | 'category'>>
  intent: string
}): number {
  const pageIdentity = relevance([input.title, input.urlPattern, ...input.menuPath].join(' '), input.intent)
  const content = Math.max(0, ...input.elements
    .filter(element => element.category !== 'navigation')
    .map(element => relevance(element.name, input.intent)))
  return pageIdentity * 4 + content * 2
}

function priority(element: MapIngestElement): number {
  return element.category === 'input' ? 0
    : element.category === 'action_button' ? 1
      : element.category === 'table_column' ? 2
        : element.category === 'navigation' ? 3 : 4
}

export function deriveLocatorStability(input: {
  observations: Array<{ locator: unknown; locatorUnique?: boolean }>
  verified: boolean
}): 'high' | 'medium' | 'low' {
  if (input.verified && input.observations[0]?.locatorUnique !== false) return 'high'
  const current = canonicalJson(input.observations[0]?.locator ?? null)
  const distinct = new Set(input.observations.map(sample => canonicalJson(sample.locator ?? null)))
  const uniqueHits = input.observations.filter(sample => sample.locatorUnique === true).length
  let consecutiveHits = 0
  for (const sample of input.observations) {
    if (!sample.locatorUnique || canonicalJson(sample.locator ?? null) !== current) break
    consecutiveHits++
  }
  if (uniqueHits >= 3 && consecutiveHits >= 2 && distinct.size === 1) return 'high'
  if (uniqueHits >= 1 && input.observations.length >= 2 && distinct.size <= 2) return 'medium'
  return 'low'
}

export function assetConditionMatchesAccount(condition: unknown, targetAccountId: string): boolean {
  const parsed = mapConditionSnapshotSchema.safeParse(condition)
  return parsed.success && parsed.data.accountBinding.presence === 'known'
    && parsed.data.accountBinding.targetAccountId === targetAccountId
}

export async function getTargetKnowledgeContext(
  db: Db, targetId: string, query: TargetKnowledgeContextQuery,
): Promise<TargetKnowledgeContext> {
  await requireLiveTarget(db, targetId)
  const parsed = targetKnowledgeContextQuerySchema.parse(query)
  const { mapMenuEntries, mapIngestPages, mapJobs, mapProjectionHeads,
    mapProjectionAssets, mapObjectDescriptors, mapPages, mapScenarioBindings, scenarios } = schemaFor(db)
  const entries = await db.select().from(mapMenuEntries)
    .where(and(eq(mapMenuEntries.targetId, targetId), isNull(mapMenuEntries.archivedAt)))
    .orderBy(mapMenuEntries.orderIndex).limit(64)
  const state = await loadIngestSurfaceState(db, targetId, parsed.targetAccountId)
  const selected = state.latest
  const rows = composeCurrentIngestRows(state.base, state.overlays)
  const menuTree = entries.map(entry => ({
    entryId: entry.id, name: redact(entry.entryName).slice(0, 128),
    pageKeys: [...new Set(rows.filter(row => row.entryId === entry.id).map(row => row.pageKey))].slice(0, 100),
  }))
  if (!selected) return targetKnowledgeContextSchema.parse({
    targetId, targetAccountId: parsed.targetAccountId ?? null, accountSelectionAmbiguous: false,
    releaseId: null, generatedAt: new Date().toISOString(), menuTree, pages: [], truncated: false,
  })

  const observedAccounts = parsed.targetAccountId ? [] : await db.select({ id: mapJobs.targetAccountId })
    .from(mapJobs).where(and(eq(mapJobs.targetId, targetId), eq(mapJobs.jobKind, 'map_ingest'),
      eq(mapJobs.jobStatus, 'completed'), ne(mapJobs.scope, 'detect_top_menus')))
    .groupBy(mapJobs.targetAccountId).limit(2)
  const accountSelectionAmbiguous = !parsed.targetAccountId && observedAccounts.length > 1

  const grouped = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = grouped.get(row.pageKey) ?? []
    list.push(row)
    grouped.set(row.pageKey, list)
  }
  const matches = [...grouped].filter(([key, views]) => {
    if (parsed.pageKey && key !== parsed.pageKey) return false
    if (parsed.menuPath && !parsed.menuPath.every((segment, index) => views[0]!.menuPathJson[index] === segment)) return false
    return true
  })
  matches.sort((left, right) => {
    const score = (views: typeof rows) => scoreKnowledgePage({
      title: views[0]!.title, urlPattern: views[0]!.urlPattern,
      menuPath: views[0]!.menuPathJson,
      elements: views.flatMap(view => view.elementsJson), intent: parsed.intent ?? '',
    })
    return score(right[1]) - score(left[1]) || left[0].localeCompare(right[0])
  })
  const selectedPages = matches.slice(0, parsed.maxPages)
  let truncated = accountSelectionAmbiguous || state.truncatedJobs || matches.length > parsed.maxPages
  const include = new Set(parsed.include ?? ['elements', 'options', 'changes', 'scenarios'])
  const [projectionHead] = await db.select({ id: mapProjectionHeads.currentProjectionId })
    .from(mapProjectionHeads).where(eq(mapProjectionHeads.targetId, targetId)).limit(1)
  const projectedPages = projectionHead
    ? await db.select({ id: mapPages.id, routeTemplate: mapPages.routeTemplate }).from(mapPages)
      .where(eq(mapPages.targetId, targetId)) : []
  const pageIdByRoute = new Map<string, string | null>()
  for (const page of projectedPages) {
    const previous = pageIdByRoute.get(page.routeTemplate)
    pageIdByRoute.set(page.routeTemplate, previous === undefined ? page.id : null)
  }
  const projectedAssets = projectionHead && !accountSelectionAmbiguous
    ? await db.select().from(mapProjectionAssets)
      .where(eq(mapProjectionAssets.projectionId, projectionHead.id)) : []
  const projectedDescriptors = projectionHead && !accountSelectionAmbiguous
    ? await db.select().from(mapObjectDescriptors)
      .where(eq(mapObjectDescriptors.targetId, targetId)) : []
  const descriptorByVersion = new Map(projectedDescriptors.map(item => [
    item.objectId + '|' + item.implementationKey + '|' + item.descriptorVersion, item,
  ]))
  const assetRefs = new Map<string, { ref: string; verified: boolean } | null>()
  for (const asset of projectedAssets) {
    if (!asset.pageId || !asset.objectId || !asset.implementationKey || !asset.descriptorVersion) continue
    const descriptor = descriptorByVersion.get(asset.objectId + '|' + asset.implementationKey + '|' + asset.descriptorVersion)
    if (!assetConditionMatchesAccount(descriptor?.conditionSnapshot, selected.targetAccountId)) continue
    const fingerprint = descriptor?.features.fingerprint
    if (!fingerprint) continue
    const key = asset.pageId + '|' + fingerprint
    const previous = assetRefs.get(key)
    assetRefs.set(key, previous === undefined
      ? { ref: asset.assetRefKey, verified: asset.lifecycle === 'VERIFIED' || asset.lifecycle === 'TRUSTED' }
      : null)
  }
  const selectedPageIds = [...new Set(selectedPages.map(([, views]) =>
    pageIdByRoute.get(views[0]!.urlPattern)).filter((value): value is string => Boolean(value)))]
  const bindings = selectedPageIds.length && include.has('scenarios')
    ? await db.select({ pageId: mapScenarioBindings.pageId, scenarioId: mapScenarioBindings.scenarioId })
      .from(mapScenarioBindings)
      .where(and(eq(mapScenarioBindings.targetId, targetId), eq(mapScenarioBindings.status, 'active'),
        inArray(mapScenarioBindings.pageId, selectedPageIds))) : []
  const scenarioIds = [...new Set(bindings.map(binding => binding.scenarioId))]
  const linkedScenarios = scenarioIds.length
    ? await db.select({ id: scenarios.id, name: scenarios.name }).from(scenarios)
      .where(inArray(scenarios.id, scenarioIds)) : []
  const scenarioName = new Map(linkedScenarios.map(item => [item.id, item.name]))
  const history = await db.select({
    jobId: mapIngestPages.jobId,
    pageKey: mapIngestPages.pageKey,
    elements: mapIngestPages.elementsJson,
  }).from(mapIngestPages)
    .where(and(eq(mapIngestPages.targetId, targetId),
      eq(mapIngestPages.targetAccountId, selected.targetAccountId)))
    .orderBy(desc(mapIngestPages.observedAt)).limit(2000)
  const sightings = new Map<string, Array<{ jobId: string; locator: unknown; locatorUnique?: boolean }>>()
  for (const view of history) {
    for (const element of view.elements) {
      const key = view.pageKey + '|' + element.fingerprint
      const list = sightings.get(key) ?? []
      if (!list.some(item => item.jobId === view.jobId)) list.push({
        jobId: view.jobId, locator: element.locator, locatorUnique: element.locatorUnique,
      })
      sightings.set(key, list)
    }
  }
  let remainingCharacters = 24_000
  const pages = selectedPages.map(([pageKey, views]) => {
    const representative = views[0]!
    const pageId = pageIdByRoute.get(representative.urlPattern)
    return {
      pageKey, menuPath: representative.menuPathJson.map(value => redact(value).slice(0, 128)),
      title: redact(representative.title).slice(0, 200),
      urlPattern: representative.urlPattern,
      views: views.slice(0, 20).map(view => {
        const prefix = 'view:' + pageKey + ':'
        const label = view.viewStateKey.startsWith(prefix)
          ? view.viewStateKey.slice(prefix.length).replace(/:v\d+$/, '') : 'default'
        const elements = include.has('elements') && !accountSelectionAmbiguous
          ? [...view.elementsJson].sort((left, right) => priority(left) - priority(right)).flatMap(element => {
            if (!element.locator) return []
            const name = redact(element.name).slice(0, 128)
            const cost = name.length + canonicalJson(element.locator).length + (element.options?.join('').length ?? 0)
            if (remainingCharacters < cost) { truncated = true; return [] }
            remainingCharacters -= cost
            const samples = sightings.get(pageKey + '|' + element.fingerprint) ?? []
            const asset = pageId ? assetRefs.get(pageId + '|' + element.fingerprint) : undefined
            const stability = deriveLocatorStability({ observations: samples, verified: asset?.verified ?? false })
            return [{
              assetRef: asset?.ref ?? null,
              category: element.category, name, locator: element.locator, stability,
              ...(include.has('options') && element.options ? { options: element.options.map(option => redact(option).slice(0, 128)) } : {}),
              ...(element.unsafeAction ? { unsafeAction: true } : {}),
            }]
          }).slice(0, 100)
          : []
        if (include.has('elements') && elements.length < view.elementsJson.length) truncated = true
        return { viewStateKey: view.viewStateKey, label: redact(label).slice(0, 128), elements }
      }),
      ...(include.has('changes') ? { recentChanges: (selected.ingestSummary?.changes ?? [])
        .filter(change => change.pageKey === pageKey).slice(0, 100) } : {}),
      ...(include.has('scenarios') ? { relatedScenarios: [...new Set(bindings
        .filter(binding => binding.pageId === pageId).map(binding => binding.scenarioId))]
        .flatMap(scenarioId => scenarioName.has(scenarioId)
          ? [{ scenarioId, name: scenarioName.get(scenarioId)! }] : []).slice(0, 20) } : {}),
    }
  })
  return targetKnowledgeContextSchema.parse({
    targetId, targetAccountId: selected.targetAccountId, accountSelectionAmbiguous,
    releaseId: selected.releaseId ?? null,
    generatedAt: new Date().toISOString(), menuTree, pages, truncated,
  })
}
