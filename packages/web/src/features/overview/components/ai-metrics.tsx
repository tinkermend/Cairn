import * as React from 'react'
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts'
import type { MonitoringOverviewResponse, MonitorSeriesResponse } from '@cairn/shared'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Bot } from 'lucide-react'

const aiCallConfig: ChartConfig = {
  calls: { label: '调用次数', color: 'var(--ai-accent)' },
  errors: { label: '失败次数', color: 'var(--status-error)' },
}

const tokenConfig: ChartConfig = {
  inputTokens: { label: 'Input Tokens', color: 'var(--chart-2)' },
  outputTokens: { label: 'Output Tokens', color: 'var(--ai-accent)' },
}

function extractMetricValue(
  metric:
    | { availability: 'known'; value: number }
    | { availability: 'unknown'; reason: unknown }
    | undefined
): number | null {
  return metric && metric.availability === 'known' ? metric.value : null
}

export function AiMetrics({
  monitoring,
  series,
}: {
  monitoring?: MonitoringOverviewResponse
  series?: MonitorSeriesResponse
}) {
  const aiPartition = monitoring?.partitions.ai
  const hasAiPartition = aiPartition?.availability === 'available'

  const durationP95 = hasAiPartition ? extractMetricValue(aiPartition.data.durationP95Ms) : null
  const aiErrors = hasAiPartition ? (extractMetricValue(aiPartition.data.errors) ?? 0) : 0
  const aiCalls = hasAiPartition ? (extractMetricValue(aiPartition.data.calls) ?? 0) : 0
  const aiErrorRate = aiCalls > 0 ? Math.round((aiErrors / aiCalls) * 100) : 0

  // 从 series 中解析时序数据
  const chartData = React.useMemo(() => {
    if (!series?.items?.length) return []
    const callsSeries = series.items.find((s) => s.key === 'ai.calls')?.points ?? []
    const errorsSeries = series.items.find((s) => s.key === 'ai.errors')?.points ?? []
    const inTokensSeries = series.items.find((s) => s.key === 'ai.inputTokens')?.points ?? []
    const outTokensSeries = series.items.find((s) => s.key === 'ai.outputTokens')?.points ?? []

    const times = new Set<string>()
    for (const p of [...callsSeries, ...inTokensSeries]) times.add(p.bucketAt)

    return Array.from(times)
      .sort()
      .map((bucketAt) => {
        const d = new Date(bucketAt)
        const displayTime = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`
        return {
          bucketAt,
          displayTime,
          calls: callsSeries.find((p) => p.bucketAt === bucketAt)?.value ?? 0,
          errors: errorsSeries.find((p) => p.bucketAt === bucketAt)?.value ?? 0,
          inputTokens: inTokensSeries.find((p) => p.bucketAt === bucketAt)?.value ?? 0,
          outputTokens: outTokensSeries.find((p) => p.bucketAt === bucketAt)?.value ?? 0,
        }
      })
  }, [series])

  return (
    <section aria-label="AI 认知洞察" className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* 左侧：AI 步骤调用量 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-5 shadow-card">
        <div className="flex items-center justify-between gap-2 pb-3">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="flex size-5 items-center justify-center rounded bg-ai-background text-ai-foreground">
                <Bot size={14} aria-hidden />
              </span>
              <h2 className="text-section font-semibold text-text-primary">
                AI 步骤调用时序
              </h2>
            </div>
            <p className="mt-0.5 text-label text-muted-foreground">
              监测场景执行中大模型意图理解与定位决策的调用量
            </p>
          </div>
          {hasAiPartition && (
            <div className="text-right">
              <span className="text-stat font-semibold tabular-nums text-text-primary">
                {durationP95 !== null ? `${Math.round(durationP95)}ms` : '—'}
              </span>
              <p className="text-label text-muted-foreground">P95 响应延迟</p>
            </div>
          )}
        </div>

        <div className="h-[220px] w-full pt-2">
          {chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-body text-muted-foreground">
              {hasAiPartition ? '当前采样窗口暂无 AI 调用记录' : 'AI 监控账本就绪中'}
            </div>
          ) : (
            <ChartContainer config={aiCallConfig} className="h-full w-full">
              <ComposedChart
                data={chartData}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border-divider)" />
                <XAxis dataKey="displayTime" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis tickLine={false} axisLine={false} tickMargin={8} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="calls" name="调用次数" fill="var(--ai-accent)" radius={[3, 3, 0, 0]} />
                <Line
                  type="monotone"
                  dataKey="errors"
                  name="失败次数"
                  stroke="var(--status-error)"
                  strokeWidth={2}
                  dot={false}
                />
                <ChartLegend content={<ChartLegendContent />} />
              </ComposedChart>
            </ChartContainer>
          )}
        </div>
      </div>

      {/* 右侧：Token 消耗吞吐面积图 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-5 shadow-card">
        <div className="flex items-center justify-between gap-2 pb-3">
          <div>
            <h2 className="text-section font-semibold text-text-primary">
              Token 吞吐量与模型开销
            </h2>
            <p className="mt-0.5 text-label text-muted-foreground">
              Prompt 输入与模型输出 Token 趋势（支持成本回溯）
            </p>
          </div>
          {hasAiPartition && (
            <div className="text-right">
              <span className="text-stat font-semibold tabular-nums text-text-primary">
                {`${aiErrorRate}%`}
              </span>
              <p className="text-label text-muted-foreground">AI 步骤失败率</p>
            </div>
          )}
        </div>

        <div className="h-[220px] w-full pt-2">
          {chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-body text-muted-foreground">
              {hasAiPartition ? '当前采样窗口暂无 Token 消耗' : 'AI 监控账本就绪中'}
            </div>
          ) : (
            <ChartContainer config={tokenConfig} className="h-full w-full">
              <AreaChart
                data={chartData}
                margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="tokenInGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0.01} />
                  </linearGradient>
                  <linearGradient id="tokenOutGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--ai-accent)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--ai-accent)" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border-divider)" />
                <XAxis dataKey="displayTime" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(val) => (val >= 1000 ? `${Math.round(val / 1000)}k` : val)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="inputTokens"
                  name="Input Tokens"
                  stroke="var(--chart-2)"
                  fill="url(#tokenInGrad)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="outputTokens"
                  name="Output Tokens"
                  stroke="var(--ai-accent)"
                  fill="url(#tokenOutGrad)"
                  strokeWidth={2}
                />
                <ChartLegend content={<ChartLegendContent />} />
              </AreaChart>
            </ChartContainer>
          )}
        </div>
      </div>
    </section>
  )
}
