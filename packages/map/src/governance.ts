import {
  canonicalJson,
  mapAssetRefKey,
  type MapAssetDetail,
  type MapConditionSnapshot,
  type MapIdentityAlias,
  type MapIdentityAction,
  type MapImpactSource,
  type MapReferenceItem,
  type MapLifecycle,
  type MapOverlayLifecycle,
  type MapReferenceResolution,
  type MapVerificationDimension,
  type MapVerificationVerdict,
} from '@cairn/shared'
import { evaluateCondition } from './conditions.js'
import { classifyRoute } from './identity.js'

export function applyGovernanceOverlay(
  lifecycle: MapLifecycle,
  overlay?: MapOverlayLifecycle,
): MapLifecycle {
  return overlay ?? lifecycle
}

export function mapListQueryKey(input: {
  targetId: string
  kind: 'pages' | 'objects' | 'changes' | 'references' | 'impacts'
  projectionId?: string
  releaseId?: string
  search?: string
  lifecycle?: string
  conditionSnapshot?: unknown
  assetRefKey?: string
}): unknown {
  return {
    targetId: input.targetId,
    kind: input.kind,
    projectionId: input.projectionId ?? null,
    releaseId: input.releaseId ?? null,
    search: input.search ?? null,
    lifecycle: input.lifecycle ?? null,
    conditionSnapshot: input.conditionSnapshot ?? null,
    assetRefKey: input.assetRefKey ?? null,
  }
}

export function mapCursorPayload(digest: string, sortKey: string): { d: string; k: string } {
  return { d: digest, k: sortKey }
}

export function parseMapCursorPayload(value: unknown): { digest: string; sortKey: string } {
  const parsed = value && typeof value === 'object' ? (value as { d?: unknown; k?: unknown }) : {}
  if (typeof parsed.d !== 'string' || typeof parsed.k !== 'string' || !parsed.d || !parsed.k) {
    throw new Error('MAP_CURSOR_EXPIRED')
  }
  return { digest: parsed.d, sortKey: parsed.k }
}

export type ScenarioStepClue = {
  stepId: string
  name?: string
  url?: string
  role?: string
  locatorName?: string
}

export type MapScanAsset = {
  assetRefKey: string
  pageId?: string
  objectId?: string
  routeTemplate?: string
  semanticName?: string
  role?: string
}

export type MapReferenceCandidate = {
  stepId: string
  assetRefKey: string
  pageId?: string
  objectId?: string
  reasons: string[]
}

export function proposeMapReferenceCandidates(input: {
  steps: readonly ScenarioStepClue[]
  assets: readonly MapScanAsset[]
}): MapReferenceCandidate[] {
  const byRoute = new Map<string, MapScanAsset[]>()
  const byName = new Map<string, MapScanAsset[]>()
  const byRole = new Map<string, MapScanAsset[]>()
  const index = (map: Map<string, MapScanAsset[]>, key: string | undefined, asset: MapScanAsset) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(asset)
    else map.set(key, [asset])
  }
  for (const asset of input.assets) {
    index(byRoute, asset.routeTemplate, asset)
    index(byName, asset.semanticName, asset)
    index(byRole, asset.role, asset)
  }
  const out: MapReferenceCandidate[] = []
  for (const step of input.steps) {
    const route = step.url ? classifyRoute({ url: step.url }).routeTemplate : undefined
    const merged = new Map<string, { asset: MapScanAsset; reasons: string[] }>()
    const touch = (asset: MapScanAsset, reason: string) => {
      const current = merged.get(asset.assetRefKey)
      if (current) {
        if (!current.reasons.includes(reason)) current.reasons.push(reason)
        return
      }
      merged.set(asset.assetRefKey, { asset, reasons: [reason] })
    }
    if (route) for (const asset of byRoute.get(route) ?? []) touch(asset, 'route-template')
    if (step.name) for (const asset of byName.get(step.name) ?? []) touch(asset, 'semantic-name')
    if (step.locatorName) for (const asset of byName.get(step.locatorName) ?? []) touch(asset, 'locator-name')
    if (step.role) for (const asset of byRole.get(step.role) ?? []) touch(asset, 'role')
    for (const { asset, reasons } of merged.values()) {
      out.push({
        stepId: step.stepId,
        assetRefKey: asset.assetRefKey,
        pageId: asset.pageId,
        objectId: asset.objectId,
        reasons,
      })
    }
  }
  return out
}

