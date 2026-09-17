import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { WorkerStatus, WorkerSummary } from '@cairn/shared'
import { ArrowUpRight, ChevronRight, RefreshCw, Search, Server } from 'lucide-react'
import { fetchWorkers } from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
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
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import {
  MISMATCH_LABELS,
  ROUTE_REASON_LABELS,
  WORKER_STATUS_FILTER_LABELS,
  workerLifecycle,
} from './labels'

const STATUS_FILTERS = ['all', 'READY', 'DRAINING', 'STOPPED', 'LOST'] as const
const FRESH_FILTERS = ['all', 'fresh', 'stale'] as const

function formatAsOf(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function WorkersPage() {
  const page = useCursorPage()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('all')
  const [fresh, setFresh] = useState<(typeof FRESH_FILTERS)[number]>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      status: status === 'all' ? undefined : (status as WorkerStatus),
      heartbeatFresh: fresh === 'all' ? undefined : fresh === 'fresh',
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, status, fresh, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['workers', filters],
    queryFn: () => fetchWorkers(filters),
    placeholderData: keepPreviousData,
  })

  const items = query.data?.items ?? []
  const selected = items.find((item) => item.workerId === selectedId) ?? items[0]

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='执行节点'
          description='查看 Worker 生命周期、心跳新鲜度、浏览器占用和转发条件。内部入口只对运维权限可见。'
          actions={
            <Button onClick={() => void query.refetch()} variant='outline'>
              <RefreshCw />
              刷新
            </Button>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载执行节点' onRetry={() => void query.refetch()} />
        ) : items.length === 0 && !search && status === 'all' && fresh === 'all' ? (
          <EmptyState title='还没有执行节点' description='Worker 启动后会向数据库登记，并出现在此列表。' />
        ) : (
          <>
            <p className='text-label text-muted-foreground'>
              截至 {query.data ? formatAsOf(query.data.asOf) : '—'}
            </p>
            <CollectionSummary
              items={[
                {
                  label: '本页节点',
                  value: items.length,
                  description: '当前页登记',
                  icon: <Server className='size-4' />,
                },
                {
                  label: '在跑',
                  value: items.reduce((sum, item) => sum + item.counts.running, 0),
                  description: '关联 Run 正在执行',
                  icon: <Server className='size-4' />,
                },
                {
                  label: '等待认证',
                  value: items.reduce((sum, item) => sum + item.counts.waitingForAuth, 0),
                  description: '绑定完整的认证占用',
                  icon: <Server className='size-4' />,
                },
                {
                  label: '失联占用',
                  value: items.reduce((sum, item) => sum + item.counts.lostOccupied, 0),
                  description: '仍占账号键',
                  icon: <Server className='size-4' />,
                },
              ]}
            />
            <div className='grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]'>
              <section
                aria-label='执行节点列表'
                className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                  <div className='flex flex-wrap gap-1' aria-label='节点状态筛选'>
                    {STATUS_FILTERS.map((value) => (
                      <Button
                        key={value}
                        variant={status === value ? 'secondary' : 'ghost'}
                        size='sm'
                        aria-pressed={status === value}
                        onClick={() => {
                          setStatus(value)
                          page.reset()
                        }}
                      >
                        {value === 'all' ? '全部状态' : WORKER_STATUS_FILTER_LABELS[value]}
                      </Button>
                    ))}
                  </div>
                  <div className='relative w-full sm:w-64'>
                    <Search
                      aria-hidden='true'
                      className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                    />
                    <Input
                      aria-label='搜索执行节点'
                      placeholder='搜索节点 ID'
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value)
                        page.reset()
                      }}
                      className='pl-9'
                    />
                  </div>
                </div>
                <div className='flex flex-wrap gap-1 border-b border-border-divider px-4 py-2' aria-label='心跳新鲜度'>
                  {FRESH_FILTERS.map((value) => (
                    <Button
                      key={value}
                      variant={fresh === value ? 'secondary' : 'ghost'}
                      size='sm'
                      aria-pressed={fresh === value}
                      onClick={() => {
                        setFresh(value)
                        page.reset()
                      }}
                    >
                      {value === 'all' ? '全部心跳' : value === 'fresh' ? '心跳新鲜' : '心跳过期'}
                    </Button>
                  ))}
                </div>
                {items.length === 0 ? (
                  <EmptyState
                    title='没有匹配的执行节点'
                    description='试试其他关键词，或清除筛选条件。'
                    action={
                      <Button
                        variant='outline'
                        onClick={() => {
                          setSearch('')
                          setStatus('all')
                          setFresh('all')
                          page.reset()
                        }}
                      >
                        清除筛选
                      </Button>
                    }
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>节点</TableHead>
                        <TableHead>生命周期</TableHead>
                        <TableHead>占用</TableHead>
                        <TableHead>转发</TableHead>
                        <TableHead>
                          <span className='sr-only'>概览</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => {
                        const life = workerLifecycle(item)
                        return (
                          <TableRow
                            key={item.workerId}
                            className='cursor-pointer'
                            onClick={() => setSelectedId(item.workerId)}
                            data-state={selected?.workerId === item.workerId ? 'selected' : undefined}
                          >
                            <TableCell className='py-4'>
                              <div className='min-w-0'>
                                <button
                                  type='button'
                                  aria-pressed={selected?.workerId === item.workerId}
                                  aria-controls='worker-overview'
                                  className='block max-w-64 truncate rounded-sm text-body font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                                  title={item.workerId}
                                >
                                  {item.workerId}
                                </button>
                                <p className='mt-1 text-label text-muted-foreground'>
                                  容量 {item.capacity} · 槽位 {item.counts.occupiedSlots}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>
                              <StatusBadge tone={life.tone}>{life.label}</StatusBadge>
                            </TableCell>
                            <TableCell className='tabular-nums'>
                              {item.counts.running}/{item.counts.holding}/{item.counts.waitingForAuth}
                            </TableCell>
                            <TableCell>
                              <StatusBadge tone={item.routeAvailability === 'eligible' ? 'success' : 'warning'}>
                                {item.routeAvailability === 'eligible'
                                  ? '可转发'
                                  : item.routeReason
                                    ? ROUTE_REASON_LABELS[item.routeReason]
                                    : '不可用'}
                              </StatusBadge>
                            </TableCell>
                            <TableCell>
                              <Button
                                variant='ghost'
                                size='icon'
                                aria-label={`查看${item.workerId}概览`}
                                onClick={() => setSelectedId(item.workerId)}
                              >
                                <ChevronRight />
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}
                <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
                  <p role='status' className='text-label text-muted-foreground'>
                    显示 {items.length} 个节点
                  </p>
                  <CursorPagination
                    pageIndex={page.pageIndex}
                    pageSize={page.pageSize}
                    hasPreviousPage={page.pageIndex > 0}
                    hasNextPage={Boolean(query.data?.nextCursor)}
                    updating={query.isFetching && query.isPlaceholderData}
                    onPageSizeChange={page.setPageSize}
                    onPreviousPage={page.goPrev}
                    onNextPage={() => {
                      if (query.data?.nextCursor) page.goNext(query.data.nextCursor)
                    }}
                  />
                </div>
              </section>
              {selected ? <WorkerOverview worker={selected} asOf={query.data?.asOf} /> : null}
            </div>
          </>
        )}
      </Main>
    </>
  )
}

