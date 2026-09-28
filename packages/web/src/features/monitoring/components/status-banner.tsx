import * as React from 'react'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  MAX_ALERT_SILENCE_SECONDS,
  MIN_ALERT_SILENCE_SECONDS,
} from '@cairn/shared'
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  VolumeX,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMonitorAlerts, silenceMonitorAlert } from '@/lib/monitoring-api'
import { useCan } from '@/hooks/use-permissions'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Button } from '@/components/ui/button'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { StatusBadge } from '@/components/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CursorPagination } from '@/components/data-table'
import {
  alertStateTone,
  formatDuration,
  noticeKindLabel,
} from '../labels'

const SILENCE_OPTIONS = [
  { seconds: MIN_ALERT_SILENCE_SECONDS, label: '5 分钟' },
  { seconds: 3_600, label: '1 小时' },
  { seconds: MAX_ALERT_SILENCE_SECONDS, label: '24 小时' },
] as const

export function PlatformHealthBadge() {
  const activePage = useCursorPage(10, 'monitoring-alert-badge')
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

  if (active.isPending) {
    return <StatusBadge tone="neutral">检查中…</StatusBadge>
  }

  const items = active.data?.items ?? []
  if (items.length === 0) {
    return (
      <StatusBadge tone="success" className="font-medium">
        运行健康
        <span className="sr-only"> · 当前没有未恢复告警</span>
      </StatusBadge>
    )
  }

  const hasCritical = items.some((i) => i.severity === 'critical')
  return (
    <StatusBadge tone={hasCritical ? 'error' : 'warning'} className="font-medium">
      {items.length} 条告警
    </StatusBadge>
  )
}