export function cluesFromScenarioStep(step: {
  id: string
  type: string
  name?: string
  input?: unknown
}): ScenarioStepClue {
  const input = step.input && typeof step.input === 'object' ? (step.input as Record<string, unknown>) : {}
  const url = typeof input.url === 'string' ? input.url : undefined
  const target = input.target && typeof input.target === 'object' ? (input.target as Record<string, unknown>) : undefined
  const candidates = Array.isArray(target?.candidates) ? target.candidates : []
  let role: string | undefined
  let locatorName: string | undefined
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const row = candidate as Record<string, unknown>
    if (row.by === 'role' && typeof row.value === 'string') role = row.value
    if (typeof row.name === 'string') locatorName = row.name
    if (row.by === 'label' && typeof row.value === 'string' && !locatorName) locatorName = row.value
  }
  return {
    stepId: step.id,
    name: step.name,
    url,
    role,
    locatorName,
  }
}

export function gradeMapImpact(input: {
  changedAssetKeys: readonly string[]
  identityAliases?: readonly MapIdentityAlias[]
  bindings: Readonly<MapImpactSource['bindings']>
  candidates: Readonly<Array<Omit<MapImpactSource['candidates'][number], 'reasons'> & { reasons?: string[] }>>
  scannedScenarioIds: readonly string[]
  visibleScenarioIds: readonly string[]
}): {
  items: MapReferenceItem[]
  notes: string[]
} {
  const changed = new Set(input.changedAssetKeys)
  const items: MapReferenceItem[] = []
  const covered = new Set<string>()
  for (const binding of input.bindings) {
    const resolved = binding.assetRef ? resolveBindingAfterIdentity({ binding: binding.assetRef, aliases: input.identityAliases ?? [], action: 'alias' }) : undefined
    const aliasMatch = resolved?.current && input.changedAssetKeys.some(key => resolved.current!.objectId
      ? key.includes(`:o:${resolved.current!.objectId}:`)
      : key.startsWith(`p:${resolved.current!.pageId}:`))
    if (!changed.has(binding.assetRefKey) && !aliasMatch) continue
    covered.add(binding.scenarioId)
    items.push({
      ...binding,
      grade: 'confirmed_reference',
      scenarioId: binding.scenarioId,
      stepId: binding.stepId,
      assetRefKey: binding.assetRefKey,
      resolution: resolved?.resolution === 'pending_confirmation' ? 'pending_confirmation' : binding.resolution,
      reasons: aliasMatch && !changed.has(binding.assetRefKey) ? ['explicit-binding', 'identity-alias'] : ['explicit-binding'],
    })
  }
  for (const candidate of input.candidates) {
    if (!changed.has(candidate.assetRefKey)) continue
    if (covered.has(candidate.scenarioId)) continue
    covered.add(candidate.scenarioId)
    items.push({
      ...candidate,
      grade: 'potential_match',
      scenarioId: candidate.scenarioId,
      stepId: candidate.stepId,
      assetRefKey: candidate.assetRefKey,
      reasons: candidate.reasons?.length ? [...candidate.reasons] : ['scan-candidate'],
    })
  }
  const scanned = new Set(input.scannedScenarioIds)
  for (const scenarioId of input.visibleScenarioIds) {
    if (covered.has(scenarioId)) continue
    if (scanned.has(scenarioId)) continue
    items.push({
      grade: 'unknown_coverage',
      scenarioId,
      reasons: ['not-scanned'],
    })
  }
  return {
    items,
    notes: ['变化只表示需要检查，不能据此认定场景必然失败'],
  }
}

