import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  MAP_PROJECTION_BATCH_BUDGET_MS,
  MAP_PROJECTION_PLAN_OBJECT_MAX,
  mapImplementationKey,
  mapProjectionPlanSchema,
  targetDescriptorSchema,
  type MapAssetPlan,
  type MapDescriptorFeatures,
  type MapDimensionStat,
  type MapObservation,
  type MapProjectionObjectState,
  type MapProjectionPageState,
  type MapProjectionPlan,
  type MapProjectionState,
  type MapVerification,
} from '@cairn/shared'
import { evaluateCondition } from './conditions.js'
import {
  classifyRoute,
  cluesFromObservation,
  matchObjectIdentity,
  matchPageIdentity,
  objectAllocationKey,
  stableObjectToken,
} from './identity.js'
import type { MapFactPageItem } from './ports.js'
import { applyDimension, attributeVerification, lifecycleFromEvidence } from './verification.js'

export type ProjectionWorkingSetHints = {
  pageAllocationKeys: string[]
  objectAllocationKeys: string[]
  observationIds: string[]
}

export function projectionWorkingSetHints(facts: readonly MapFactPageItem[]): ProjectionWorkingSetHints {
  const pageAllocationKeys = new Set<string>()
  const objectAllocationKeys = new Set<string>()
  const observationIds = new Set<string>()
  for (const fact of facts) {
    if (fact.type === 'verification') {
      for (const id of fact.verification.observationIds) observationIds.add(id)
      continue
    }
    observationIds.add(fact.observation.id)
    const frameName = fact.observation.framePath[0]?.name ?? fact.observation.framePath[0]?.urlPattern
    const page = classifyRoute({
      url: fact.observation.topUrlPattern,
      framePathLength: fact.observation.framePath.length,
      frameName,
    })
    pageAllocationKeys.add(page.allocationKey)
    for (const observation of observationsForProjection(fact.observation)) {
      objectAllocationKeys.add(objectAllocationFromObservation(observation, page.allocationKey))
    }
  }
  return {
    pageAllocationKeys: [...pageAllocationKeys],
    objectAllocationKeys: [...objectAllocationKeys],
    observationIds: [...observationIds],
  }
}

const INVENTORY_ROLES = new Set(['menuitem', 'link', 'button', 'heading', 'tab', 'treeitem'])
const INVENTORY_REGION = 'control'
const INVENTORY_ITEM_CAP = 80

type InventoryItem = { role: string; name: string }

