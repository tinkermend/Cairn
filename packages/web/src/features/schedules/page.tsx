import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import type { ScheduleAdmissionStatus, ScheduleSkipReason } from '@cairn/shared'
import { fetchSchedules } from '@/lib/schedules-api'
import { fetchTargetAccounts, fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { CursorPagination } from '@/components/data-table'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ADMISSION_LABELS: Record<ScheduleAdmissionStatus, string> = {
  PENDING: '待准入',
  ADMITTED: '已准入',
  SKIPPED: '已跳过',
  FAILED: '准入失败',
}

const SKIP_LABELS: Partial<Record<ScheduleSkipReason, string>> = {
  WINDOW_CLOSED: '错过窗口',
  DST_NONEXISTENT: '夏令时不存在',
  FACTORY_DISABLED: '工厂关闭',
  AUTH_PREPARATION_REQUIRED: '认证未准备',
  MAP_ACCOUNT_USAGE_REQUIRED: '账号已收回地图用途',
  NO_ELIGIBLE_ASSETS: '无可用资产',
  ACTIVE_SLICE_EXISTS: '会话或作业占用',
}

function formatInstant(value: string | null, timeZone: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone })
}

function lastResult(status: ScheduleAdmissionStatus | undefined, reason: ScheduleSkipReason | null | undefined) {
  if (!status) return '还没有窗口'
  if (status === 'ADMITTED') return '已准入（作业已创建，不等于复查成功）'
  if (status === 'SKIPPED' && reason) return `已跳过 · ${SKIP_LABELS[reason] ?? reason}`
  return ADMISSION_LABELS[status]
}

export function SchedulesPage() {
  const page = useCursorPage()
  const canReadTargets = useCan('target:read')
  const query = useQuery({
    queryKey: ['schedules', 'list', page.cursor, page.pageSize],
    queryFn: () => fetchSchedules({ cursor: page.cursor, limit: page.pageSize }),
    placeholderData: keepPreviousData,
  })
  const targetsQuery = useQuery({
    queryKey: ['targets', 'schedule-names'],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })
  const items = query.data?.items ?? []
  const targetIds = [...new Set(items.map((item) => item.targetId))].sort()
  const accountsQuery = useQuery({
    queryKey: ['targets', 'schedule-account-names', targetIds],
    queryFn: async () => {
      const lists = await Promise.all(targetIds.map((targetId) => fetchTargetAccounts(targetId, { limit: 50 })))
      return lists.flatMap((list) => list.items)
    },
    enabled: canReadTargets && targetIds.length > 0,
  })
  const names = new Map((targetsQuery.data?.items ?? []).map((item) => [item.id, item.name]))
  const accountNames = new Map((accountsQuery.data ?? []).map((item) => [item.id, item.displayName]))

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='定时调度'
          description='查看定时任务、下次触发窗口和最近触发结果。当前支持地图复查，场景定时执行尚未开放。'
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载调度计划' onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有调度计划'
            description='在目标知识页设置时区、窗口和账号。出厂关闭时即使保存也不会触发。'
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '本页计划',
                  value: items.length,
                  description: '当前页调度',
                  icon: <CalendarClock className='size-4' />,
                },
                {
                  label: '已启用',
                  value: items.filter((item) => item.enabled).length,
                  description: '按计划等待触发',
                  icon: <CalendarClock className='size-4' />,
                },
              ]}
            />
            <section
              aria-label='调度计划'
              className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>任务类型</TableHead>
                    <TableHead>目标 / 账号</TableHead>
                    <TableHead>时区与窗口</TableHead>
                    <TableHead>下次窗口</TableHead>
                    <TableHead>最近准入</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.scheduleId}>
                      <TableCell>地图复查</TableCell>
                      <TableCell>
                        <p className='text-body'>{names.get(item.targetId) ?? item.targetId.slice(0, 8)}</p>
                        <p className='text-label text-muted-foreground'>
                          {accountNames.get(item.targetAccountId) ?? item.targetAccountId.slice(0, 8)}
                        </p>
                      </TableCell>
                      <TableCell>
                        {item.definition.timezone} {item.definition.windowStart}–{item.definition.windowEnd}
                      </TableCell>
                      <TableCell>{formatInstant(item.nextDueAt, item.definition.timezone)}</TableCell>
                      <TableCell>
                        {lastResult(item.lastOccurrence?.admissionStatus, item.lastOccurrence?.reason)}
                      </TableCell>
                      <TableCell>{item.enabled ? '已启用' : '已停用'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className='border-t border-border-divider p-3'>
                <CursorPagination
                  pageIndex={page.pageIndex}
                  pageSize={page.pageSize}
                  hasPreviousPage={page.pageIndex > 0}
                  hasNextPage={Boolean(query.data?.nextCursor)}
                  updating={query.isFetching}
                  onPageSizeChange={page.setPageSize}
                  onPreviousPage={page.goPrev}
                  onNextPage={() => {
                    if (query.data?.nextCursor) page.goNext(query.data.nextCursor)
                  }}
                />
              </div>
            </section>
            <Button variant='outline' className='self-start' onClick={() => void query.refetch()}>
              刷新
            </Button>
          </>
        )}
    </Main>
  )
}
