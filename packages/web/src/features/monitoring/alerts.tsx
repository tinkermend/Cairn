import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import {
  MAX_ALERT_SILENCE_SECONDS,
  MIN_ALERT_SILENCE_SECONDS,
  type MonitorAlertItem,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMonitorAlerts, silenceMonitorAlert } from '@/lib/monitoring-api'
import { useCan } from '@/hooks/use-permissions'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { Button } from '@/components/ui/button'
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
import { StatusBadge } from '@/components/status-badge'
import { FailureAlert, Section } from './facts'
import {
  alertStateTone,
  formatDuration,
  noticeKindLabel,
  partitionFailure,
  permissionFailure,
} from './labels'

const SILENCE_OPTIONS = [
  { seconds: MIN_ALERT_SILENCE_SECONDS, label: '5 分钟' },
  { seconds: 3_600, label: '1 小时' },
  { seconds: MAX_ALERT_SILENCE_SECONDS, label: '24 小时' },
] as const

export function AlertsSection() {
  const canSilence = useCan('monitor:operate')
  const canReadConfig = useCan('platform-config:read')
  const historyPage = useCursorPage(20, 'monitoring-alert-history')
  const activePage = useCursorPage(20, 'monitoring-alert-active')
  const active = useQuery({
    queryKey: ['monitoring', 'alerts', 'active', activePage.pageSize, activePage.cursor],
    queryFn: () =>
      fetchMonitorAlerts({
        view: 'active',
        limit: activePage.pageSize,
        cursor: activePage.cursor,
      }),
    placeholderData: keepPreviousData,
  })
  const history = useQuery({
    queryKey: ['monitoring', 'alerts', 'history', historyPage.pageSize, historyPage.cursor],
    queryFn: () =>
      fetchMonitorAlerts({
        view: 'history',
        limit: historyPage.pageSize,
        cursor: historyPage.cursor,
      }),
    placeholderData: keepPreviousData,
  })

  return (
    <Section title='告警'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <p className='text-label text-muted-foreground'>
          未恢复告警置顶。静默只抑制通知，不改判定。规则在平台配置里开关，出厂全部关闭。
        </p>
        {canReadConfig ? (
          <Button variant='outline' size='sm' asChild>
            <Link to='/notifications' search={{ tab: 'alerts' }}>
              配置规则
              <ArrowUpRight />
            </Link>
          </Button>
        ) : (
          <p className='text-label text-muted-foreground'>规则入口在平台配置，当前账号不能打开。</p>
        )}
      </div>
      {active.isPending ? (
        <PageSkeleton rows={3} />
      ) : active.isError ? (
        active.error instanceof ApiRequestError && active.error.status === 403 ? (
          <FailureAlert {...permissionFailure('当前账号不能读取告警。')} />
        ) : (
          <FailureAlert {...partitionFailure('AGGREGATE_FAILED')} />
        )
      ) : active.data && active.data.items.length === 0 && activePage.pageIndex === 0 ? (
        <EmptyState title='当前没有未恢复告警' description='开启规则并满足迟滞后才会出现在这里。pending 不展示。' />
      ) : active.data ? (
        <>
          <AlertTable items={active.data.items} canSilence={canSilence} />
          {active.data.items.length > 0 || activePage.pageIndex > 0 ? (
            <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-1 py-3 gap-3'>
              <p className='text-label text-muted-foreground'>显示 {active.data.items.length} 条</p>
              <CursorPagination
                pageIndex={activePage.pageIndex}
                pageSize={activePage.pageSize}
                hasPreviousPage={activePage.pageIndex > 0}
                hasNextPage={Boolean(active.data.nextCursor)}
                updating={active.isFetching && active.isPlaceholderData}
                onPageSizeChange={activePage.setPageSize}
                onPreviousPage={activePage.goPrev}
                onNextPage={() => {
                  if (active.data?.nextCursor) activePage.goNext(active.data.nextCursor)
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
      <div className='space-y-3'>
        <h3 className='text-small font-semibold'>历史</h3>
        {history.isPending ? (
          <PageSkeleton rows={2} />
        ) : history.isError ? (
          <FailureAlert {...partitionFailure('AGGREGATE_FAILED')} />
        ) : (history.data?.items.length ?? 0) === 0 ? (
          <p className='text-label text-muted-foreground'>还没有已恢复的告警。</p>
        ) : (
          <>
            <AlertTable items={history.data!.items} canSilence={false} />
            <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-1 py-3 gap-3'>
              <p className='text-label text-muted-foreground'>显示 {history.data!.items.length} 条</p>
              <CursorPagination
                pageIndex={historyPage.pageIndex}
                pageSize={historyPage.pageSize}
                hasPreviousPage={historyPage.pageIndex > 0}
                hasNextPage={Boolean(history.data?.nextCursor)}
                updating={history.isFetching && history.isPlaceholderData}
                onPageSizeChange={historyPage.setPageSize}
                onPreviousPage={historyPage.goPrev}
                onNextPage={() => {
                  if (history.data?.nextCursor) historyPage.goNext(history.data.nextCursor)
                }}
              />
            </div>
          </>
        )}
      </div>
    </Section>
  )
}

function AlertTable({
  items,
  canSilence,
}: {
  items: MonitorAlertItem[]
  canSilence: boolean
}) {
  return (
    <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>规则</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>触发值</TableHead>
            <TableHead>持续</TableHead>
            <TableHead>通知</TableHead>
            <TableHead>静默</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const state = alertStateTone(item.state)
            const opened = new Date(item.firedAt ?? item.conditionOpenedAt).getTime()
            const lasted = Math.max(0, Math.round((Date.now() - opened) / 1000))
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <p className='text-body font-semibold'>{item.ruleName}</p>
                  <p className='text-label text-muted-foreground'>
                    {item.metricKey ?? item.staleSource} · {item.scope}/{item.scopeId}
                  </p>
                </TableCell>
                <TableCell>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                </TableCell>
                <TableCell className='tabular-nums'>
                  {item.triggerValue == null ? '—' : item.triggerValue}
                  {item.threshold == null ? '' : ` / ${item.comparator ?? ''} ${item.threshold}`}
                </TableCell>
                <TableCell className='tabular-nums'>{formatDuration(lasted)}</TableCell>
                <TableCell>
                  <p className='text-body'>{noticeKindLabel(item.noticeKind)}</p>
                  <Link to='/notifications' search={{ tab: 'records', alertId: item.id }} className='text-label underline'>查看逐渠道投递结果</Link>
                </TableCell>
                <TableCell>
                  {item.silenceRemainingSeconds ? (
                    <p className='text-label'>剩余 {formatDuration(item.silenceRemainingSeconds)}</p>
                  ) : canSilence && item.state !== 'resolved' ? (
                    <SilenceControls alertId={item.id} />
                  ) : (
                    <span className='text-label text-muted-foreground'>—</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function SilenceControls({ alertId }: { alertId: string }) {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (durationSeconds: number) => silenceMonitorAlert(alertId, { durationSeconds }),
    onSuccess: async () => {
      toast.success('已静默通知')
      await client.invalidateQueries({ queryKey: ['monitoring'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '静默失败')
    },
  })
  return (
    <label className='flex items-center gap-2'>
      <span className='sr-only'>静默时长</span>
      <select
        className='h-9 rounded-md border border-input bg-background px-2 text-label'
        defaultValue=''
        disabled={mutation.isPending}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (!value) return
          mutation.mutate(value)
          event.target.value = ''
        }}
      >
        <option value=''>静默…</option>
        {SILENCE_OPTIONS.map((option) => (
          <option key={option.seconds} value={option.seconds}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