function clip(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

export function inventoryItemsFromObservation(observation: MapObservation): InventoryItem[] {
  const features = observation.structuralSummary.features
  if (!features || typeof features !== 'object' || Array.isArray(features)) return []
  const named = (features as { kind?: unknown; named?: unknown }).kind === 'surface-inventory'
    ? (features as { named?: unknown }).named
    : undefined
  if (!Array.isArray(named)) return []
  const items: InventoryItem[] = []
  const seen = new Set<string>()
  for (const raw of named) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const role = typeof (raw as { role?: unknown }).role === 'string' ? clip((raw as { role: string }).role, 64) : ''
    const name = typeof (raw as { name?: unknown }).name === 'string' ? clip((raw as { name: string }).name, 128) : ''
    if (!role || !name || !INVENTORY_ROLES.has(role)) continue
    const key = `${role}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ role, name })
    if (items.length >= INVENTORY_ITEM_CAP) break
  }
  return items
}

function observationFromInventory(observation: MapObservation, item: InventoryItem): MapObservation {
  return {
    ...observation,
    regionRefs: [{ key: INVENTORY_REGION, kind: 'action_object' }],
    semanticSummary: {
      predicates: [
        { name: 'role', value: item.role },
        { name: 'label', value: item.name },
        { name: 'name', value: item.name },
      ],
    },
  }
}

function observationsForProjection(observation: MapObservation): MapObservation[] {
  return [observation, ...inventoryItemsFromObservation(observation).map((item) => observationFromInventory(observation, item))]
}

function objectAllocationFromObservation(observation: MapObservation, pageAllocationKey: string): string {
  const clues = cluesFromObservation(observation)
  const stable = stableObjectToken({
    testId: clues.testId,
    role: clues.role,
    name: clues.name,
    regionKey: clues.regionKey,
    url: clues.url,
    sourceEventKey: observation.sourceEventKey,
  })
  return objectAllocationKey({
    pageAllocationKey,
    regionKey: clues.regionKey,
    stableToken: stable.token,
  })
}

function locatorsFromObservation(observation: MapObservation) {
  const clues = cluesFromObservation(observation)
  const candidates: Array<{ by: 'testId' | 'role' | 'text'; value: string; name?: string }> = []
  if (clues.testId) candidates.push({ by: 'testId', value: clip(clues.testId, 512) })
  if (clues.role && clues.name) candidates.push({ by: 'role', value: clip(clues.role, 512), name: clip(clues.name, 256) })
  else if (clues.role) candidates.push({ by: 'role', value: clip(clues.role, 512) })
  if (clues.name && candidates.length < 5) candidates.push({ by: 'text', value: clip(clues.name, 512) })
  if (candidates.length === 0) return undefined
  const parsed = targetDescriptorSchema.safeParse({
    framePath: observation.framePath,
    candidates,
  })
  return parsed.success ? parsed.data : undefined
}

function featuresFromObservation(observation: MapObservation): MapDescriptorFeatures {
  const clues = cluesFromObservation(observation)
  return {
    locators: locatorsFromObservation(observation),
    semanticName: clues.name,
    role: clues.role,
    testId: clues.testId,
    regionKey: clues.regionKey,
    rowPattern: observation.actionRef?.instanceBinding
      ? { template: 'instance', bindingKey: observation.actionRef.instanceBinding.key }
      : undefined,
  }
}

function pagesForIdentity(
  pages: Iterable<MapProjectionPageState>,
  planPages: Iterable<MapProjectionPlan['pages'][number]>,
): MapProjectionPageState[] {
  const merged = new Map<string, MapProjectionPageState>()
  for (const page of pages) merged.set(page.allocationKey, page)
  for (const page of planPages) {
    merged.set(page.allocationKey, {
      id: merged.get(page.allocationKey)?.id ?? page.allocationKey,
      allocationKey: page.allocationKey,
      kind: page.kind,
      routeTemplate: page.routeTemplate,
    })
  }
  return [...merged.values()]
}

function objectsForIdentity(
  objects: Iterable<MapProjectionObjectState>,
  planObjects: Iterable<MapProjectionPlan['objects'][number]>,
): MapProjectionObjectState[] {
  const merged = new Map<string, MapProjectionObjectState>()
  for (const object of objects) merged.set(object.allocationKey, object)
  for (const object of planObjects) {
    merged.set(object.allocationKey, {
      id: merged.get(object.allocationKey)?.id ?? object.allocationKey,
      allocationKey: object.allocationKey,
      pageId: merged.get(object.allocationKey)?.pageId ?? object.pageAllocationKey,
      pageAllocationKey: object.pageAllocationKey,
      regionKey: object.regionKey,
      stableToken: object.stableToken,
    })
  }
  return [...merged.values()]
}

function assetKey(input: {
  pageAllocationKey?: string
  objectAllocationKey?: string
  implementationKey?: string
}): string {
  return [input.pageAllocationKey ?? 'x', input.objectAllocationKey ?? 'x', input.implementationKey ?? 'x'].join('|')
}

function cloneAsset(plan: MapAssetPlan): MapAssetPlan {
  return {
    ...plan,
    rejectReasons: [...plan.rejectReasons],
    dimensions: plan.dimensions.map((item) => ({ ...item })),
  }
}

export function planProjectionBatch(input: {
  state: MapProjectionState
  facts: MapFactPageItem[]
  now: string
  budgetMs?: number
}): MapProjectionPlan {
  const started = Date.now()
  const budgetMs = input.budgetMs ?? MAP_PROJECTION_BATCH_BUDGET_MS
  const pages = new Map(input.state.pages.map((page) => [page.allocationKey, page]))
  const objects = new Map(input.state.objects.map((object) => [object.allocationKey, object]))
  const pageById = new Map(input.state.pages.map((page) => [page.id, page]))
  const objectById = new Map(input.state.objects.map((object) => [object.id, object]))
  const assigned = new Set(input.state.assignments.map((item) => item.observationId))
  const knownAssets = new Map<string, MapAssetPlan>()
  for (const asset of input.state.assets) {
    const page = asset.pageId ? pageById.get(asset.pageId) : undefined
    const object = asset.objectId ? objectById.get(asset.objectId) : undefined
    knownAssets.set(
      assetKey({
        pageAllocationKey: page?.allocationKey,
        objectAllocationKey: object?.allocationKey,
        implementationKey: asset.implementationKey,
      }),
      {
        pageAllocationKey: page?.allocationKey,
        objectAllocationKey: object?.allocationKey,
        implementationKey: asset.implementationKey,
        lifecycle:
          asset.lifecycle === 'TRUSTED' || asset.lifecycle === 'RETIRED' || asset.lifecycle === 'STALE'
            ? 'VERIFIED'
            : asset.lifecycle,
        importance: asset.importance,
        executable: asset.executable,
        rejectReasons: [...asset.rejectReasons],
        dimensions: asset.dimensions.map((item) => ({ ...item })),
        sampleCount: asset.sampleCount,
        changeCount: asset.changeCount,
        lastVerifiedAt: asset.lastVerifiedAt,
      },
    )
  }
  const assets = new Map<string, MapAssetPlan>()

  const planPages = new Map<string, MapProjectionPlan['pages'][number]>()
  const planObjects = new Map<string, MapProjectionPlan['objects'][number]>()
  const assignments: MapProjectionPlan['assignments'] = []
  const implementations = new Map<string, MapProjectionPlan['implementations'][number]>()
  const descriptors = new Map<string, MapProjectionPlan['descriptors'][number]>()
  const conflicts: MapProjectionPlan['conflicts'] = []
  const observations = new Map<string, MapObservation>()
  let nextCursor = input.state.cursor
  let completeness: MapProjectionPlan['rebuildCompleteness'] = input.state.rebuildCompleteness ?? 'complete'

  const upsertAsset = (
    keys: { pageAllocationKey?: string; objectAllocationKey?: string; implementationKey?: string },
    mutate: (asset: MapAssetPlan) => void,
  ) => {
    const key = assetKey(keys)
    const current = assets.get(key) ?? knownAssets.get(key)
    const next = current
      ? cloneAsset(current)
      : {
          pageAllocationKey: keys.pageAllocationKey,
          objectAllocationKey: keys.objectAllocationKey,
          implementationKey: keys.implementationKey,
          lifecycle: 'DISCOVERED' as const,
          importance: 0,
          executable: false,
          rejectReasons: [] as string[],
          dimensions: [] as MapDimensionStat[],
          sampleCount: 0,
          changeCount: 0,
        }
    mutate(next)
    next.lifecycle = lifecycleFromEvidence({
      hasObservation: next.sampleCount > 0,
      dimensions: next.dimensions,
    })
    const unknownRequired = next.rejectReasons.includes('CONDITION_UNKNOWN')
    next.executable = next.lifecycle === 'VERIFIED' && !unknownRequired
    assets.set(key, next)
  }

  for (const fact of input.facts) {
    if (Date.now() - started > budgetMs) break
    nextCursor = fact.ingestSeq
    if (fact.contentAvailability !== 'available') completeness = 'partial'
    if (fact.type === 'observation') {
      observations.set(fact.observation.id, fact.observation)
      const pageMatch = matchPageIdentity({
        observation: fact.observation,
        pages: pagesForIdentity(pages.values(), planPages.values()),
      })
      planPages.set(pageMatch.allocation.allocationKey, {
        kind: pageMatch.allocation.kind,
        allocationKey: pageMatch.allocation.allocationKey,
        routeTemplate: pageMatch.allocation.routeTemplate,
        frameKey: pageMatch.allocation.frameKey,
        reasons: pageMatch.reasons,
        matchResult: pageMatch.matchResult,
      })
      if (pageMatch.matchResult === 'AMBIGUOUS') {
        assignments.push({
          observationId: fact.observation.id,
          matchResult: 'AMBIGUOUS',
          reasons: pageMatch.reasons,
        })
        continue
      }
      const pageAllocationKey = pageMatch.allocation.allocationKey
      const rememberObject = (observed: MapObservation, sampleKey: string) => {
        const objectMatch = matchObjectIdentity({
          observation: observed,
          pageAllocationKey,
          objects: objectsForIdentity(objects.values(), planObjects.values()),
          aliases: input.state.aliases,
        })
        if (objectMatch.matchResult === 'AMBIGUOUS') return objectMatch
        if (!planObjects.has(objectMatch.allocationKey) && planObjects.size >= MAP_PROJECTION_PLAN_OBJECT_MAX) {
          completeness = 'partial'
          return objectMatch
        }
        planObjects.set(objectMatch.allocationKey, {
          allocationKey: objectMatch.allocationKey,
          pageAllocationKey,
          regionKey: objectMatch.regionKey,
          stableToken: objectMatch.stableToken,
          reasons: objectMatch.reasons,
          matchResult: objectMatch.matchResult,
        })
        const implementationKey = mapImplementationKey(observed.conditionSnapshot)
        const implKey = `${objectMatch.allocationKey}:${implementationKey}`
        implementations.set(implKey, {
          objectAllocationKey: objectMatch.allocationKey,
          implementationKey,
          condition: observed.conditionSnapshot,
        })
        descriptors.set(implKey, {
          objectAllocationKey: objectMatch.allocationKey,
          implementationKey,
          features: featuresFromObservation(observed),
          condition: observed.conditionSnapshot,
        })
        const already = assigned.has(sampleKey)
        upsertAsset(
          {
            pageAllocationKey,
            objectAllocationKey: objectMatch.allocationKey,
            implementationKey,
          },
          (asset) => {
            if (!already) asset.sampleCount += 1
            assigned.add(sampleKey)
            const condition = evaluateCondition(observed.conditionSnapshot, observed.conditionSnapshot)
            if (condition === 'unknown') asset.rejectReasons = unique(asset.rejectReasons.concat('CONDITION_UNKNOWN'))
            if (observed.truncated || observed.missingReasons.includes('TRUNCATED')) {
              asset.rejectReasons = unique(asset.rejectReasons.concat('coverage-unknown'))
            }
          },
        )
        return objectMatch
      }
      const objectMatch = rememberObject(fact.observation, fact.observation.id)
      assignments.push({
        observationId: fact.observation.id,
        pageAllocationKey,
        objectAllocationKey: objectMatch.matchResult === 'AMBIGUOUS' ? undefined : objectMatch.allocationKey,
        matchResult: objectMatch.matchResult,
        reasons: objectMatch.reasons,
      })
      if (objectMatch.matchResult === 'AMBIGUOUS') continue
      for (const item of inventoryItemsFromObservation(fact.observation)) {
        const derived = observationFromInventory(fact.observation, item)
        if (objectAllocationFromObservation(derived, pageAllocationKey) === objectMatch.allocationKey) continue
        rememberObject(derived, `${fact.observation.id}:${item.role}:${item.name}`)
      }
      continue
    }
    applyVerification(fact.verification, observations, input.state, upsertAsset, conflicts)
  }

  return mapProjectionPlanSchema.parse({
    protocol: MAP_ASSETS_PROTOCOL,
    algorithmVersion: MAP_IDENTITY_RULE_VERSION,
    pages: [...planPages.values()],
    objects: [...planObjects.values()],
    assignments,
    implementations: [...implementations.values()],
    descriptors: [...descriptors.values()],
    assets: [...assets.values()],
    conflicts,
    nextCursor,
    rebuildCompleteness: completeness,
  })
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function applyVerification(
  verification: MapVerification,
  observations: Map<string, MapObservation>,
  state: MapProjectionState,
  upsertAsset: (
    keys: { pageAllocationKey?: string; objectAllocationKey?: string; implementationKey?: string },
    mutate: (asset: MapAssetPlan) => void,
  ) => void,
  conflicts: MapProjectionPlan['conflicts'],
) {
  // A fallback is chosen from this same Attempt.  Its own result is auditable
  // feedback, but cannot be recycled as independent evidence that makes the
  // chosen descriptor more eligible for future consumption.
  if (verification.verificationSource.kind === 'rule' && verification.verificationSource.ruleRef === 'map-consumption-feedback') {
    return
  }
  const related = verification.observationIds
    .map((id) => observations.get(id) ?? stateObservation(state, id))
    .filter((item): item is MapObservation => Boolean(item))
  const attribution = attributeVerification({ verification, observations: related })
  const observation = related[0]
  if (!observation) return
  const pageMatch = matchPageIdentity({ observation, pages: state.pages })
  const objectMatch = matchObjectIdentity({
    observation,
    pageAllocationKey: pageMatch.allocation.allocationKey,
    objects: state.objects,
    aliases: state.aliases,
  })
  const implementationKey = mapImplementationKey(observation.conditionSnapshot)
  upsertAsset(
    {
      pageAllocationKey: pageMatch.allocation.allocationKey,
      objectAllocationKey: objectMatch.allocationKey,
      implementationKey,
    },
    (asset) => {
      const current = asset.dimensions.find((item) => item.dimension === attribution.dimension)
      const next = applyDimension(current, attribution)
      asset.dimensions = [
        ...asset.dimensions.filter((item) => item.dimension !== attribution.dimension),
        { ...next, lastVerifiedAt: verification.evaluatedAt },
      ]
      if (attribution.allowSuccessCount) asset.lastVerifiedAt = verification.evaluatedAt
      asset.importance = Math.max(asset.importance + attribution.importanceDelta, asset.importance)
      if (attribution.verdict === 'rejected' && attribution.dimension === 'business') {
        conflicts.push({
          conflictKey: `conflict:v1:${objectMatch.allocationKey}:${implementationKey}:business`.slice(0, 192),
          payload: { verificationId: verification.id, reasons: attribution.reasons },
        })
      }
    },
  )
}

function stateObservation(_state: MapProjectionState, _observationId: string): MapObservation | undefined {
  return undefined
}

export function emptyProjectionPlan(cursor: number): MapProjectionPlan {
  return mapProjectionPlanSchema.parse({
    protocol: MAP_ASSETS_PROTOCOL,
    algorithmVersion: MAP_IDENTITY_RULE_VERSION,
    pages: [],
    objects: [],
    assignments: [],
    implementations: [],
    descriptors: [],
    assets: [],
    conflicts: [],
    nextCursor: cursor,
  })
}
