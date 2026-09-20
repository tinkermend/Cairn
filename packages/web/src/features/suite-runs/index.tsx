import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { SUITE_RUN_STATUSES, type SuiteRunStatus } from '@cairn/shared'
import { fetchSuiteRuns } from '@/lib/suites-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  SUITE_RUN_STATUS_LABELS,
  SUITE_VERDICT_LABELS,
  suiteRunStatusTone,
  suiteVerdictTone,
} from '@/features/suites/labels'

export function SuiteRunsPage() {
  const page = useCursorPage()
  const navigate = useNavigate()
  const canReadTargets = useCan('target:read')
  const [status, setStatus] = useState<'all' | SuiteRunStatus>('all')
  const [targetId, setTargetId] = useState('all')
  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })
  const filters = useMemo(
    () => ({
      status: status === 'all' ? undefined : status,
      targetId: targetId === 'all' ? undefined : targetId,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [status, targetId, page.pageSize, page.cursor],
  )
  const query = useQuery({
    queryKey: ['suite-runs', filters],
    queryFn: () => fetchSuiteRuns(filters),
    placeholderData: keepPreviousData,
  })
  const items = query.data?.items ?? []

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
      <PageHeader
        title='运行记录'
        description='独立运行与场景集运行分开查看。集合编排结束不等于全部通过。'
      />
      <Tabs value='suites' className='space-y-4'>
        <TabsList>
          <TabsTrigger value='runs' asChild>
            <Link to='/runs'>独立运行</Link>
          </TabsTrigger>
          <TabsTrigger value='suites'>场景集运行</TabsTrigger>
        </TabsList>
      </Tabs>
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <QueryErrorState title='无法加载集合运行' onRetry={() => void query.refetch()} />
      ) : (
        <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
          <div className='flex flex-wrap items-center gap-2 border-b border-border-divider p-4'>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as typeof status)
                page.reset()
              }}
            >
              <SelectTrigger className='w-40' aria-label='集合状态'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部状态</SelectItem>
                {SUITE_RUN_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {SUITE_RUN_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canReadTargets ? (
              <Select
                value={targetId}
                onValueChange={(value) => {
                  setTargetId(value)
                  page.reset()
                }}
              >
                <SelectTrigger className='w-48' aria-label='目标系统'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部目标</SelectItem>
                  {(targets.data?.items ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button variant='outline' onClick={() => void query.refetch()}>
              刷新
            </Button>
          </div>
          {items.length === 0 ? (
            <EmptyState title='还没有集合运行' description='从场景集详情启动一次顺序执行。' />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>场景集</TableHead>
                  <TableHead>编排状态</TableHead>
                  <TableHead>业务判断</TableHead>
                  <TableHead>计数</TableHead>
                  <TableHead>开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    className='cursor-pointer'
                    onClick={() => void navigate({ to: '/suite-runs/$suiteRunId', params: { suiteRunId: item.id } })}
                  >
                    <TableCell>
                      <Link
                        to='/suite-runs/$suiteRunId'
                        params={{ suiteRunId: item.id }}
                        className='font-medium text-link'
                        onClick={(event) => event.stopPropagation()}
                      >
                        {item.suiteName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={suiteRunStatusTone(item.status)}>
                        {SUITE_RUN_STATUS_LABELS[item.status]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      {item.verdict ? (
                        <StatusBadge tone={suiteVerdictTone(item.verdict)}>
                          {SUITE_VERDICT_LABELS[item.verdict]}
                        </StatusBadge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {item.counts.succeeded}/{item.counts.planned} 成功 · {item.counts.failed} 失败 · {item.counts.skipped} 跳过
                    </TableCell>
                    <TableCell>{new Date(item.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className='flex justify-end border-t border-border-divider px-4 py-3'>
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
        </div>
      )}
    </Main>
  )
}