function WorkerOverview({ worker, asOf }: { worker: WorkerSummary; asOf?: string }) {
  const life = workerLifecycle(worker)
  return (
    <aside
      id='worker-overview'
      aria-label='节点概览'
      className='min-w-0 rounded-lg border border-border-card bg-card shadow-card'
    >
      <div className='space-y-4 border-b border-border-divider p-5'>
        <p className='text-label text-muted-foreground'>当前节点</p>
        <h2 className='text-section font-semibold break-all'>{worker.workerId}</h2>
        <StatusBadge tone={life.tone}>{life.label}</StatusBadge>
      </div>
      <dl className='space-y-4 p-5 text-small'>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>心跳</dt>
          <dd>{formatAsOf(worker.heartbeatAt)}</dd>
        </div>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>在跑 / 暂停 / 认证</dt>
          <dd className='tabular-nums'>
            {worker.counts.running} / {worker.counts.holding} / {worker.counts.waitingForAuth}
          </dd>
        </div>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>句柄采样</dt>
          <dd>{MISMATCH_LABELS[worker.handleSample.mismatchState]}</dd>
        </div>
        {asOf ? (
          <div className='flex justify-between gap-3'>
            <dt className='text-muted-foreground'>读取时间</dt>
            <dd>{formatAsOf(asOf)}</dd>
          </div>
        ) : null}
      </dl>
      <div className='border-t border-border-divider p-4'>
        <Button variant='outline' asChild>
          <Link to='/workers/$workerId' params={{ workerId: worker.workerId }}>
            查看节点详情
            <ArrowUpRight />
          </Link>
        </Button>
      </div>
    </aside>
  )
}
