import {
  Activity,
  Bot,
  CheckCircle2,
  Globe,
  PlayCircle,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type {
  MonitoringOverviewResponse,
  OverviewAnalyticsResponse,
  SessionSystemOverviewResponse,
} from '@cairn/shared'

function extractMetricValue(
  metric:
    | { availability: 'known'; value: number }
    | { availability: 'unknown'; reason: unknown }
    | undefined
): number {
  return metric && metric.availability === 'known' ? metric.value : 0
}

export function HeroMetrics({
  analytics,
  monitoring,
  systems,
}: {
  analytics?: OverviewAnalyticsResponse
  monitoring?: MonitoringOverviewResponse
  systems?: SessionSystemOverviewResponse
}) {
  const summary = analytics?.summary

  // 1. 运行总数与环比
  const totalRuns = summary?.totalRuns ?? 0
  const runsDelta = summary?.runsDeltaPercentage

  // 2. 成功率
  const successRate = summary ? Math.round(summary.successRate * 1000) / 10 : 100
  const rateDelta = summary?.successRateDeltaPercentage

  // 3. AI 调用
  const aiPartition = monitoring?.partitions.ai
  const aiCalls = aiPartition?.availability === 'available'
    ? extractMetricValue(aiPartition.data.calls)
    : 0
  const aiInputTokens = aiPartition?.availability === 'available'
    ? extractMetricValue(aiPartition.data.inputTokens)
    : 0
  const aiOutputTokens = aiPartition?.availability === 'available'
    ? extractMetricValue(aiPartition.data.outputTokens)
    : 0
  const totalTokensK = Math.round((aiInputTokens + aiOutputTokens) / 1000)

  // 4. 目标系统与健康会话
  const targetCount = systems?.summary.systems ?? 0
  const readyAccounts = systems?.summary.readyAccounts ?? 0
  const totalAccounts =
    readyAccounts +
    (systems?.summary.problemAccounts ?? 0) +
    (systems?.summary.unpreparedAccounts ?? 0)
  const healthRate =
    totalAccounts > 0 ? Math.round((readyAccounts / totalAccounts) * 100) : 100

  // 5. 算力与节点
  const capacity = monitoring?.partitions.capacity
  const readyWorkers = capacity?.availability === 'available'
    ? extractMetricValue(capacity.data.workers.ready)
    : 0
  const totalWorkers = capacity?.availability === 'available'
    ? extractMetricValue(capacity.data.workers.ready) +
      extractMetricValue(capacity.data.workers.draining) +
      extractMetricValue(capacity.data.workers.stopped) +
      extractMetricValue(capacity.data.workers.lost)
    : 0
  const usedCapacity = capacity?.availability === 'available'
    ? extractMetricValue(capacity.data.capacity.used)
    : 0
  const totalCapacity = capacity?.availability === 'available'
    ? extractMetricValue(capacity.data.capacity.total)
    : 0
  const capacityPercent =
    totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0

  return (
    <section aria-label="核心指标统计" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {/* 1. 总运行数 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-small text-muted-foreground">累计执行总数</span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-600 dark:bg-primary-950/40">
            <PlayCircle size={18} aria-hidden />
          </span>
        </div>
        <div className="mt-3">
          <div className="text-stat font-semibold tabular-nums text-text-primary">
            {totalRuns.toLocaleString()}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-label text-muted-foreground">
            {runsDelta !== null && runsDelta !== undefined ? (
              <span
                className={`inline-flex items-center gap-0.5 font-medium ${
                  runsDelta >= 0 ? 'text-status-success' : 'text-status-error'
                }`}
              >
                {runsDelta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                {runsDelta >= 0 ? `+${runsDelta}%` : `${runsDelta}%`}
              </span>
            ) : (
              <span className="text-muted-foreground">基准周期</span>
            )}
            <span>对比上周期</span>
          </div>
        </div>
      </div>

      {/* 2. 综合执行成功率 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-small text-muted-foreground">综合执行成功率</span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-status-success-background text-status-success-foreground">
            <CheckCircle2 size={18} aria-hidden />
          </span>
        </div>
        <div className="mt-3">
          <div className="text-stat font-semibold tabular-nums text-text-primary">
            {successRate}%
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
            <div
              className="h-full rounded-full bg-status-success transition-[width] duration-300"
              style={{ width: `${Math.min(100, Math.max(0, successRate))}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-label text-muted-foreground">
            <span>
              {rateDelta !== null && rateDelta !== undefined ? (
                <span className={rateDelta >= 0 ? 'text-status-success' : 'text-status-error'}>
                  {rateDelta >= 0 ? `+${rateDelta}%` : `${rateDelta}%`}
                </span>
              ) : (
                '—'
              )}
            </span>
            <span>目标 ≥95%</span>
          </div>
        </div>
      </div>

      {/* 3. AI 智能步骤 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-small text-muted-foreground">AI 智能调用</span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-ai-background text-ai-foreground">
            <Bot size={18} aria-hidden />
          </span>
        </div>
        <div className="mt-3">
          <div className="text-stat font-semibold tabular-nums text-text-primary">
            {aiCalls.toLocaleString()} <span className="text-body font-normal text-muted-foreground">次</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-label text-muted-foreground">
            <span className="rounded bg-ai-background px-1.5 py-0.5 text-label font-medium text-ai-foreground">
              {totalTokensK > 0 ? `${totalTokensK}k Tokens` : '0 Tokens'}
            </span>
            <span>消耗吞吐</span>
          </div>
        </div>
      </div>

      {/* 4. 活跃系统与账号 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-small text-muted-foreground">目标系统与账号</span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-text-primary">
            <Globe size={18} aria-hidden />
          </span>
        </div>
        <div className="mt-3">
          <div className="text-stat font-semibold tabular-nums text-text-primary">
            {targetCount}{' '}
            <span className="text-body font-normal text-muted-foreground">
              系统 / {readyAccounts} 账号
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-label text-muted-foreground">
            <span className="font-medium text-text-primary">{healthRate}%</span>
            <span>健康就绪复用率</span>
          </div>
        </div>
      </div>

      {/* 5. 集群算力利用率 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-small text-muted-foreground">集群算力利用率</span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-text-primary">
            <Activity size={18} aria-hidden />
          </span>
        </div>
        <div className="mt-3">
          <div className="text-stat font-semibold tabular-nums text-text-primary">
            {capacityPercent}%
          </div>
          <div className="mt-1 flex items-center justify-between text-label text-muted-foreground">
            <span>
              就绪 {readyWorkers}/{totalWorkers} 节点
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-status-success" />
              就绪
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