export function resolveBindingAfterIdentity(input: {
  binding: { pageId?: string; objectId?: string }
  aliases: readonly MapIdentityAlias[]
  action: MapIdentityAction
}): { resolution: MapReferenceResolution; current?: { pageId?: string; objectId?: string } } {
  let current = { ...input.binding }
  const visited = new Set<string>()
  for (;;) {
    const key = `${current.pageId ?? ''}:${current.objectId ?? ''}`
    if (visited.has(key)) return { resolution: 'pending_confirmation' }
    visited.add(key)
    const matches = input.aliases.filter(alias => current.objectId ? alias.oldObjectId === current.objectId : alias.oldPageId === current.pageId)
    const revision = Math.max(0, ...matches.map(alias => alias.revision))
    const latest = matches.filter(alias => alias.revision === revision)
    if (!latest.length) return { resolution: 'resolved', current }
    if (latest.some(alias => alias.action === 'split')) return { resolution: 'pending_confirmation' }
    const last = latest.at(-1)!
    const next = { pageId: last.newPageId ?? current.pageId, objectId: last.newObjectId ?? current.objectId }
    if (next.pageId === current.pageId && next.objectId === current.objectId) return { resolution: 'resolved', current }
    current = next
  }
}

export function groupMapDiagnosisClues(
  rows: readonly {
    dimension: MapVerificationDimension
    verdict: MapVerificationVerdict
    note?: string
  }[],
): {
  clues: Array<{
    dimension: MapVerificationDimension
    verdict: MapVerificationVerdict
    count: number
    notes: string[]
  }>
  hypotheses: string[]
  counterExamples: string[]
  gaps: string[]
} {
  const order: MapVerificationDimension[] = ['identity', 'locator', 'action', 'business']
  const grouped = new Map<MapVerificationDimension, { confirmed: number; rejected: number; unknown: number; notes: string[] }>()
  for (const dimension of order) grouped.set(dimension, { confirmed: 0, rejected: 0, unknown: 0, notes: [] })
  for (const row of rows) {
    const bucket = grouped.get(row.dimension)
    if (!bucket) continue
    if (row.verdict === 'confirmed') bucket.confirmed += 1
    else if (row.verdict === 'rejected') bucket.rejected += 1
    else if (row.verdict === 'unknown') bucket.unknown += 1
    if (row.note && bucket.notes.length < 8) bucket.notes.push(row.note)
  }
  const clues = order.map((dimension) => {
    const bucket = grouped.get(dimension)!
    const verdict: MapVerificationVerdict =
      bucket.rejected > 0 ? 'rejected' : bucket.confirmed > 0 ? 'confirmed' : bucket.unknown > 0 ? 'unknown' : 'not_observed'
    return {
      dimension,
      verdict,
      count: bucket.confirmed + bucket.rejected + bucket.unknown,
      notes: bucket.notes,
    }
  })
  const locator = clues.find((item) => item.dimension === 'locator')
  const business = clues.find((item) => item.dimension === 'business')
  const hypotheses: string[] = []
  const counterExamples: string[] = []
  const gaps: string[] = []
  if (business?.verdict === 'rejected' && locator?.verdict === 'confirmed') {
    counterExamples.push('定位成功但业务结果被拒绝，不能据此宣称页面改版或对象失效')
  }
  if (locator?.verdict === 'rejected') hypotheses.push('定位失败，需核对对象身份与实现条件')
  if (clues.every((item) => item.verdict === 'not_observed')) gaps.push('没有足够的分维验证事实')
  return { clues, hypotheses, counterExamples, gaps }
}

export function overlayLifecycleMap(
  overlays: readonly { assetRefKey: string; lifecycle: MapOverlayLifecycle }[],
): Map<string, MapOverlayLifecycle> {
  return new Map(overlays.map((item) => [item.assetRefKey, item.lifecycle]))
}

export function applyDetailApplicability(
  detail: MapAssetDetail,
  observed?: MapConditionSnapshot,
): MapAssetDetail {
  if (!observed) return { ...detail, applicability: 'unknown' }
  let unknown = false
  let satisfied = false
  let unsatisfied = false
  for (const implementation of detail.implementations) {
    if (!implementation.conditionSnapshot) {
      unknown = true
      continue
    }
    const tri = evaluateCondition(implementation.conditionSnapshot, observed)
    if (tri === 'satisfied') satisfied = true
    else if (tri === 'unsatisfied') unsatisfied = true
    else unknown = true
  }
  return {
    ...detail,
    applicability: satisfied ? 'satisfied' : unknown || (!satisfied && !unsatisfied) ? 'unknown' : 'unsatisfied',
  }
}

export { mapAssetRefKey, canonicalJson }
