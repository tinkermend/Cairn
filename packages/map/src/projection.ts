import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  MAP_PROJECTION_BATCH_BUDGET_MS,
  mapImplementationKey,
  mapProjectionPlanSchema,
  type MapAssetPlan,
  type MapDescriptorFeatures,
  type MapDimensionStat,
  type MapObservation,
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
    const clues = cluesFromObservation(fact.observation)
    const stable = stableObjectToken({
      testId: clues.testId,
      role: clues.role,
      name: clues.name,
      sourceEventKey: fact.observation.sourceEventKey,
    })
    objectAllocationKeys.add(
      objectAllocationKey({
        pageAllocationKey: page.allocationKey,
        regionKey: clues.regionKey,
        stableToken: stable.token,
      }),
    )
  }
  return {
    pageAllocationKeys: [...pageAllocationKeys],
    objectAllocationKeys: [...objectAllocationKeys],
    observationIds: [...observationIds],
  }
}

function featuresFromObservation(observation: MapObservation): MapDescriptorFeatures {
  const clues = cluesFromObservation(observation)
  return {
    semanticName: clues.name,
    role: clues.role,
    testId: clues.testId,
    regionKey: clues.regionKey,
    rowPattern: observation.actionRef?.instanceBinding
      ? { template: 'instance', bindingKey: observation.actionRef.instanceBinding.key }
      : undefined,
  }
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
        pages: [...pages.values(), ...[...planPages.values()].map((item) => ({
          id: item.allocationKey,
          allocationKey: item.allocationKey,
          kind: item.kind,
          routeTemplate: item.routeTemplate,
        }))],
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
      const objectMatch = matchObjectIdentity({
        observation: fact.observation,
        pageAllocationKey: pageMatch.allocation.allocationKey,
        objects: [...objects.values(), ...[...planObjects.values()].map((item) => ({
          id: item.allocationKey,
          allocationKey: item.allocationKey,
          pageId: item.pageAllocationKey,
          pageAllocationKey: item.pageAllocationKey,
          regionKey: item.regionKey,
          stableToken: item.stableToken,
        }))],
        aliases: input.state.aliases,
      })
      planObjects.set(objectMatch.allocationKey, {
        allocationKey: objectMatch.allocationKey,
        pageAllocationKey: pageMatch.allocation.allocationKey,
        regionKey: objectMatch.regionKey,
        stableToken: objectMatch.stableToken,
        reasons: objectMatch.reasons,
        matchResult: objectMatch.matchResult,
      })
      assignments.push({
        observationId: fact.observation.id,
        pageAllocationKey: pageMatch.allocation.allocationKey,
        objectAllocationKey: objectMatch.matchResult === 'AMBIGUOUS' ? undefined : objectMatch.allocationKey,
        matchResult: objectMatch.matchResult,
        reasons: objectMatch.reasons,
      })
      if (objectMatch.matchResult === 'AMBIGUOUS') continue
      const implementationKey = mapImplementationKey(fact.observation.conditionSnapshot)
      const implKey = `${objectMatch.allocationKey}:${implementationKey}`
      implementations.set(implKey, {
        objectAllocationKey: objectMatch.allocationKey,
        implementationKey,
        condition: fact.observation.conditionSnapshot,
      })
      const features = featuresFromObservation(fact.observation)
      descriptors.set(implKey, {
        objectAllocationKey: objectMatch.allocationKey,
        implementationKey,
        features,
        condition: fact.observation.conditionSnapshot,
      })
      const already = assigned.has(fact.observation.id)
      upsertAsset(
        {
          pageAllocationKey: pageMatch.allocation.allocationKey,
          objectAllocationKey: objectMatch.allocationKey,
          implementationKey,
        },
        (asset) => {
          if (!already) asset.sampleCount += 1
          assigned.add(fact.observation.id)
          const condition = evaluateCondition(fact.observation.conditionSnapshot, fact.observation.conditionSnapshot)
          if (condition === 'unknown') asset.rejectReasons = unique(asset.rejectReasons.concat('CONDITION_UNKNOWN'))
          if (fact.observation.truncated || fact.observation.missingReasons.includes('TRUNCATED')) {
            asset.rejectReasons = unique(asset.rejectReasons.concat('coverage-unknown'))
          }
        },
      )
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
