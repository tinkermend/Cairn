import {
  type AssistantDiscoveryCandidate,
  type AssistantDiscoveryResult,
  extractScenarioSearchKeyword,
} from '@cairn/shared'
import { listScenarios } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

export async function handleScenarioDiscover(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantDiscoveryResult> {
  const { actor, slots, db, targets, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索授权范围内的场景...')

  const targetId = typeof slots.targetId === 'string' && slots.targetId ? slots.targetId : undefined
  const rawSearch = typeof slots.filter === 'string' && slots.filter ? slots.filter : (typeof slots.search === 'string' ? slots.search : undefined)
  const extracted = rawSearch ? extractScenarioSearchKeyword(rawSearch) : undefined
  const search = extracted ?? (rawSearch && rawSearch.length < 50 && !/^(现在都有哪些场景|有哪些场景|所有场景|列出场景|看下场景|查看场景)$/.test(rawSearch) ? rawSearch : undefined)
  const status =
    typeof slots.status === 'string' && (slots.status === 'active' || slots.status === 'disabled')
      ? (slots.status as 'active' | 'disabled')
      : undefined
  const cursor = typeof slots.cursor === 'string' ? slots.cursor : undefined
  const limit = typeof slots.limit === 'number' && slots.limit > 0 && slots.limit <= 50 ? slots.limit : 20

  const queryResult = await listScenarios(
    db,
    {
      targetId,
      search,
      status,
      cursor,
      limit,
      purpose: (slots.purpose as any) ?? undefined,
    },
    actor.id,
  )

  const uniqueTargetIds = [...new Set(queryResult.items.map((s) => s.targetId))]
  const targetMap = new Map<string, string>()
  await Promise.all(
    uniqueTargetIds.map(async (tid) => {
      try {
        const t = await targets.getTarget(tid)
        targetMap.set(tid, t.name)
      } catch {
        targetMap.set(tid, tid.slice(0, 8))
      }
    }),
  )

  const candidates: AssistantDiscoveryCandidate[] = queryResult.items.map((s) => ({
    id: s.id,
    name: s.purpose && s.purpose !== 'user' ? `[模块] ${s.name}` : s.name,
    targetId: s.targetId,
    targetName: targetMap.get(s.targetId) ?? s.targetId.slice(0, 8),
    kind: 'scenario',
    versionOrRevision: s.latestVersionNo ?? undefined,
    status: s.status,
    updatedAt: s.updatedAt,
  }))

  const message =
    candidates.length === 0
      ? '在当前权限范围内未找到匹配的场景。'
      : `已检索到 ${candidates.length} 个可用场景候选${queryResult.nextCursor ? '（还有更多）' : ''}：`

  return {
    kind: 'discovery',
    candidates,
    scope: {
      targetId,
      targetName: targetId ? targetMap.get(targetId) : undefined,
      entityType: 'scenario',
      filter: search,
    },
    coverage: {
      totalVisible: candidates.length,
      hasMore: Boolean(queryResult.nextCursor),
      nextCursor: queryResult.nextCursor ?? undefined,
      observedAt: new Date().toISOString(),
    },
    message,
  }
}
