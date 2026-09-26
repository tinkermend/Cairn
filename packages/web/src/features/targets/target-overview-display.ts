import type { TargetOverviewItem, TargetOverviewReadinessState, TargetOverviewResponse } from '@cairn/shared'

export type { TargetOverviewItem }
export type OverviewFilter = 'all' | 'ready' | 'need_login' | 'running'
export type OverviewSortColumn = 'system' | 'readiness' | 'accounts' | 'scenarios' | 'activity'
export type OverviewSort = 'created' | `${OverviewSortColumn}-${'asc' | 'desc'}`

export const overviewSortDefaultDirection: Record<OverviewSortColumn, 'asc' | 'desc'> = {
  system: 'asc', readiness: 'desc', accounts: 'desc', scenarios: 'desc', activity: 'desc',
}

const readinessPriority: Record<TargetOverviewReadinessState, number> = {
  disabled: 0,
  ready: 10,
  busy: 20,
  unprepared: 30,
  no_business_account: 40,
  unknown: 50,
  needs_check: 60,
  lost: 70,
  identity_mismatch: 80,
  need_login: 90,
}

function overviewSortValue(item: TargetOverviewItem, column: OverviewSortColumn): string | number | null {
  switch (column) {
    case 'system': return item.target.name
    case 'readiness': return item.readiness.state === 'available' ? readinessPriority[item.readiness.value.state] : null
    case 'accounts': return item.accounts.state === 'available' ? item.accounts.value.readyAccounts : null
    case 'scenarios': return item.scenarios.state === 'available' ? item.scenarios.value.total : null
    case 'activity': return item.activities.state === 'available' ? item.activities.value.items[0]?.occurredAt ?? null : null
  }
}

/** Sort the complete authorized result before page slicing; unavailable values stay last. */
export function sortOverviewItems(items: readonly TargetOverviewItem[], sort: OverviewSort): TargetOverviewItem[] {
  if (sort === 'created') return [...items]
  const [column, direction] = sort.split('-') as [OverviewSortColumn, 'asc' | 'desc']
  const factor = direction === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    const left = overviewSortValue(a, column)
    const right = overviewSortValue(b, column)
    if (left === null && right !== null) return 1
    if (left !== null && right === null) return -1
    const compared = typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right, 'zh-CN', { numeric: true })
      : typeof left === 'number' && typeof right === 'number' ? left - right : 0
    return compared * factor || b.target.createdAt.localeCompare(a.target.createdAt) || b.target.id.localeCompare(a.target.id)
  })
}

const readinessLabels = {
  disabled: '已停用',
  no_business_account: '需要准备账号',
  ready: '有空闲登录会话',
  need_login: '需要登录',
  identity_mismatch: '账号身份不符',
  lost: '会话已失联',
  needs_check: '检查登录状态',
  busy: '账号使用中',
  unprepared: '会话待准备',
  unknown: '状态待确认',
} as const

export function readinessLabel(item: TargetOverviewItem): string {
  return item.readiness.state === 'available'
    ? readinessLabels[item.readiness.value.state]
    : '无权限查看'
}

export function readinessTone(item: TargetOverviewItem): 'success' | 'warning' | 'info' | 'neutral' {
  if (item.readiness.state === 'forbidden') return 'neutral'
  switch (item.readiness.value.state) {
    case 'ready': return 'success'
    case 'need_login':
    case 'identity_mismatch':
    case 'lost': return 'warning'
    case 'needs_check':
    case 'busy': return 'info'
    default: return 'neutral'
  }
}

export function formatOverviewTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed)
}

export function coverageText(
  count: TargetOverviewResponse['summary']['readyTargets'],
  totalTargets: number,
): string {
  if (count.coverage === 'forbidden') return '无权限查看'
  if (count.coverage === 'partial') return `统计 ${count.coveredTargets}/${totalTargets} 个可见系统`
  return '覆盖当前可见系统'
}
