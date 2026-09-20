import {
  MAP_QUERY_PAGE_CANDIDATE_MAX,
  mapQueryResultSchema,
  overlayMapFreshness,
  type MapMatchResult,
  type MapQueryRequest,
  type MapQueryResult,
  type MapQueryView,
} from '@cairn/shared'
import { classifyRoute } from './identity.js'
import { evaluateCondition } from './conditions.js'

export function queryMap(view: MapQueryView, request: MapQueryRequest): MapQueryResult {
  if (view.targetId !== request.targetId) {
    return mapQueryResultSchema.parse({
      matchResult: 'MISS',
      candidates: [],
      usedRefs: [],
      viewRef: view.viewRef,
    })
  }
  const asOf = request.asOf ?? new Date().toISOString()
  let pool = view.assets
  if (request.assetRef) {
    pool = pool.filter((asset) => {
      const ref = request.assetRef!
      if (ref.pageId && asset.assetRef.pageId !== ref.pageId) return false
      if (ref.objectId && asset.assetRef.objectId !== ref.objectId) return false
      if (ref.implementationKey && asset.assetRef.implementationKey !== ref.implementationKey) return false
      if (ref.descriptorVersion && asset.assetRef.descriptorVersion !== ref.descriptorVersion) return false
      return true
    })
  }
  if (request.clues?.url) {
    const classified = classifyRoute({ url: request.clues.url })
    pool = pool.filter((asset) => !asset.routeTemplate || asset.routeTemplate === classified.routeTemplate)
  }
  if (request.clues?.region) {
    pool = pool.filter((asset) => !asset.features?.regionKey || asset.features.regionKey === request.clues?.region)
  }
  if (request.clues?.role) {
    pool = pool.filter((asset) => asset.features?.role === request.clues?.role)
  }
  if (request.clues?.name) {
    pool = pool.filter((asset) => asset.features?.semanticName === request.clues?.name)
  }
  if (view.candidateOverflow || pool.length > MAP_QUERY_PAGE_CANDIDATE_MAX) {
    return mapQueryResultSchema.parse({
      matchResult: 'AMBIGUOUS',
      candidates: [],
      usedRefs: [],
      viewRef: view.viewRef,
    })
  }

  const ranked = pool.map((asset) => {
    const condition = request.condition
      ? asset.condition
        ? evaluateCondition(asset.condition, request.condition)
        : 'unknown'
      : 'satisfied'
    const fresh = overlayMapFreshness({
      lifecycle: asset.lifecycle,
      lastVerifiedAt: asset.lastVerifiedAt,
      asOf,
    })
    let matchResult: MapMatchResult = 'MATCH'
    const reasons: string[] = []
    if (condition === 'unknown') {
      matchResult = 'CONDITION_UNKNOWN'
      reasons.push('required-field-unknown')
    } else if (condition === 'unsatisfied') {
      matchResult = 'MISS'
      reasons.push('condition-unsatisfied')
    }
    if (fresh.lifecycle === 'STALE' && matchResult === 'MATCH') {
      matchResult = 'STALE'
      reasons.push('freshness-expired')
    }
    if (asset.evidenceAvailability === 'unavailable' && matchResult === 'MATCH') {
      matchResult = 'EVIDENCE_UNAVAILABLE'
      reasons.push('evidence-unavailable')
    }
    if (asset.lifecycle === 'RETIRED') {
      matchResult = 'MISS'
      reasons.push('retired')
    }
    return {
      asset,
      condition,
      fresh,
      matchResult,
      reasons,
    }
  })

  const usable = ranked.filter((item) => item.matchResult !== 'MISS')
  const limited = usable.slice(0, request.limit)
  let matchResult: MapMatchResult = 'MISS'
  if (limited.length === 1) matchResult = limited[0]!.matchResult
  else if (limited.length > 1) {
    const uniqueObjects = new Set(limited.map((item) => item.asset.assetRef.objectId ?? item.asset.assetRefKey))
    matchResult = uniqueObjects.size === 1 ? limited[0]!.matchResult : 'AMBIGUOUS'
  }

  return mapQueryResultSchema.parse({
    matchResult,
    candidates: limited.map((item) => ({
      assetRef: item.asset.assetRef,
      viewRef: view.viewRef,
      matchResult: item.matchResult,
      reasons: item.reasons.length ? item.reasons : ['matched'],
      condition: item.condition,
      lifecycle: item.fresh.lifecycle,
      freshUntil: item.fresh.freshUntil,
      executable: item.asset.executable && item.matchResult === 'MATCH',
      rejectReasons: item.asset.rejectReasons,
      dimensions: item.asset.dimensions,
      evidenceAvailability: item.asset.evidenceAvailability,
    })),
    usedRefs: limited.map((item) => item.asset.assetRef),
    viewRef: view.viewRef,
  })
}
