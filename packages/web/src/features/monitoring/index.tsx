import { Link } from '@tanstack/react-router'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import type { MonitoringOverviewResponse } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { FailureAlert } from './facts'
import {
  formatAsOf,
  freshnessLabel,
  partitionFailure,
  type RefreshIntervalSeconds,
} from './labels'
import { connectionLabel, useMonitoringObservation } from './use-monitoring-observation'
import { PlatformHealthBadge, StatusBanner } from './components/status-banner'
import { CapacityOverview } from './components/capacity-overview'
import { InfrastructureGrid } from './components/infrastructure-grid'
import { MonitoringChartsGrid } from './components/monitoring-charts-grid'
import {
  AiSection,
  AnomaliesSection,
  QueuesSection,
} from './components/operational-metrics'
import {
  ProfilesSection,
  WorkersSection,
} from './components/drilldown-sections'

export function MonitoringPage() {
  const {
    overview,
    connection,
    autoRefresh,
    setAutoRefresh,
    refreshInterval,
    setRefreshInterval,
    refresh,
  } = useMonitoringObservation()
  const canReadWorkers = useCan('session:read')
  const canProbe = useCan('monitor:operate')
  const canReadConfig = useCan('platform-config:read')

  return (
    <Main className="flex min-w-0 flex-1 flex-col gap-4">
      <PageHeader
        title="监控"
        description="平台自有服务健康度、容量水位与运行队列时序态势大盘。"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {/* 时间指示 (紧凑置于自动刷新前，移除可见的描述性口径杂音) */}
            {overview.data?.asOf && (
              <span className="text-label text-muted-foreground">
                截至 {formatAsOf(overview.data.asOf)}
                <span className="sr-only">此刻的事实</span>
              </span>
            )}

            {/* 自动刷新开关与可配置间隔 (15s/30s/60s/120s) */}
            <div className="flex items-center gap-2">
              <Switch
                id="monitor-auto-refresh"
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
              />
              <Label htmlFor="monitor-auto-refresh">自动刷新</Label>
              <Select
                value={String(refreshInterval)}
                onValueChange={(val) => setRefreshInterval(Number(val) as RefreshIntervalSeconds)}
                disabled={!autoRefresh}
              >
                <SelectTrigger size="sm" className="h-7 w-[78px] text-label font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15秒</SelectItem>
                  <SelectItem value="30">30秒</SelectItem>
                  <SelectItem value="60">60秒</SelectItem>
                  <SelectItem value="120">120秒</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 平台健康状态（图标状态，健康绿色/警告橙色/异常红色，不占横条） */}
            <PlatformHealthBadge />

            {/* 连接状态 */}
            <StatusBadge tone={connection === 'live' ? 'success' : connection === 'forbidden' ? 'error' : 'neutral'}>
              {connectionLabel(connection)}
            </StatusBadge>

            {/* 刷新 */}
            <Button onClick={() => void refresh()} variant="outline">
              <RefreshCw className="size-4" />
              刷新
            </Button>

            {/* 配置规则 (放在顶部刷新旁) */}
            {canReadConfig && (
              <Button variant="outline" asChild>
                <Link to="/notifications" search={{ tab: 'alerts' }}>
                  配置规则
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            )}
          </div>
        }
      />
      {overview.isPending ? (
        <PageSkeleton />
      ) : overview.isError ? (
        overviewError(overview.error, () => void refresh())
      ) : overview.data ? (
        <MonitoringBody
          snapshot={overview.data}
          canReadWorkers={canReadWorkers}
          canProbe={canProbe}
        />
      ) : null}
    </Main>
  )
}

function overviewError(error: unknown, onRetry: () => void) {
  if (error instanceof ApiRequestError && error.status === 403) {
    return <FailureAlert kind="permission" description="当前账号没有监控读取权限。" />
  }
  return (
    <QueryErrorState
      title="监控数据读取失败"
      description="无法读取监控快照。当前筛选会保留，可以重试。"
      onRetry={onRetry}
    />
  )
}

function MonitoringBody({
  snapshot,
  canReadWorkers,
  canProbe,
}: {
  snapshot: MonitoringOverviewResponse
  canReadWorkers: boolean
  canProbe: boolean
}) {
  const { service, capacity, queues, anomalies, ai } = snapshot.partitions

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {/* 1. 动态告警横幅（仅在存在未恢复告警时展示，日常健康时不占空间） */}
      <StatusBanner />

      {/* 2. 核心服务连通状态 (紧凑高密度卡片) */}
      {service.availability === 'available' ? (
        <InfrastructureGrid
          data={service.data}
          freshness={freshnessLabel(service.source, service.sampledAt)}
          canProbe={canProbe}
        />
      ) : (
        <FailureAlert {...partitionFailure(service.reasonCode)} />
      )}

      {/* 3. 核心容量水位与舰队看板 */}
      {capacity.availability === 'available' ? (
        <CapacityOverview
          data={capacity.data}
          freshness={freshnessLabel(capacity.source, capacity.sampledAt)}
        />
      ) : (
        <FailureAlert {...partitionFailure(capacity.reasonCode)} />
      )}

      {/* 5. 核心大盘：2x2 四大时序图表网格 */}
      <MonitoringChartsGrid asOf={snapshot.asOf} />

      {/* 6. 紧凑型运维指标矩阵 */}
      <QueuesSection partition={queues} />
      <AnomaliesSection partition={anomalies} />
      <AiSection partition={ai} />

      {/* 7. 执行节点列表 */}
      {capacity.availability === 'available' ? (
        <WorkersSection partition={capacity.data} canReadWorkers={canReadWorkers} />
      ) : null}

      {/* 8. 浏览器与 Profile */}
      <ProfilesSection />
    </div>
  )
}
