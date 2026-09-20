import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { OverviewTimeRange } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { fetchOverviewAnalytics } from '@/lib/overview-api'
import { fetchMonitoringOverview, fetchMonitorSeries } from '@/lib/monitoring-api'
import { fetchSessionSystemOverview } from '@/lib/sessions-api'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { HeroMetrics } from './components/hero-metrics'
import { ExecutionChart } from './components/execution-chart'
import { OutcomesDonut } from './components/outcomes-donut'
import { AiMetrics } from './components/ai-metrics'
import { ScenarioRankings } from './components/scenario-rankings'
import { TargetReadiness } from './components/target-readiness'
import { FleetResilience } from './components/fleet-resilience'

export function OverviewPage() {
  const user = useAuthStore((s) => s.auth.user)
  const greeting = user?.displayName ? `你好，${user.displayName}` : '你好'

  const [range, setRange] = React.useState<OverviewTimeRange>('7d')
  const [autoRefresh, setAutoRefresh] = React.useState(false)

  const queryClient = useQueryClient()

  // 1. 业务执行分析
  const analyticsQuery = useQuery({
    queryKey: ['overview-analytics', range],
    queryFn: () => fetchOverviewAnalytics({ range }),
    refetchInterval: autoRefresh ? 30_000 : false,
  })

  // 2. 运行监控总体态势
  const monitoringQuery = useQuery({
    queryKey: ['monitoring-overview'],
    queryFn: fetchMonitoringOverview,
    refetchInterval: autoRefresh ? 30_000 : false,
  })

  // 3. AI 时序指标采样
  const aiSeriesQuery = useQuery({
    queryKey: ['monitoring-series', 'ai', range],
    queryFn: () =>
      fetchMonitorSeries({
        keys: 'ai.calls,ai.errors,ai.inputTokens,ai.outputTokens',
      }),
    refetchInterval: autoRefresh ? 30_000 : false,
  })

  // 4. 目标系统与会话健康
  const systemsQuery = useQuery({
    queryKey: ['session-system-overview'],
    queryFn: () => fetchSessionSystemOverview(),
    refetchInterval: autoRefresh ? 30_000 : false,
  })

  const isRefreshing =
    analyticsQuery.isFetching ||
    monitoringQuery.isFetching ||
    systemsQuery.isFetching

  const handleRefresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['overview-analytics'] }),
      queryClient.invalidateQueries({ queryKey: ['monitoring-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['monitoring-series'] }),
      queryClient.invalidateQueries({ queryKey: ['session-system-overview'] }),
    ])
  }

  const isLoading = analyticsQuery.isLoading && !analyticsQuery.data

  return (
    <Main className="flex min-w-0 flex-1 flex-col gap-6">
      <PageHeader
        title={greeting}
        description="识途是面向真实 Web 系统的智能仿真与执行平台。以下是当前执行态势、业务成果断言与算力底座全景总览。"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {/* 时间跨度切换 */}
            <div className="flex items-center gap-1 rounded-md border border-border-card bg-surface-subtle p-0.5">
              {(['24h', '7d', '30d'] as const).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={range === r ? 'secondary' : 'ghost'}
                  className="h-7 px-3 text-label"
                  onClick={() => setRange(r)}
                >
                  {r === '24h' ? '24小时' : r === '7d' ? '近7天' : '近30天'}
                </Button>
              ))}
            </div>

            {/* 自动刷新开关 */}
            <div className="flex items-center gap-2">
              <Switch
                id="overview-auto-refresh"
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
              />
              <Label htmlFor="overview-auto-refresh" className="cursor-pointer text-label text-muted-foreground">
                自动刷新
              </Label>
            </div>

            {/* 手动刷新 */}
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              disabled={isRefreshing}
              onClick={() => void handleRefresh()}
            >
              <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
              <span>刷新</span>
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <PageSkeleton />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Zone 1: 核心价值 KPI 卡片行 */}
          <HeroMetrics
            analytics={analyticsQuery.data}
            monitoring={monitoringQuery.data}
            systems={systemsQuery.data}
          />

          {/* Zone 2: 执行态势大盘与结构分布 (2:1 宽窄栅格) */}
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ExecutionChart
                timeline={analyticsQuery.data?.timeline ?? []}
                range={range}
              />
            </div>
            <div className="lg:col-span-1">
              <OutcomesDonut
                outcomes={analyticsQuery.data?.outcomes}
                triggers={analyticsQuery.data?.triggers}
              />
            </div>
          </section>

          {/* Zone 3: AI 认知与大模型洞察 (并排 2 列) */}
          <AiMetrics
            monitoring={monitoringQuery.data}
            series={aiSeriesQuery.data}
          />

          {/* Zone 4: 业务资产排行榜与目标系统就绪矩阵 (并排 2 列) */}
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ScenarioRankings
              topScenarios={analyticsQuery.data?.topScenarios}
              troubledScenarios={analyticsQuery.data?.troubledScenarios}
            />
            <TargetReadiness systems={systemsQuery.data} />
          </section>

          {/* Zone 5: 底部底座韧性状态条 */}
          <FleetResilience monitoring={monitoringQuery.data} />
        </div>
      )}
    </Main>
  )
}
