import * as React from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'
import { Activity, Brain, Clock, ShieldAlert } from 'lucide-react'
import { fetchMonitorSeries } from '@/lib/monitoring-api'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { PageSkeleton } from '@/components/page-skeleton'
import { Section } from '../facts'

type TimeRangeOption = '1h' | '6h' | '24h' | '7d'

const RANGE_MILLIS: Record<TimeRangeOption, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

const runsChartConfig: ChartConfig = {
  'worker.capacity.used': {
    label: '并发 Run 水位',
    color: 'var(--chart-1)',
  },
  'queue.claimableRuns': {
    label: '待领取排队 Run',
    color: 'var(--chart-4)',
  },
  'queue.recovering': {
    label: '自愈恢复中 Run',
    color: 'var(--chart-3)',
  },
}

const backlogChartConfig: ChartConfig = {
  'queue.needsReview': {
    label: '待核查 Run',
    color: 'var(--chart-1)',
  },
  'queue.targetsWithBacklog': {
    label: '积压目标数',
    color: 'var(--chart-2)',
  },
  'queue.unclaimableRuns': {
    label: '无人可领 Run',
    color: 'var(--status-warning)',
  },
}

const anomaliesChartConfig: ChartConfig = {
  'evidence.pendingUpload': {
    label: '待上传证据',
    color: 'var(--chart-2)',
  },
  'evidence.uploadFailed': {
    label: '上传失败证据',
    color: 'var(--status-error)',
  },
  'lease.expiredActiveRunLeases': {
    label: '过期活跃租约',
    color: 'var(--status-warning)',
  },
}

const aiChartConfig: ChartConfig = {
  'ai.calls': {
    label: '模型调用次数',
    color: 'var(--chart-1)',
  },
  'ai.errors': {
    label: '调用失败数',
    color: 'var(--status-error)',
  },
}

