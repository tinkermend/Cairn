import * as React from 'react'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts'
import type { OverviewTimelinePoint } from '@cairn/shared'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Button } from '@/components/ui/button'

const chartConfig: ChartConfig = {
  succeeded: {
    label: '执行成功',
    color: 'var(--chart-1)',
  },
  failed: {
    label: '执行失败',
    color: 'var(--status-error)',
  },
  timedOut: {
    label: '执行超时',
    color: 'var(--status-warning)',
  },
  canceled: {
    label: '手动取消',
    color: 'var(--chart-3)',
  },
  successRate: {
    label: '成功率 (%)',
    color: 'var(--status-success)',
  },
}

export function ExecutionChart({
  timeline,
  range,
}: {
  timeline: OverviewTimelinePoint[]
  range: '24h' | '7d' | '30d'
}) {
  const [chartType, setChartType] = React.useState<'area' | 'bar'>('area')

  const chartData = React.useMemo(() => {
    return timeline.map((pt) => {
      const d = new Date(pt.bucketAt)
      let timeLabel = ''
      if (range === '24h') {
        timeLabel = d.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      } else {
        timeLabel = d.toLocaleDateString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
        })
      }
      return {
        ...pt,
        displayTime: timeLabel,
        ratePercent: Math.round(pt.successRate * 100),
      }
    })
  }, [timeline, range])

  return (
    <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4">
        <div>
          <h2 className="text-section font-semibold text-text-primary">
            执行态势与成功率走势
          </h2>
          <p className="mt-0.5 text-label text-muted-foreground">
            {range === '24h' ? '按 1 小时' : '按天'}
            时序展示运行总量、失败与超时峰值，叠加综合成功率趋势
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border-card p-0.5 bg-surface-subtle">
          <Button
            size="sm"
            variant={chartType === 'area' ? 'secondary' : 'ghost'}
            className="h-7 px-2.5 text-label"
            onClick={() => setChartType('area')}
          >
            平滑面积
          </Button>
          <Button
            size="sm"
            variant={chartType === 'bar' ? 'secondary' : 'ghost'}
            className="h-7 px-2.5 text-label"
            onClick={() => setChartType('bar')}
          >
            堆叠柱状
          </Button>
        </div>
      </div>

      <div className="h-[280px] w-full pt-2">
        <ChartContainer config={chartConfig} className="h-full w-full">
          {chartType === 'area' ? (
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="succeededGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.01} />
                </linearGradient>
                <linearGradient id="failedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--status-error)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--status-error)" stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border-divider)" />
              <XAxis
                dataKey="displayTime"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize="var(--font-size-label)"
              />
              <YAxis
                yAxisId="left"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                allowDecimals={false}
                fontSize="var(--font-size-label)"
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 100]}
                hide
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(val, p) => p?.[0]?.payload?.displayTime ?? String(val)}
                  />
                }
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="succeeded"
                name="执行成功"
                stroke="var(--chart-1)"
                fill="url(#succeededGrad)"
                strokeWidth={2}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="failed"
                name="执行失败"
                stroke="var(--status-error)"
                fill="url(#failedGrad)"
                strokeWidth={2}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="ratePercent"
                name="成功率 (%)"
                stroke="var(--status-success)"
                strokeWidth={2}
                dot={false}
                strokeDasharray="4 4"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </ComposedChart>
          ) : (
            <BarChart
              data={chartData}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border-divider)" />
              <XAxis
                dataKey="displayTime"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize="var(--font-size-label)"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                allowDecimals={false}
                fontSize="var(--font-size-label)"
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(val, p) => p?.[0]?.payload?.displayTime ?? String(val)}
                  />
                }
              />
              <Bar
                dataKey="succeeded"
                name="执行成功"
                stackId="a"
                fill="var(--chart-1)"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="failed"
                name="执行失败"
                stackId="a"
                fill="var(--status-error)"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="timedOut"
                name="执行超时"
                stackId="a"
                fill="var(--status-warning)"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="canceled"
                name="手动取消"
                stackId="a"
                fill="var(--chart-3)"
                radius={[4, 4, 0, 0]}
              />
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          )}
        </ChartContainer>
      </div>
    </div>
  )
}
