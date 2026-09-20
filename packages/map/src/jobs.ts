import {
  FACTORY_EXPLORATION_POLICY,
  FACTORY_MAP_JOB_POLICY,
  expandArrivalTarget,
  type ExplorationPolicy,
  type MapAssetListItem,
  type MapAssetRef,
  type MapJobKind,
  type MapJobPolicy,
  type MapJobPreviewItem,
  type MapSafeEntry,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import { seedUrlsForExploration } from './exploration.js'

const UNSAFE_NAME = /(提交|保存|删除|审批|支付|发布|上传|下载|导出|submit|save|delete|approve|pay|publish|upload|download|export)/i

export type MapJobCompileAsset = {
  assetRef: MapAssetRef
  name: string
  routeTemplate?: string
  descriptor?: TargetDescriptor
  importance: number
  failed: boolean
  stale: boolean
}

export function isUnsafeMapActionName(name: string): boolean {
  return UNSAFE_NAME.test(name)
}

export function toMapJobCompileAssets(
  items: readonly Pick<MapAssetListItem, 'assetRef' | 'name' | 'routeTemplate' | 'lifecycle'>[],
): MapJobCompileAsset[] {
  return items.map((item) => ({
    assetRef: item.assetRef,
    name: item.name ?? '未命名对象',
    routeTemplate: item.routeTemplate,
    importance: item.lifecycle === 'TRUSTED' || item.lifecycle === 'VERIFIED' ? 2 : 1,
    failed: item.lifecycle === 'DEGRADED',
    stale: item.lifecycle === 'STALE',
  }))
}

export function selectMapJobAssets(
  jobKind: MapJobKind,
  policy: MapJobPolicy,
  assets: readonly MapJobCompileAsset[],
  selected: readonly MapAssetRef[],
): MapJobPreviewItem[] {
  const selectedKeys = new Set(selected.map((item) => `${item.objectId ?? item.pageId ?? ''}`))
  const maxPages =
    jobKind === 'map_probe' ? policy.maxProbePages : jobKind === 'map_explore' ? 1 : policy.maxRefreshPages
  const maxObjects =
    jobKind === 'map_probe' ? policy.maxProbeObjects : jobKind === 'map_explore' ? 8 : policy.maxRefreshObjects
  const ranked = [...assets].sort((left, right) => {
    const rank = (item: MapJobCompileAsset) => (item.failed ? 0 : item.stale ? 1 : selectedKeys.has(item.assetRef.objectId ?? '') ? 2 : 3)
    const byRank = rank(left) - rank(right)
    if (byRank !== 0) return byRank
    if (right.importance !== left.importance) return right.importance - left.importance
    return (left.assetRef.objectId ?? left.assetRef.pageId ?? '').localeCompare(
      right.assetRef.objectId ?? right.assetRef.pageId ?? '',
    )
  })
  const pages = new Set<string>()
  const items: MapJobPreviewItem[] = []
  let objects = 0
  for (const asset of ranked) {
    const pageId = asset.assetRef.pageId ?? asset.routeTemplate ?? 'page'
    const overQuota = pages.size >= maxPages && !pages.has(pageId) || objects >= maxObjects
    if (overQuota) {
      items.push({ assetRef: asset.assetRef, name: asset.name, included: false, reason: '超出本轮配额' })
      continue
    }
    if (isUnsafeMapActionName(asset.name)) {
      items.push({ assetRef: asset.assetRef, name: asset.name, included: false, reason: '名称像写入动作，未纳入' })
      continue
    }
    pages.add(pageId)
    objects += 1
    items.push({
      assetRef: asset.assetRef,
      name: asset.name,
      included: true,
      reason: asset.failed ? '失败或未决关键资产' : asset.stale ? '到期资产' : '用户选择或配额内资产',
    })
  }
  return items
}

export function compileMapJobSlice(input: {
  jobKind: MapJobKind
  entry: MapSafeEntry
  included: readonly MapJobCompileAsset[]
  policy?: MapJobPolicy
  exploration?: ExplorationPolicy
  seedUrls?: readonly string[]
}): { ok: true; steps: Step[] } | { ok: false; reason: 'compile_rejected' | 'entry_precondition_unknown'; message: string } {
  const policy = input.policy ?? FACTORY_MAP_JOB_POLICY
  if (!input.entry.url || !input.entry.arrivalTarget) {
    return { ok: false, reason: 'entry_precondition_unknown', message: '安全进入缺少到达断言' }
  }
  if (isUnsafeMapActionName(input.entry.name) || isUnsafeMapActionName(input.entry.arrivalName)) {
    return { ok: false, reason: 'compile_rejected', message: '进入路径名称像写入动作' }
  }
  if (input.jobKind === 'map_explore') {
    return compileExploreSlice(input)
  }
  const maxActions = input.jobKind === 'map_probe' ? policy.maxProbeActions : policy.maxRefreshActions
  const steps: Step[] = [
    {
      id: '00000000-0000-4000-8000-000000000101',
      name: `打开 ${input.entry.name}`,
      type: 'navigate',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { url: input.entry.url },
    },
    {
      id: '00000000-0000-4000-8000-000000000102',
      name: `到达 ${input.entry.arrivalName}`,
      type: 'assert',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { target: expandArrivalTarget(input.entry.arrivalTarget, input.entry.arrivalName), expect: { kind: 'visible' } },
    },
  ]
  if (input.jobKind === 'map_refresh') {
    for (const [index, asset] of input.included.slice(0, maxActions).entries()) {
      if (!asset.descriptor) continue
      if (isUnsafeMapActionName(asset.name)) {
        return { ok: false, reason: 'compile_rejected', message: `资产 ${asset.name} 不能编译为只读核验` }
      }
      const suffix = (index + 3).toString().padStart(3, '0')
      steps.push({
        id: `00000000-0000-4000-8000-000000000${suffix}`,
        name: `核验 ${asset.name}`.slice(0, 128),
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: `map_job_${index + 1}`,
        policy: { timeoutMs: 8_000, retryLimit: 0 },
        input: { target: asset.descriptor, as: 'text' },
      })
    }
  }
  if (steps.length > 32) {
    return { ok: false, reason: 'compile_rejected', message: '分片超过 32 步上限' }
  }
  return { ok: true, steps }
}

function compileExploreSlice(input: {
  entry: MapSafeEntry
  exploration?: ExplorationPolicy
  seedUrls?: readonly string[]
}): { ok: true; steps: Step[] } | { ok: false; reason: 'compile_rejected' | 'entry_precondition_unknown'; message: string } {
  const exploration = input.exploration ?? FACTORY_EXPLORATION_POLICY
  if (exploration.modelEnabled) {
    return { ok: false, reason: 'compile_rejected', message: '本轮不开放模型提名' }
  }
  if (exploration.allowlist.length === 0) {
    return { ok: false, reason: 'compile_rejected', message: '没有可配置安全导航范围' }
  }
  const seedUrls = seedUrlsForExploration(input.entry.url, input.seedUrls ?? [])
  const steps: Step[] = [
    {
      id: '00000000-0000-4000-8000-000000000101',
      name: `打开 ${input.entry.name}`,
      type: 'navigate',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { url: input.entry.url },
    },
    {
      id: '00000000-0000-4000-8000-000000000102',
      name: `到达 ${input.entry.arrivalName}`,
      type: 'assert',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { target: expandArrivalTarget(input.entry.arrivalTarget, input.entry.arrivalName), expect: { kind: 'visible' } },
    },
    {
      id: '00000000-0000-4000-8000-000000000103',
      name: '观察当前表面',
      type: 'map_observe',
      effectType: 'READ_ONLY',
      outputKey: 'explore_observation',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { mode: exploration.mode, allowlist: exploration.allowlist, seedUrls },
    },
    {
      id: '00000000-0000-4000-8000-000000000104',
      name: '提名下一跳',
      type: 'map_propose',
      effectType: 'READ_ONLY',
      outputKey: 'explore_proposal',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { from: 'explore_observation' },
    },
    {
      id: '00000000-0000-4000-8000-000000000105',
      name: '守卫后动作',
      type: 'map_guarded_action',
      effectType: 'READ_ONLY',
      outputKey: 'explore_action',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { from: 'explore_proposal' },
    },
    {
      id: '00000000-0000-4000-8000-000000000106',
      name: '核验探索结果',
      type: 'map_verify',
      effectType: 'READ_ONLY',
      outputKey: 'explore_verification',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { from: 'explore_action', observationFrom: 'explore_observation' },
    },
  ]
  return { ok: true, steps }
}
