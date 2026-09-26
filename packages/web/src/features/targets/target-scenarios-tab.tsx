import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Layers, Plus, Search } from 'lucide-react'
import { fetchScenarios } from '@/lib/scenarios-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { CursorPagination } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'

interface TargetScenariosTabProps {
  targetId: string
  targetName: string
}

export function TargetScenariosTab({ targetId, targetName }: TargetScenariosTabProps) {
  const page = useCursorPage()
  const canRead = useCan('workflow:read')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all')

  const query = useQuery({
    queryKey: ['scenarios', { targetId, search, statusFilter, cursor: page.cursor, limit: page.pageSize }],
    queryFn: () => fetchScenarios({ targetId, search: search.trim() || undefined, status: statusFilter === 'all' ? undefined : statusFilter, cursor: page.cursor, limit: page.pageSize }),
    placeholderData: keepPreviousData,
    enabled: canRead,
  })

  const items = query.data?.items ?? []

  const isFiltered = Boolean(search.trim() || statusFilter !== 'all')

  if (!canRead) {
    return <section aria-label='关联场景' className='rounded-lg border border-border-card bg-card p-5 text-label text-muted-foreground'>当前账号无权查看关联场景。</section>
  }

  if (query.isPending) {
    return <PageSkeleton />
  }

  if (query.isError) {
    return (
      <QueryErrorState
        title='无法加载关联场景'
        onRetry={() => {
          void query.refetch()
        }}
      />
    )
  }

  return (
    <section
      aria-label='关联场景'
      className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
    >
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
        <div className='flex items-center gap-2'>
          <Layers className='size-4 text-primary' />
          <div>
            <h2 className='text-section font-semibold text-text-primary'>
              关联场景
            </h2>
            <p className='text-label text-muted-foreground'>
              执行时绑定「{targetName}」边界，共享浏览器会话与凭据上下文。
            </p>
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button variant='outline' size='sm' asChild>
            <Link to='/scenarios' search={{ targetId }}>
              <Plus />
              新建场景
            </Link>
          </Button>
        </div>
      </div>

      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
        <div className='flex flex-wrap gap-1' aria-label='场景状态筛选'>
          {(
            [
              ['all', '全部'],
              ['active', '已启用'],
              ['disabled', '已停用'],
            ] as const
          ).map(([val, label]) => (
            <Button
              key={val}
              variant={statusFilter === val ? 'secondary' : 'ghost'}
              size='sm'
              aria-pressed={statusFilter === val}
              onClick={() => { setStatusFilter(val); page.reset() }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className='relative w-full sm:w-64'>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
          />
          <Input
            aria-label='搜索场景'
            placeholder='搜索场景名称'
            value={search}
            onChange={(e) => { setSearch(e.target.value); page.reset() }}
            className='pl-9'
          />
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={isFiltered ? '没有匹配的关联场景' : '该系统暂未关联场景'}
          description={
            isFiltered
              ? '试试其他关键词，或清除筛选条件。'
              : '场景必须绑定 Target 才能执行。前往场景工作台新建或绑定场景。'
          }
          action={
            isFiltered ? (
              <Button
                variant='outline'
                onClick={() => {
                  setSearch('')
                  setStatusFilter('all')
                  page.reset()
                }}
              >
                清除筛选
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className='overflow-hidden'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>场景名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>步骤数</TableHead>
                <TableHead>最新版本</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className='w-32 text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((scenario) => (
                <TableRow key={scenario.id}>
                  <TableCell className='py-4 font-medium text-text-primary'>
                    <Link
                      to='/scenarios/$scenarioId'
                      params={{ scenarioId: scenario.id }}
                      className='hover:text-link hover:underline font-medium'
                    >
                      {scenario.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      tone={scenario.status === 'active' ? 'success' : 'neutral'}
                    >
                      {scenario.status === 'active' ? '已启用' : '已停用'}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className='font-mono text-label text-text-secondary'>
                    {scenario.stepCount} 步
                  </TableCell>
                  <TableCell className='font-mono text-label text-text-secondary'>
                    {scenario.latestVersionNo ? `v${scenario.latestVersionNo}` : '未发布'}
                  </TableCell>
                  <TableCell className='text-label text-muted-foreground'>
                    {new Date(scenario.updatedAt).toLocaleString('zh-CN', {
                      hour12: false,
                    })}
                  </TableCell>
                  <TableCell className='text-right'>
                    <Button variant='ghost' size='sm' asChild>
                      <Link
                        to='/scenarios/$scenarioId'
                        params={{ scenarioId: scenario.id }}
                      >
                        进入编排
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className='flex flex-wrap items-center justify-between gap-3 border-t border-border-divider px-4 py-3'>
        <p role='status' className='text-label text-muted-foreground'>本页 {items.length} 条</p>
        <CursorPagination
          pageIndex={page.pageIndex}
          pageSize={page.pageSize}
          hasPreviousPage={page.pageIndex > 0}
          hasNextPage={Boolean(query.data?.nextCursor)}
          updating={query.isFetching && query.isPlaceholderData}
          onPageSizeChange={page.setPageSize}
          onPreviousPage={page.goPrev}
          onNextPage={() => { if (query.data?.nextCursor) page.goNext(query.data.nextCursor) }}
        />
      </div>
    </section>
  )
}
