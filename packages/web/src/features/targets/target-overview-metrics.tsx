import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TargetDto } from '@cairn/shared'
import {
  ArrowUpRight,
  Compass,
  Globe,
  Layers,
  Users,
} from 'lucide-react'
import { fetchSessionOverview } from '@/lib/sessions-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { Can } from '@/components/rbac/can'

interface TargetOverviewMetricsProps {
  target: TargetDto
  onSelectTab?: (tab: string) => void
}

export function TargetOverviewMetrics({
  target,
  onSelectTab,
}: TargetOverviewMetricsProps) {
  const sessionQuery = useQuery({
    queryKey: ['sessions-overview', { targetId: target.id }],
    queryFn: () => fetchSessionOverview({ targetId: target.id }),
    staleTime: 10_000,
  })

  const scenarioQuery = useQuery({
    queryKey: ['scenarios', { targetId: target.id }],
    queryFn: () => fetchScenarios({ targetId: target.id, limit: 100 }),
    staleTime: 30_000,
  })

  const sessionSummary = sessionQuery.data?.summary
  const scenarioItems = scenarioQuery.data?.items ?? []
  const activeScenarios = scenarioItems.filter((s) => s.status === 'active').length

  return (
    <div className='grid min-w-0 grid-cols-1 divide-y divide-border-divider rounded-lg border border-border-card bg-card shadow-card sm:grid-cols-2 sm:divide-y-0 sm:divide-x lg:grid-cols-4'>
      {/* 账号指标项（切换至账号 Tab） */}
      <button
        type='button'
        onClick={() => onSelectTab?.('accounts')}
        className='group flex items-center justify-between p-3.5 text-left transition-colors hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-ring'
      >
        <div className='min-w-0'>
          <span className='block text-label text-muted-foreground'>目标账号</span>
          <div className='mt-1 flex items-baseline gap-1.5'>
            <span className='font-mono text-section font-semibold text-text-primary group-hover:text-primary'>
              {target.accountCount}
            </span>
            <span className='text-label text-muted-foreground'>个配置</span>
          </div>
          <span className='mt-0.5 block truncate text-label text-muted-foreground'>
            点击管理凭据与角色
          </span>
        </div>
        <div className='flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary'>
          <Users className='size-4' />
        </div>
      </button>

      {/* 会话就绪指标项（链接至会话总览） */}
      <div className='flex items-center justify-between p-3.5'>
        <div className='min-w-0'>
          <div className='flex items-center gap-1.5'>
            <span className='text-label text-muted-foreground'>浏览器会话</span>
            <Link
              to='/sessions/$targetId'
              params={{ targetId: target.id }}
              className='inline-flex items-center text-label text-link hover:underline'
            >
              总览
              <ArrowUpRight className='size-3' />
            </Link>
          </div>
          <div className='mt-1 flex items-baseline gap-1.5'>
            {sessionQuery.isPending ? (
              <span className='text-label text-muted-foreground'>查询中…</span>
            ) : sessionSummary ? (
              <>
                <span className='font-mono text-section font-semibold text-text-primary'>
                  {sessionSummary.available}
                </span>
                <span className='text-label text-muted-foreground'>
                  就绪 / 共 {sessionSummary.total}
                </span>
              </>
            ) : (
              <span className='text-label text-muted-foreground'>暂无活跃会话</span>
            )}
          </div>
          <span className='mt-0.5 block truncate text-label text-muted-foreground'>
            {sessionSummary?.executing
              ? `${sessionSummary.executing} 执行中`
              : '过期回到登录页后按已录入信息重登'}
          </span>
        </div>
        <div className='flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
          <Globe className='size-4' />
        </div>
      </div>

      {/* 关联场景指标项（切换至场景 Tab） */}
      <button
        type='button'
        onClick={() => onSelectTab?.('scenarios')}
        className='group flex items-center justify-between p-3.5 text-left transition-colors hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-ring'
      >
        <div className='min-w-0'>
          <span className='block text-label text-muted-foreground'>关联场景</span>
          <div className='mt-1 flex items-baseline gap-1.5'>
            {scenarioQuery.isPending ? (
              <span className='text-label text-muted-foreground'>加载中…</span>
            ) : (
              <>
                <span className='font-mono text-section font-semibold text-text-primary group-hover:text-primary'>
                  {scenarioItems.length}
                </span>
                <span className='text-label text-muted-foreground'>
                  个 ({activeScenarios} 启用)
                </span>
              </>
            )}
          </div>
          <span className='mt-0.5 block truncate text-label text-muted-foreground'>
            点击查看业务执行用例
          </span>
        </div>
        <div className='flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary'>
          <Layers className='size-4' />
        </div>
      </button>

      {/* 知识地图概览项 */}
      <div className='flex items-center justify-between p-3.5'>
        <div className='min-w-0'>
          <div className='flex items-center gap-1.5'>
            <span className='text-label text-muted-foreground'>知识地图</span>
            <Can permission='map:read'>
              <Link
                to='/targets/$targetId/map'
                params={{ targetId: target.id }}
                className='inline-flex items-center text-label text-link hover:underline'
              >
                打开
                <ArrowUpRight className='size-3' />
              </Link>
            </Can>
          </div>
          <div className='mt-1 flex flex-wrap items-center gap-1.5'>
            <span className='text-section font-semibold text-text-primary'>系统知识</span>
          </div>
          <span className='mt-0.5 block truncate text-label text-muted-foreground'>
            查看该系统已积累的页面与条件
          </span>
        </div>
        <div className='flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
          <Compass className='size-4' />
        </div>
      </div>
    </div>
  )
}
