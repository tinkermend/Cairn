import type { ReactNode } from 'react'
import type { TargetOverviewResponse } from '@cairn/shared'
import { Activity, CheckCircle2, CircleAlert, Layers } from 'lucide-react'
import { CollectionSummary } from '@/components/collection-summary'
import { coverageText, type OverviewFilter } from './target-overview-display'

const cards: { filter: OverviewFilter; label: string; description: string; icon: ReactNode }[] = [
  { filter: 'all', label: '系统总数', description: '当前有权查看的全部系统', icon: <Layers className='size-4' /> },
  { filter: 'ready', label: '空闲已登录', description: '有空闲登录会话，执行时仍会复核', icon: <CheckCircle2 className='size-4' /> },
  { filter: 'need_login', label: '需要登录', description: '含自动续登与人工接管', icon: <CircleAlert className='size-4' /> },
  { filter: 'running', label: '执行中', description: '正在执行用户场景的系统', icon: <Activity className='size-4' /> },
]

export function TargetOverviewSummary({
  data, selected, allSelected, onSelect,
}: {
  data: TargetOverviewResponse
  selected: OverviewFilter
  allSelected: boolean
  onSelect: (filter: OverviewFilter) => void
}) {
  const counts = {
    all: null,
    ready: data.summary.readyTargets,
    need_login: data.summary.needLoginTargets,
    running: data.summary.runningTargets,
  }
  const visibleCards = cards.filter((card) => card.filter === 'all' || counts[card.filter]?.coverage !== 'forbidden').map((card) => {
      const count = counts[card.filter]
      return {
        label: card.label,
        value: count?.value ?? data.summary.totalTargets,
        description: card.description + (count?.coverage === 'partial' ? ' · ' + coverageText(count, data.summary.totalTargets) : ''),
        icon: card.icon,
        pressed: card.filter === 'all' ? allSelected : selected === card.filter,
        onClick: () => onSelect(card.filter),
      }
    })
  return <section aria-label='运行概览'><CollectionSummary items={visibleCards} /></section>
}