export function StatusBanner() {
  const canSilence = useCan('monitor:operate')
  const canReadConfig = useCan('platform-config:read')
  const [expanded, setExpanded] = React.useState(false)

  const activePage = useCursorPage(10, 'monitoring-alert-banner')
  const active = useQuery({
    queryKey: [
      'monitoring',
      'alerts',
      'active',
      activePage.pageSize,
      activePage.cursor,
    ],
    queryFn: () =>
      fetchMonitorAlerts({
        view: 'active',
        limit: activePage.pageSize,
        cursor: activePage.cursor,
      }),
    placeholderData: keepPreviousData,
  })

  const alertItems = active.data?.items ?? []
  const hasActiveAlerts = alertItems.length > 0

  const [severityFilter, setSeverityFilter] = React.useState<'all' | 'critical' | 'warning'>('all')
  const criticalCount = alertItems.filter((i) => i.severity === 'critical').length
  const warningCount = alertItems.filter((i) => i.severity === 'warning').length

  const filteredAlertItems = React.useMemo(() => {
    if (severityFilter === 'all') return alertItems
    return alertItems.filter((i) => i.severity === severityFilter)
  }, [alertItems, severityFilter])

  if (active.isPending) {
    return null
  }

  // 场景 A：无未恢复告警 —— 顶部已通过 PlatformHealthBadge 呈现状态图标，无告警时不再渲染横条
  if (!hasActiveAlerts && !active.isError) {
    return <span className="sr-only">当前没有未恢复告警</span>
  }

  // 场景 B：存在未恢复告警 —— 高亮警示条，支持展开
  return (
    <div className="rounded-lg border border-status-error/40 bg-status-error/10 p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-status-error" aria-hidden />
          <span className="text-body font-semibold text-status-error">
            发现 {alertItems.length} 条未恢复告警
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canReadConfig && (
            <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-label" asChild>
              <Link to="/outbound" search={{ tab: 'alerts' }}>
                配置规则
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-label"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <>
                收起明细
                <ChevronUp className="size-3.5" />
              </>
            ) : (
              <>
                查看明细 ({alertItems.length})
                <ChevronDown className="size-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-divider bg-surface-subtle px-3 py-1.5 text-label">
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-muted-foreground">级别筛选:</span>
              <Button
                variant={severityFilter === 'all' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-label"
                onClick={() => setSeverityFilter('all')}
              >
                全部 ({alertItems.length})
              </Button>
              <Button
                variant={severityFilter === 'critical' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-label text-status-error"
                onClick={() => setSeverityFilter('critical')}
              >
                严重 ({criticalCount})
              </Button>
              <Button
                variant={severityFilter === 'warning' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-label text-status-warning"
                onClick={() => setSeverityFilter('warning')}
              >
                警告 ({warningCount})
              </Button>
            </div>
            <span className="text-label text-muted-foreground">共 {filteredAlertItems.length} 项</span>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>规则名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>触发值 / 阈值</TableHead>
                <TableHead>持续时间</TableHead>
                <TableHead>推送渠道</TableHead>
                <TableHead>静默抑制</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAlertItems.map((item) => {
                const state = alertStateTone(item.state)
                const opened = new Date(
                  item.firedAt ?? item.conditionOpenedAt
                ).getTime()
                const lasted = Math.max(0, Math.round((Date.now() - opened) / 1000))
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-body font-semibold">{item.ruleName}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-label font-medium ${
                            item.severity === 'critical'
                              ? 'bg-status-error/15 text-status-error'
                              : 'bg-status-warning/15 text-status-warning'
                          }`}
                        >
                          {item.severity === 'critical' ? '严重' : '警告'}
                        </span>
                      </div>
                      <p className="text-label text-muted-foreground">
                        {item.metricKey ?? item.staleSource} · {item.scope}/{item.scopeId}
                      </p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {item.triggerValue == null ? '—' : item.triggerValue}
                      {item.threshold == null ? '' : ` / ${item.comparator ?? ''} ${item.threshold}`}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatDuration(lasted)}
                    </TableCell>
                    <TableCell>
                      <p className="text-body">{noticeKindLabel(item.noticeKind)}</p>
                      <Link
                        to="/outbound"
                        search={{ tab: 'records', alertId: item.id }}
                        className="text-label underline"
                      >
                        投递结果
                      </Link>
                    </TableCell>
                    <TableCell>
                      {item.silenceRemainingSeconds ? (
                        <p className="text-label text-muted-foreground">
                          静默中 ({formatDuration(item.silenceRemainingSeconds)})
                        </p>
                      ) : canSilence && item.state !== 'resolved' ? (
                        <SilenceControls alertId={item.id} />
                      ) : (
                        <span className="text-label text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>

          {alertItems.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-divider px-3 py-2 text-label">
              <span className="text-muted-foreground">显示 {alertItems.length} 条</span>
              <CursorPagination
                pageIndex={activePage.pageIndex}
                pageSize={activePage.pageSize}
                hasPreviousPage={activePage.pageIndex > 0}
                hasNextPage={Boolean(active.data?.nextCursor)}
                updating={active.isFetching && active.isPlaceholderData}
                onPageSizeChange={activePage.setPageSize}
                onPreviousPage={activePage.goPrev}
                onNextPage={() => {
                  if (active.data?.nextCursor) activePage.goNext(active.data.nextCursor)
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SilenceControls({ alertId }: { alertId: string }) {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (durationSeconds: number) =>
      silenceMonitorAlert(alertId, { durationSeconds }),
    onSuccess: async () => {
      toast.success('已静默推送')
      await client.invalidateQueries({ queryKey: ['monitoring'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '静默失败')
    },
  })

  return (
    <label className="flex items-center gap-1.5">
      <VolumeX className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="sr-only">静默时长</span>
      <SelectField
        className="w-auto h-7 text-label"
        value=""
        disabled={mutation.isPending}
        onValueChange={(selection) => {
          const value = Number(selection)
          if (!value) return
          mutation.mutate(value)
        }}
      >
        <SelectFieldOption value="">静默…</SelectFieldOption>
        {SILENCE_OPTIONS.map((option) => (
          <SelectFieldOption key={option.seconds} value={option.seconds}>
            {option.label}
          </SelectFieldOption>
        ))}
      </SelectField>
    </label>
  )
}
