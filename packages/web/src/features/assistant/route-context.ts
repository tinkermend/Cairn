import {
  MENU_CATALOG,
  type AssistantPageContextV2,
  type AssistantPageKind,
} from '@cairn/shared'

export interface AssistantRouteContext {
  page: AssistantPageKind
  title: string
  description?: string
  statusLabel: string
  summaryText: string
  statusTone: 'neutral'
}

type RouteRule = {
  route: string
  page: AssistantPageKind
  title?: string
  description?: string
}

// 映射已有页面枚举：run、scenario、studio、target、session、schedule、dataset、platform-config、home、other
const ROUTE_PAGE_MAP: Record<string, AssistantPageKind> = {
  '/': 'home',
  '/scenarios': 'scenario',
  '/runs': 'run',
  '/targets': 'target',
  '/sessions': 'session',
  '/schedules': 'schedule',
  '/datasets': 'dataset',
  '/platform-config': 'platform-config',
}

// 未在 MENU_CATALOG 中收录的已登录合法路由兜底
const ADDITIONAL_ROUTES: RouteRule[] = [
  {
    route: '/suite-runs',
    page: 'other',
    title: '集合运行',
    description: '场景集合执行记录与批量结果。',
  },
  {
    route: '/reports',
    page: 'other',
    title: '测试报告',
    description: '导出的执行汇总与质量报告。',
  },
  {
    route: '/credentials',
    page: 'target',
    title: '目标系统',
    description: '仿真目标系统管理、目标账号与环境配置。',
  },
]

export function resolveRouteContext(pathname: string): AssistantRouteContext {
  const normalized = pathname.replace(/\/+$/, '') || '/'

  // 1. 优先匹配精确根路径
  if (normalized === '/') {
    const homeMenu = MENU_CATALOG.find((m) => m.route === '/')
    return {
      page: 'home',
      title: homeMenu?.title ?? '总览',
      description: homeMenu?.description,
      statusLabel: homeMenu?.title ?? '总览',
      summaryText: homeMenu?.description ?? '平台总体运行状态概览。',
      statusTone: 'neutral',
    }
  }

  // 2. 构造所有候选路由规则并按路径段最长前缀匹配
  const allRules: RouteRule[] = [
    ...ADDITIONAL_ROUTES,
    ...MENU_CATALOG.filter((m) => m.route !== '/').map((m) => ({
      route: m.route,
      page: ROUTE_PAGE_MAP[m.route] ?? 'other',
      title: m.title,
      description: m.description,
    })),
  ]

  // 按 route 长度降序排序，实现最长前缀优先
  allRules.sort((a, b) => b.route.length - a.route.length)

  for (const rule of allRules) {
    if (normalized === rule.route || normalized.startsWith(`${rule.route}/`)) {
      const title = rule.title ?? '工作区'
      const description = rule.description ?? '可在任意页面呼出，支持平台功能问答与操作指引。'
      return {
        page: rule.page,
        title,
        description: rule.description,
        statusLabel: title,
        summaryText: description,
        statusTone: 'neutral',
      }
    }
  }

  // 兜底回退
  return {
    page: 'other',
    title: '识途平台',
    description: '可在任意页面呼出，支持平台功能问答与操作指引。',
    statusLabel: '识途助手',
    summaryText: '可在任意页面呼出，支持平台功能问答与操作指引。',
    statusTone: 'neutral',
  }
}

export function toPageContext(
  context: {
    page: AssistantPageKind
    filters?: Record<string, string | number | boolean>
    entityId?: string
    runId?: string
    scenarioId?: string
    targetId?: string
    targetAccountId?: string
    sessionId?: string
    selectedStepId?: string
    draftRevision?: number
    versionId?: string
    isDirty?: boolean
  } | null,
): AssistantPageContextV2 | null {
  if (!context) return null

  const runId = context.runId ?? (context.page === 'run' ? context.entityId : undefined)
  const scenarioId = context.scenarioId ?? (context.page === 'studio' ? context.entityId : undefined)
  const targetId = context.targetId ?? (context.page === 'target' ? context.entityId : undefined)
  const sessionId = context.sessionId ?? (context.page === 'session' ? context.entityId : undefined)
  const targetAccountId = context.targetAccountId
  const draftRevision =
    typeof context.draftRevision === 'number' && context.draftRevision >= 1
      ? context.draftRevision
      : undefined

  let primaryRef:
    | { kind: 'run' | 'scenario' | 'target' | 'session' | 'schedule' | 'dataset' | 'account'; id: string }
    | undefined
  if (context.page === 'run' && runId) {
    primaryRef = { kind: 'run', id: runId }
  } else if ((context.page === 'studio' || context.page === 'scenario') && scenarioId) {
    primaryRef = { kind: 'scenario', id: scenarioId }
  } else if (context.page === 'target' && targetId) {
    primaryRef = { kind: 'target', id: targetId }
  } else if (context.page === 'session') {
    if (sessionId) {
      primaryRef = { kind: 'session', id: sessionId }
    } else if (targetAccountId) {
      primaryRef = { kind: 'account', id: targetAccountId }
    }
  } else if (context.page === 'schedule' && context.entityId) {
    primaryRef = { kind: 'schedule', id: context.entityId }
  } else if (context.page === 'dataset' && context.entityId) {
    primaryRef = { kind: 'dataset', id: context.entityId }
  }

  const scopeRefs: Array<{ kind: 'target' | 'account'; id: string }> = []
  if (context.page === 'session') {
    if (targetId) {
      scopeRefs.push({ kind: 'target', id: targetId })
    }
    if (targetAccountId) {
      scopeRefs.push({ kind: 'account', id: targetAccountId })
    }
  }

  const selectedRef = context.selectedStepId
    ? { kind: 'step' as const, id: context.selectedStepId }
    : sessionId && context.page === 'session'
      ? { kind: 'session' as const, id: sessionId }
      : undefined

  const view =
    selectedRef || context.filters
      ? {
          ...(selectedRef ? { selectedRef } : {}),
          ...(context.filters ? { filters: context.filters } : {}),
        }
      : undefined

  return {
    version: 2,
    routeKey: context.page,
    pageKind: context.page,
    page: context.page,
    ...(primaryRef ? { primaryRef } : {}),
    ...(scopeRefs.length > 0 ? { scopeRefs } : {}),
    ...(runId ? { runId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(context.selectedStepId ? { stepId: context.selectedStepId } : {}),
    ...(draftRevision ? { draftRevision } : {}),
    ...(context.versionId ? { versionId: context.versionId } : {}),
    ...(context.isDirty !== undefined || draftRevision !== undefined
      ? {
          draft: {
            isDirty: Boolean(context.isDirty),
            savedRevision: draftRevision,
          },
        }
      : {}),
    ...(view ? { view } : {}),
  }
}
