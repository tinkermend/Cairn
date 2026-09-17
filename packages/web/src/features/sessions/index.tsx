import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSystemOverviewFilter } from '@cairn/shared'
import { useSessionObservation } from './use-session-observation'
import { CheckCircle2, CircleAlert, CircleDashed, Search, Server } from 'lucide-react'
import { fetchSessionSystemOverview } from '@/lib/sessions-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ACCOUNT_SESSION_STATUS_LABELS, ACCOUNT_SESSION_STATUS_TONE, SESSION_SYSTEM_FILTER_LABELS } from './labels'

const FILTERS: Array<SessionSystemOverviewFilter | 'all'> = [
  'all',
  'problem',
  'unprepared',
  'ready',
  'busy',
  'retained',
]

export function SessionsPage() {
  const page = useCursorPage(20, 'sessions-systems-list')
  const observation = useSessionObservation()
  const navigate = useNavigate()
  const [search, setSearchValue] = useState(() => sessionStorage.getItem('sessions-systems-search') ?? '')
  const setSearch = (value: string) => {
    setSearchValue(value)
    sessionStorage.setItem('sessions-systems-search', value)
  }
  const [filter, setFilterValue] = useState<SessionSystemOverviewFilter | 'all'>(() => {
    const saved = sessionStorage.getItem('sessions-systems-filter')
    return FILTERS.find((value) => value === saved) ?? 'all'
  })
  const setFilter = (value: SessionSystemOverviewFilter | 'all') => {
    setFilterValue(value)
    sessionStorage.setItem('sessions-systems-filter', value)
  }

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      filter: filter === 'all' ? undefined : filter,
      limit: page.pageSize,
      cursor: page.cursor || undefined,
    }),
    [search, filter, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['sessions-systems', filters],
    queryFn: () => fetchSessionSystemOverview(filters),
    placeholderData: keepPreviousData,
  })

  const items = query.data?.items ?? []
  const summary = query.data?.summary
  const applyFilter = (value: SessionSystemOverviewFilter | 'all') => {
    setFilter(value)
    page.reset()
  }

  return (
    <Main className="flex min-w-0 flex-1 flex-col gap-6">
        <PageHeader
          title="浏览器会话"
          description="按目标系统查看会话健康度。进入系统后再维护各个账号。"
        />
        {!observation.connected && query.data ? (
          <p role="status" className="text-small text-muted-foreground">
            连接已断开，正在恢复。最后状态：{new Date(query.data.asOf).toLocaleString()}
          </p>
        ) : null}
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title="无法加载会话总览" onRetry={() => void query.refetch()} />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  icon: <Server className="size-4" />,
                  label: '系统',
                  value: summary?.systems ?? 0,
                  description: '已登记账号的目标系统',
                  pressed: filter === 'all',
                  onClick: () => applyFilter('all'),
                },
                {
                  icon: <CircleAlert className="size-4" />,
                  label: '有问题',
                  value: summary?.problemAccounts ?? 0,
                  description: '待检查、需登录、不符或失联',
                  pressed: filter === 'problem',
                  onClick: () => applyFilter('problem'),
                },
                {
                  icon: <CircleDashed className="size-4" />,
                  label: '未准备',
                  value: summary?.unpreparedAccounts ?? 0,
                  description: '还没有会话实例',
                  pressed: filter === 'unprepared',
                  onClick: () => applyFilter('unprepared'),
                },
                {
                  icon: <CheckCircle2 className="size-4" />,
                  label: '就绪账号',
                  value: summary?.readyAccounts ?? 0,
                  description: '已就绪的账号数，不是全就绪系统',
                },
              ]}
            />
            <section className="min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4">
                <div className="flex flex-wrap gap-1" aria-label="系统会话筛选">
                  {FILTERS.map((value) => (
                    <Button
                      key={value}
                      variant={filter === value ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={filter === value}
                      onClick={() => applyFilter(value)}
                    >
                      {SESSION_SYSTEM_FILTER_LABELS[value]}
                    </Button>
                  ))}
                </div>
                <div className="relative w-full max-w-xs">
                  <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="搜索目标系统"
                    className="ps-9"
                    placeholder="搜索系统名称或编码"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value)
                      page.reset()
                    }}
                  />
                </div>
              </div>
              {items.length === 0 ? (
                <EmptyState title="没有匹配的目标系统" description="换一个筛选，或先在目标系统里登记账号。" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>目标系统</TableHead>
                      <TableHead>账号数</TableHead>
                      <TableHead className="hidden md:table-cell">就绪</TableHead>
                      <TableHead className="hidden md:table-cell">有问题</TableHead>
                      <TableHead className="hidden md:table-cell">未准备</TableHead>
                      <TableHead>综合状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow
                        key={item.targetId}
                        className="cursor-pointer"
                        onClick={() =>
                          void navigate({
                            to: '/sessions/$targetId',
                            params: { targetId: item.targetId },
                          })
                        }
                      >
                        <TableCell className="font-medium text-text-primary">
                          <div>{item.targetName}</div>
                          <code className="text-label text-muted-foreground">{item.targetCode}</code>
                        </TableCell>
                        <TableCell className="tabular-nums">{item.accountTotal}</TableCell>
                        <TableCell className="hidden tabular-nums md:table-cell">{item.readyCount}</TableCell>
                        <TableCell className="hidden tabular-nums md:table-cell">{item.problemCount}</TableCell>
                        <TableCell className="hidden tabular-nums md:table-cell">{item.unpreparedCount}</TableCell>
                        <TableCell>
                          <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[item.worstStatus]}>
                            {ACCOUNT_SESSION_STATUS_LABELS[item.worstStatus]}
                          </StatusBadge>
                          <p className="mt-1 text-label text-muted-foreground md:hidden">
                            就绪 {item.readyCount} · 有问题 {item.problemCount} · 未准备 {item.unpreparedCount}
                          </p>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <div className="flex justify-end border-t border-border-divider px-4 py-3">
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
          </>
        )}
    </Main>
  )
}
