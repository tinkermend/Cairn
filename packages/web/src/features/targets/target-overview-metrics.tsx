import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TargetDto } from '@cairn/shared'
import {
  Compass,
  Globe,
  Layers,
  Users,
} from 'lucide-react'
import { fetchSessionOverview } from '@/lib/sessions-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { AUTH_CAPABILITY_LABELS } from './labels'

interface TargetOverviewMetricsProps {
  target: TargetDto
  onSelectTab?: (tab: string) => void
}

export function TargetOverviewMetrics({
  target,
  onSelectTab,
}: TargetOverviewMetricsProps) {
  const sessionQuery = useQuery({
    queryKey: ['browser-sessions', 'overview', { search: target.name }],
    queryFn: () => fetchSessionOverview({ search: target.name }),
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
    <div className='grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4'>
      {/* 账号指标卡 */}
      <button
        type='button'
        onClick={() => onSelectTab?.('accounts')}
        className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 text-left shadow-card focus-visible:outline-2 focus-visible:outline-ring'
      >
        <div className='flex items-center justify-between gap-2'>
          <span className='text-small font-medium text-muted-foreground'>目标账号</span>
          <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
            <Users className='size-4' />
          </div>
        </div>
        <div className='mt-2 flex items-baseline gap-2'>
          <span className='font-mono text-section font-semibold text-text-primary'>
            {target.accountCount}
          </span>
          <span className='text-label text-muted-foreground'>个配置账号</span>
        </div>
        <p className='mt-1 text-label text-muted-foreground truncate'>
          凭据隔离管理 · 支持多角色
        </p>
      </button>

      {/* 会话就绪指标卡 */}
      <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 text-left shadow-card'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-small font-medium text-muted-foreground'>浏览器会话</span>
          <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
            <Globe className='size-4' />
          </div>
        </div>
        <div className='mt-2 flex items-baseline gap-2'>
          {sessionQuery.isPending ? (
            <span className='text-label text-muted-foreground'>查询中…</span>
          ) : sessionSummary ? (
            <>
              <span className='font-mono text-section font-semibold text-text-primary'>
                {sessionSummary.available}
              </span>
              <span className='text-label text-muted-foreground'>
                就绪 / 共 {sessionSummary.total} 个
              </span>
            </>
          ) : (
            <span className='text-label text-muted-foreground'>暂无活跃会话</span>
          )}
        </div>
        <div className='mt-1 flex items-center justify-between text-label text-muted-foreground'>
          <span>
            {sessionSummary?.executing
              ? `${sessionSummary.executing} 执行占用`
              : '单会话单租约保障'}
          </span>
          <Link
            to='/sessions'
            className='text-link hover:underline'
          >
            会话总览 →
          </Link>
        </div>
      </div>

      {/* 关联场景指标卡 */}
      <button
        type='button'
        onClick={() => onSelectTab?.('scenarios')}
        className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 text-left shadow-card focus-visible:outline-2 focus-visible:outline-ring'
      >
        <div className='flex items-center justify-between gap-2'>
          <span className='text-small font-medium text-muted-foreground'>关联场景</span>
          <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
            <Layers className='size-4' />
          </div>
        </div>
        <div className='mt-2 flex items-baseline gap-2'>
          {scenarioQuery.isPending ? (
            <span className='text-label text-muted-foreground'>加载中…</span>
          ) : (
            <>
              <span className='font-mono text-section font-semibold text-text-primary'>
                {scenarioItems.length}
              </span>
              <span className='text-label text-muted-foreground'>
                个场景 ({activeScenarios} 启用)
              </span>
            </>
          )}
        </div>
        <p className='mt-1 text-label text-muted-foreground truncate'>
          执行生命周期与调度边界
        </p>
      </button>

      {/* 认证与知识概览卡 */}
      <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 text-left shadow-card'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-small font-medium text-muted-foreground'>知识与认证</span>
          <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
            <Compass className='size-4' />
          </div>
        </div>
        <div className='mt-2 flex flex-wrap items-center gap-1.5'>
          <StatusBadge tone='info'>
            {AUTH_CAPABILITY_LABELS[target.currentAuthProfileRevision ? 'LOGIN_VERIFIED' : 'LEGACY']}
          </StatusBadge>
          {target.currentAuthProfileRevision ? (
            <span className='text-label text-muted-foreground'>
              Rev.{target.currentAuthProfileRevision}
            </span>
          ) : null}
        </div>
        <div className='mt-1 flex items-center justify-between text-label'>
          <Can permission='map:read'>
            <Link
              to='/targets/$targetId/map'
              params={{ targetId: target.id }}
              className='text-link hover:underline'
            >
              知识表面地图 →
            </Link>
          </Can>
        </div>
      </div>
    </div>
  )
}