export function MonitoringChartsGrid({ asOf }: { asOf: string }) {
  const [range, setRange] = React.useState<TimeRangeOption>('6h')

  const { fromIso, toIso } = React.useMemo(() => {
    const toDate = new Date(asOf)
    const fromDate = new Date(toDate.getTime() - RANGE_MILLIS[range])
    return {
      fromIso: fromDate.toISOString(),
      toIso: toDate.toISOString(),
    }
  }, [asOf, range])

  const runsKeys = 'worker.capacity.used,queue.claimableRuns,queue.recovering'
  const runsQuery = useQuery({
    queryKey: ['monitoring', 'series', 'runs', runsKeys, range],
    queryFn: () =>
      fetchMonitorSeries({
        keys: runsKeys,
        from: fromIso,
        to: toIso,
      }),
    placeholderData: keepPreviousData,
  })

  const backlogKeys = 'queue.needsReview,queue.targetsWithBacklog,queue.unclaimableRuns'
  const backlogQuery = useQuery({
    queryKey: ['monitoring', 'series', 'backlog', backlogKeys, range],
    queryFn: () =>
      fetchMonitorSeries({
        keys: backlogKeys,
        from: fromIso,
        to: toIso,
      }),
    placeholderData: keepPreviousData,
  })

  const anomalyKeys = 'evidence.pendingUpload,evidence.uploadFailed,lease.expiredActiveRunLeases'
  const anomalyQuery = useQuery({
    queryKey: ['monitoring', 'series', 'anomalies', anomalyKeys, range],
    queryFn: () =>
      fetchMonitorSeries({
        keys: anomalyKeys,
        from: fromIso,
        to: toIso,
      }),
    placeholderData: keepPreviousData,
  })

  const aiKeys = 'ai.calls,ai.errors'
  const aiQuery = useQuery({
    queryKey: ['monitoring', 'series', 'ai', aiKeys, range],
    queryFn: () =>
      fetchMonitorSeries({
        keys: aiKeys,
        from: fromIso,
        to: toIso,
      }),
    placeholderData: keepPreviousData,
  })

  const runsRows = React.useMemo(() => buildChartRows(runsQuery.data?.items ?? []), [runsQuery.data])
  const backlogRows = React.useMemo(() => buildChartRows(backlogQuery.data?.items ?? []), [backlogQuery.data])
  const anomalyRows = React.useMemo(() => buildChartRows(anomalyQuery.data?.items ?? []), [anomalyQuery.data])
  const aiRows = React.useMemo(() => buildChartRows(aiQuery.data?.items ?? []), [aiQuery.data])

  const totalPoints = runsRows.length + backlogRows.length + anomalyRows.length + aiRows.length

  const rangeButtons = (
    <div className="flex items-center rounded-md border border-border-card bg-surface-subtle p-0.5">
      <RangeButton active={range === '1h'} onClick={() => setRange('1h')}>
        1小时
      </RangeButton>
      <RangeButton active={range === '6h'} onClick={() => setRange('6h')}>
        6小时
      </RangeButton>
      <RangeButton active={range === '24h'} onClick={() => setRange('24h')}>
        24小时
      </RangeButton>
      <RangeButton active={range === '7d'} onClick={() => setRange('7d')}>
        7天
      </RangeButton>
    </div>
  )

  return (
    <Section title="趋势" action={rangeButtons}>
      {totalPoints === 0 && !runsQuery.isPending && (
        <p className="text-body text-muted-foreground">这个窗口没有样本，空洞不是 0。</p>
      )}

      {/* 2x2 四大核心时序图表大盘 */}
      <div className="grid gap-2.5 lg:grid-cols-2">
        {/* 图表 1: 运行并发与排队积压 */}
        <article className="rounded-lg border border-border-card bg-card p-3.5 shadow-card">
          <div className="flex items-center justify-between gap-2 pb-1">
            <div className="flex items-center gap-1.5">
              <Activity className="size-4 text-primary" aria-hidden />
              <h3 className="text-small font-semibold">运行并发与调度队列</h3>
            </div>
            <span className="text-label text-muted-foreground">单位: 个</span>
          </div>

          <div className="h-48 w-full pt-1">
            {runsQuery.isPending ? (
              <PageSkeleton rows={3} />
            ) : runsRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-label text-muted-foreground">
                这个窗口没有样本，空洞不是 0。
              </div>
            ) : (
              <ChartContainer config={runsChartConfig} className="h-full w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart syncId="monitoring-trends" data={runsRows} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      minTickGap={32}
                    />
                    <YAxis
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      allowDecimals={false}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Area
                      type="monotone"
                      dataKey="worker.capacity.used"
                      name={runsChartConfig['worker.capacity.used'].label as string}
                      stroke={runsChartConfig['worker.capacity.used'].color}
                      fill={runsChartConfig['worker.capacity.used'].color}
                      fillOpacity={0.15}
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="queue.claimableRuns"
                      name={runsChartConfig['queue.claimableRuns'].label as string}
                      stroke={runsChartConfig['queue.claimableRuns'].color}
                      fill={runsChartConfig['queue.claimableRuns'].color}
                      fillOpacity={0.1}
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="queue.recovering"
                      name={runsChartConfig['queue.recovering'].label as string}
                      stroke={runsChartConfig['queue.recovering'].color}
                      fill={runsChartConfig['queue.recovering'].color}
                      fillOpacity={0.05}
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartContainer>
            )}
          </div>
        </article>

        {/* 图表 2: 调度积压与作业排队 */}
        <article className="rounded-lg border border-border-card bg-card p-3.5 shadow-card">
          <div className="flex items-center justify-between gap-2 pb-1">
            <div className="flex items-center gap-1.5">
              <Clock className="size-4 text-tech-purple-primary" aria-hidden />
              <h3 className="text-small font-semibold">队列异常与目标积压</h3>
            </div>
            <span className="text-label text-muted-foreground">单位: 项</span>
          </div>

          <div className="h-48 w-full pt-1">
            {backlogQuery.isPending ? (
              <PageSkeleton rows={3} />
            ) : backlogRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-label text-muted-foreground">
                这个窗口没有样本，空洞不是 0。
              </div>
            ) : (
              <ChartContainer config={backlogChartConfig} className="h-full w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart syncId="monitoring-trends" data={backlogRows} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      minTickGap={32}
                    />
                    <YAxis
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      allowDecimals={false}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar
                      dataKey="queue.needsReview"
                      name={backlogChartConfig['queue.needsReview'].label as string}
                      fill={backlogChartConfig['queue.needsReview'].color}
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="queue.targetsWithBacklog"
                      name={backlogChartConfig['queue.targetsWithBacklog'].label as string}
                      fill={backlogChartConfig['queue.targetsWithBacklog'].color}
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="queue.unclaimableRuns"
                      name={backlogChartConfig['queue.unclaimableRuns'].label as string}
                      fill={backlogChartConfig['queue.unclaimableRuns'].color}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            )}
          </div>
        </article>

        {/* 图表 3: 证据上传与租约异常 */}
        <article className="rounded-lg border border-border-card bg-card p-3.5 shadow-card">
          <div className="flex items-center justify-between gap-2 pb-1">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="size-4 text-status-warning" aria-hidden />
              <h3 className="text-small font-semibold">证据上传与过期租约走势</h3>
            </div>
            <span className="text-label text-muted-foreground">单位: 项</span>
          </div>

          <div className="h-48 w-full pt-1">
            {anomalyQuery.isPending ? (
              <PageSkeleton rows={3} />
            ) : anomalyRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-label text-muted-foreground">
                这个窗口没有样本，空洞不是 0。
              </div>
            ) : (
              <ChartContainer config={anomaliesChartConfig} className="h-full w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart syncId="monitoring-trends" data={anomalyRows} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      minTickGap={32}
                    />
                    <YAxis
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      allowDecimals={false}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Line
                      type="monotone"
                      dataKey="evidence.pendingUpload"
                      name={anomaliesChartConfig['evidence.pendingUpload'].label as string}
                      stroke={anomaliesChartConfig['evidence.pendingUpload'].color}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="evidence.uploadFailed"
                      name={anomaliesChartConfig['evidence.uploadFailed'].label as string}
                      stroke={anomaliesChartConfig['evidence.uploadFailed'].color}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="lease.expiredActiveRunLeases"
                      name={anomaliesChartConfig['lease.expiredActiveRunLeases'].label as string}
                      stroke={anomaliesChartConfig['lease.expiredActiveRunLeases'].color}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartContainer>
            )}
          </div>
        </article>

        {/* 图表 4: AI 模型调用量与失败频次 */}
        <article className="rounded-lg border border-border-card bg-card p-3.5 shadow-card">
          <div className="flex items-center justify-between gap-2 pb-1">
            <div className="flex items-center gap-1.5">
              <Brain className="size-4 text-tech-purple-primary" aria-hidden />
              <h3 className="text-small font-semibold">AI 模型调用量与失败频次</h3>
            </div>
            <span className="text-label text-muted-foreground">单位: 次</span>
          </div>

          <div className="h-48 w-full pt-1">
            {aiQuery.isPending ? (
              <PageSkeleton rows={3} />
            ) : aiRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-label text-muted-foreground">
                这个窗口没有样本，空洞不是 0。
              </div>
            ) : (
              <ChartContainer config={aiChartConfig} className="h-full w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart syncId="monitoring-trends" data={aiRows} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      minTickGap={32}
                    />
                    <YAxis
                      stroke="var(--chart-axis)"
                      tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
                      allowDecimals={false}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar
                      dataKey="ai.calls"
                      name={aiChartConfig['ai.calls'].label as string}
                      fill={aiChartConfig['ai.calls'].color}
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="ai.errors"
                      name={aiChartConfig['ai.errors'].label as string}
                      fill={aiChartConfig['ai.errors'].color}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            )}
          </div>
        </article>
      </div>
    </Section>
  )
}

function RangeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      className="h-7 px-2.5 text-label"
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function buildChartRows(items: Array<{ key: string; points: Array<{ bucketAt: string; value: number }> }>) {
  const times = new Set<string>()
  for (const item of items) {
    for (const point of item.points) times.add(point.bucketAt)
  }

  return [...times]
    .sort()
    .map((bucketAt) => {
      const d = new Date(bucketAt)
      const timeStr = d.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

      const row: Record<string, string | number | null> = {
        bucketAt,
        time: timeStr,
      }

      for (const item of items) {
        row[item.key] = item.points.find((p) => p.bucketAt === bucketAt)?.value ?? null
      }
      return row
    })
}
