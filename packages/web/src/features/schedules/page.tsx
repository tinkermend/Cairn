import { useState } from 'react'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { ScheduleConsumerType, ScheduleDto } from '@cairn/shared'
import { CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchSchedules,
  setScheduleEnabled,
  triggerSchedule,
} from '@/lib/schedules-api'
import { fetchTargetAccounts, fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CollectionSummary } from '@/components/collection-summary'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'
import { ScheduleDetailDialog } from './detail'
import { ScheduleEditorDialog } from './editor'
import { CONSUMER_LABELS, SKIP_LABELS, lastResult } from './labels'

function formatInstant(value: string | null, timeZone: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone })
}

function timeSummary(item: ScheduleDto) {
  if (item.definition.timeRule.kind === 'interval') {
    return `间隔 ${Math.round(item.definition.timeRule.intervalMs / 60000)} 分钟`
  }
  const windows = item.definition.timeRule.windows
  return `${item.definition.timezone} ${windows.length > 1 ? `${windows.length} 个时间点` : `${windows[0].windowStart}（截止 ${windows[0].windowEnd}）`}`
}

export function SchedulesPage() {
  const page = useCursorPage()
  const canReadTargets = useCan('target:read')
  const canWrite = useCan('schedule:write')
  const queryClient = useQueryClient()
  const [consumerKey, setConsumerKey] = useState<ScheduleConsumerType | ''>('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleDto | null>(null)
  const [detail, setDetail] = useState<ScheduleDto | null>(null)
  const query = useQuery({
    queryKey: ['schedules', 'list', page.cursor, page.pageSize, consumerKey],
    queryFn: () =>
      fetchSchedules({
        cursor: page.cursor,
        limit: page.pageSize,
        consumerKey: consumerKey || undefined,
      }),
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
      const lists = await Promise.all(
        targetIds.map((targetId) =>
          fetchTargetAccounts(targetId, { limit: 50 })
        )
      )
      return lists.flatMap((list) => list.items)
    },
    enabled: canReadTargets && targetIds.length > 0,
  })
  const names = new Map(
    (targetsQuery.data?.items ?? []).map((item) => [item.id, item.name])
  )
  const accountNames = new Map(
    (accountsQuery.data ?? []).map((item) => [item.id, item.displayName])
  )
  const enabledMutation = useMutation({
    mutationFn: ({ item, enabled }: { item: ScheduleDto; enabled: boolean }) =>
      setScheduleEnabled(item.scheduleId, {
        expectedRevision: item.revision,
        idempotencyKey: `list-${enabled ? 'on' : 'off'}-${Date.now()}`,
        enabled,
        cancelAdmittedJobs: false,
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '启停失败'
      ),
  })
  const triggerMutation = useMutation({
    mutationFn: (item: ScheduleDto) =>
      triggerSchedule(item.scheduleId, {
        idempotencyKey: `manual-${Date.now()}`,
      }),
    onSuccess: () => {
      toast.success('已写入手动触发，等待准入')
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '触发失败'
      ),
  })

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='定时任务'
        description='统一管理场景、场景集、知识地图采集和知识分析的定时计划。新计划保存后默认停用。'
        actions={
          canWrite && (items.length > 0 || Boolean(consumerKey)) ? (
            <Button
              onClick={() => {
                setEditing(null)
                setEditorOpen(true)
              }}
            >
              新建调度
            </Button>
          ) : null
        }
      />
      <div className='flex flex-wrap items-center gap-2'>
        <label
          className='text-label text-muted-foreground'
          htmlFor='schedule-filter'
        >
          任务类型
        </label>
        <SelectField
          id='schedule-filter'
          className='w-auto'
          value={consumerKey}
          onValueChange={(value) =>
            setConsumerKey(value as ScheduleConsumerType | '')
          }
        >
          <SelectFieldOption value=''>全部</SelectFieldOption>
          {Object.entries(CONSUMER_LABELS).map(([value, label]) => (
            <SelectFieldOption key={value} value={value}>
              {label}
            </SelectFieldOption>
          ))}
        </SelectField>
      </div>
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <QueryErrorState
          title='无法加载调度计划'
          onRetry={() => void query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={consumerKey ? '没有匹配的调度计划' : '还没有调度计划'}
          description={
            consumerKey
              ? '当前筛选的任务类型下暂无计划，可更换筛选或清除条件。'
              : '先选任务类型和目标系统，再设置排期。新计划保存后默认停用。'
          }
          action={
            consumerKey ? (
              <Button variant='outline' onClick={() => setConsumerKey('')}>
                清除筛选
              </Button>
            ) : canWrite ? (
              <Button
                onClick={() => {
                  setEditing(null)
                  setEditorOpen(true)
                }}
              >
                新建调度
              </Button>
            ) : undefined
          }
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
                  <TableHead>任务</TableHead>
                  <TableHead>目标 / 对象</TableHead>
                  <TableHead>排期</TableHead>
                  <TableHead>下次窗口</TableHead>
                  <TableHead>最近准入</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.scheduleId}>
                    <TableCell>
                      <p className='text-body'>
                        {CONSUMER_LABELS[item.consumerKey]}
                      </p>
                      <p className='text-label text-muted-foreground'>
                        {item.name ?? item.objectLabel ?? '—'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className='text-body'>
                        {names.get(item.targetId) ?? item.targetId.slice(0, 8)}
                      </p>
                      <p className='text-label text-muted-foreground'>
                        {item.targetAccountId
                          ? (accountNames.get(item.targetAccountId) ??
                            item.targetAccountId.slice(0, 8))
                          : item.consumerKey === 'map_ingest'
                            ? '由平台选择采集账号'
                            : (item.objectLabel ?? '无浏览器账号')}
                      </p>
                    </TableCell>
                    <TableCell>{timeSummary(item)}</TableCell>
                    <TableCell>
                      {formatInstant(item.nextDueAt, item.definition.timezone)}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1.5'>
                        {item.lastOccurrence?.admissionStatus && (
                          <span
                            className={cn(
                              'size-2 shrink-0 rounded-full',
                              item.lastOccurrence.admissionStatus === 'ADMITTED'
                                ? 'bg-status-success'
                                : item.lastOccurrence.admissionStatus === 'SKIPPED'
                                  ? 'bg-status-warning'
                                  : item.lastOccurrence.admissionStatus === 'FAILED'
                                    ? 'bg-status-error'
                                    : 'bg-status-info'
                            )}
                            aria-hidden
                          />
                        )}
                        <span className='text-small text-text-primary'>
                          {lastResult(
                            item.lastOccurrence?.admissionStatus,
                            item.lastOccurrence?.reason
                          )}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className='flex flex-col gap-1'>
                        <StatusBadge tone={item.enabled ? 'success' : 'neutral'}>
                          {item.enabled ? '已启用' : '已停用'}
                        </StatusBadge>
                        {item.blockReasons?.length ? (
                          <p className='text-label text-status-warning-foreground'>
                            {item.blockReasons
                              .map(
                                (reason) =>
                                  SKIP_LABELS[
                                    reason as keyof typeof SKIP_LABELS
                                  ] ?? reason
                              )
                              .join(' · ')}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          type='button'
                          variant='ghost'
                          size='sm'
                          onClick={() => setDetail(item)}
                        >
                          详情
                        </Button>
                        {canWrite ? (
                          <>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              onClick={() => {
                                setEditing(item)
                                setEditorOpen(true)
                              }}
                            >
                              编辑
                            </Button>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              onClick={() =>
                                enabledMutation.mutate({
                                  item,
                                  enabled: !item.enabled,
                                })
                              }
                            >
                              {item.enabled ? '停用' : '启用'}
                            </Button>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              onClick={() => triggerMutation.mutate(item)}
                            >
                              立即执行
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TableCell>
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
      <ScheduleEditorDialog
        key={editing?.scheduleId ?? (editorOpen ? 'new' : 'closed')}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        existing={editing}
      />
      <ScheduleDetailDialog
        schedule={detail}
        onOpenChange={(open) => !open && setDetail(null)}
      />
    </Main>
  )
}
