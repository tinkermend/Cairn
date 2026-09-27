import {
  type AssistantDiscoveryCandidate,
  type AssistantDiscoveryResult,
  cleanAssistantQuestion,
  extractScenarioSearchKeyword,
  normalizeAssistantPageContext,
} from '@cairn/shared'
import { listScenarios } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

function namedTargetInQuestion(question: string): string | undefined {
  const cleaned = cleanAssistantQuestion(question)
  const match = /(?:关于|有关|列出|查看|查询|查找|找出|搜索|找|查)\s*([^，。？?！!]{2,100}?)\s*的(?:所有|全部|现有|可用)?场景/.exec(cleaned)
  return match?.[1]?.trim() || undefined
}

function isPlainSearchTerm(value: string): boolean {
  return value.length <= 40 && !/(?:有哪些|列出|查看|查找|搜索|场景|工作流|关于|有关|方便|帮我|请问|目标系统)/.test(value)
}

export async function handleScenarioDiscover(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantDiscoveryResult> {
  const { actor, slots, db, targets, onProgress, question, body } = ctx
  await onProgress?.('loading_facts', '正在检索授权范围内的场景...')

  const currentTargetId = normalizeAssistantPageContext(body.pageContext)?.targetId
  let targetId = currentTargetId ?? (typeof slots.targetId === 'string' && slots.targetId ? slots.targetId : undefined)
  let targetName: string | undefined
  const namedTarget = namedTargetInQuestion(question)
  if (namedTarget && !/^(?:这个|当前|本|该)(?:目标|系统|平台)$/.test(namedTarget)) {
    // Resolve the name through the actor-scoped target list. A target name is
    // never a scenario.name filter, and an inaccessible target must stay hidden.
    const matches: { id: string; name: string }[] = []
    let nextCursor: string | undefined
    do {
      const page = await targets.listTargets({ search: namedTarget, cursor: nextCursor, limit: 100 }, actor)
      matches.push(...page.items.filter((item) => item.name.toLocaleLowerCase() === namedTarget.toLocaleLowerCase()))
      nextCursor = page.nextCursor ?? undefined
    } while (nextCursor && matches.length < 2)

    if (matches.length === 1) {
      targetId = matches[0]!.id
      targetName = matches[0]!.name
    } else if (matches.length > 1 || /(?:平台|系统|站点|应用|网站|后台)$/.test(namedTarget)) {
      delete slots.targetId
      delete slots.filter
      delete slots.search
      return {
        kind: 'discovery',
        candidates: [],
        scope: { entityType: 'scenario' },
        coverage: { totalVisible: 0, hasMore: false, observedAt: new Date().toISOString() },
        message: matches.length > 1
          ? '当前权限范围内有多个同名目标，请在目标详情页重试。'
          : '在当前权限范围内未找到匹配的目标或场景。',
      }
    }
  }

  const rawSearch = typeof slots.filter === 'string' && slots.filter ? slots.filter.trim() : (typeof slots.search === 'string' ? slots.search.trim() : undefined)
  const extracted = extractScenarioSearchKeyword(question)
  const search = targetName ? undefined : (extracted ?? (rawSearch && isPlainSearchTerm(rawSearch) ? rawSearch : undefined))
  // Keep persisted slots aligned with the actual query so “下一页” preserves
  // target scope and never restores a model-supplied sentence fragment.
  if (targetId) slots.targetId = targetId
  else delete slots.targetId
  if (search) slots.filter = search
  else delete slots.filter
  delete slots.search
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
      targetName: targetName ?? (targetId ? targetMap.get(targetId) : undefined),
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
