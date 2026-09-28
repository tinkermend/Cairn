import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowUpRight,
  Bot,
  Check,
  Clock,
  Crosshair,
  Layers,
  Server,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react'
import type {
  MonitorCapacityCard,
  MonitoringOverviewResponse,
} from '@cairn/shared'
import { fetchAiModels, fetchTargetSla } from '@/lib/monitoring-api'
import { fetchWorkers } from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageSkeleton } from '@/components/page-skeleton'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { StatusBadge } from '@/components/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  classifyWorkerRole,
  workerLifecycle,
  WORKER_ROLE_METAS,
  type WorkerRoleCategory,
} from '@/features/workers/labels'
import { FailureAlert, Section } from '../facts'
import { formatBytes, formatMetric, permissionFailure } from '../labels'
import { AnomaliesSection, QueuesSection } from './operational-metrics'

export function DrilldownTabs({
  capacity,
  queues,
  anomalies,
  canReadWorkers,
}: {
  capacity: MonitorCapacityCard
  queues: MonitoringOverviewResponse['partitions']['queues']
  anomalies: MonitoringOverviewResponse['partitions']['anomalies']
  canReadWorkers: boolean
}) {
  const [activeTab, setActiveTab] = React.useState('target-sla')

  return (
    <Section title="分类下钻专区">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="mb-3">
          <TabsTrigger value="target-sla" className="gap-1.5">
            <Crosshair className="size-3.5" />
            目标系统 SLA
          </TabsTrigger>
          <TabsTrigger value="workers" className="gap-1.5">
            <Server className="size-3.5" />
            Worker 节点与沙箱
          </TabsTrigger>
          <TabsTrigger value="ai-models" className="gap-1.5">
            <Bot className="size-3.5" />
            AI 模型治理
          </TabsTrigger>
          <TabsTrigger value="queues-anomalies" className="gap-1.5">
            <ShieldAlert className="size-3.5" />
            队列与租约守卫
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: 目标系统 SLA */}
        <TabsContent value="target-sla">
          <TargetSlaTab />
        </TabsContent>

        {/* Tab 2: Worker 节点与沙箱 */}
        <TabsContent value="workers">
          <WorkersTab capacity={capacity} canReadWorkers={canReadWorkers} />
        </TabsContent>

        {/* Tab 3: AI 模型工程治理 */}
        <TabsContent value="ai-models">
          <AiModelsTab />
        </TabsContent>

        {/* Tab 4: 队列与租约守卫 */}
        <TabsContent value="queues-anomalies" className="space-y-4">
          <QueuesSection partition={queues} />
          <AnomaliesSection partition={anomalies} />
        </TabsContent>
      </Tabs>
    </Section>
  )
}

function TargetSlaTab() {
  const query = useQuery({
    queryKey: ['monitoring', 'targets', 'sla'],
    queryFn: () => fetchTargetSla(),
  })

  if (query.isPending) return <PageSkeleton rows={4} />

  const items = query.data?.items ?? []
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border-card bg-card p-8 text-center text-muted-foreground">
        暂无已配置的目标系统或近 24 小时无执行记录。
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[28%] text-label font-medium">目标系统</TableHead>
            <TableHead className="w-[14%] text-label font-medium">24h 运行量</TableHead>
            <TableHead className="w-[22%] text-label font-medium">执行通过率</TableHead>
            <TableHead className="w-[12%] text-label font-medium">失败数</TableHead>
            <TableHead className="w-[12%] text-label font-medium">P95 耗时</TableHead>
            <TableHead className="w-[12%] text-right text-label font-medium">账号池健康度</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const isOptimal = item.successRate >= 95
            const isWarning = item.successRate >= 80 && item.successRate < 95
            const rateColor = isOptimal
              ? 'bg-status-success'
              : isWarning
                ? 'bg-status-warning'
                : 'bg-status-error'

            const rateTextColor = isOptimal
              ? 'text-status-success-foreground'
              : isWarning
                ? 'text-status-warning-foreground'
                : 'text-status-error-foreground'

            const allAccountsActive = item.totalAccounts > 0 && item.activeAccounts === item.totalAccounts
            const hasActiveAccounts = item.activeAccounts > 0

            return (
              <TableRow key={item.targetId} className="h-11 transition-colors hover:bg-muted/20">
                <TableCell className="font-medium text-foreground">
                  <div className="flex items-center gap-2">
                    <Crosshair className="size-4 text-tech-purple-primary shrink-0" />
                    <span className="font-medium">{item.targetName}</span>
                  </div>
                </TableCell>
                <TableCell className="font-mono tabular-nums text-foreground">{item.totalRuns}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Progress value={item.successRate} className="h-2 w-24" indicatorClassName={rateColor} />
                    <span className={cn('font-mono text-label font-bold tabular-nums', rateTextColor)}>
                      {item.successRate}%
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {item.failedRuns > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 rounded-full border border-status-error/30 bg-status-error-background px-2 font-mono text-label font-bold text-status-error-foreground hover:bg-status-error-background/80"
                      asChild
                    >
                      <Link to="/runs" search={{ targetId: item.targetId, status: 'FAILED' }}>
                        {item.failedRuns} 次
                        <ArrowUpRight className="size-3" />
                      </Link>
                    </Button>
                  ) : (
                    <span className="font-mono text-muted-foreground/50">0</span>
                  )}
                </TableCell>
                <TableCell className="font-mono tabular-nums text-foreground">
                  {item.p95DurationMs != null ? `${(item.p95DurationMs / 1000).toFixed(1)}s` : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1.5 font-mono tabular-nums text-foreground">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        allAccountsActive
                          ? 'bg-status-success'
                          : hasActiveAccounts
                            ? 'bg-status-warning'
                            : 'bg-muted-foreground/40'
                      )}
                      aria-hidden
                    />
                    <span>{item.activeAccounts}/{item.totalAccounts} 活跃</span>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function WorkersTab({
  capacity,
  canReadWorkers,
}: {
  capacity: MonitorCapacityCard
  canReadWorkers: boolean
}) {
  const page = useCursorPage(20, 'monitoring-workers')
  const query = useQuery({
    queryKey: ['monitoring', 'workers', page.pageSize, page.cursor],
    queryFn: () => fetchWorkers({ limit: page.pageSize, cursor: page.cursor, heartbeatFresh: undefined }),
    enabled: canReadWorkers,
  })

  const [selectedRole, setSelectedRole] = React.useState<WorkerRoleCategory | 'all'>('all')

  // 映射硬件采样
  const sampleMap = React.useMemo(
    () => new Map(capacity.workerSamples.items.map((s) => [s.workerId, s])),
    [capacity.workerSamples.items],
  )

  const workers = query.data?.items ?? []


  // 按角色归类
  const workersByRole = React.useMemo(() => {
    const groups: Record<WorkerRoleCategory, typeof workers> = {
      executor: [],
      scheduler: [],
      analyst: [],
      maintenance: [],
      monolithic: [],
    }
    for (const w of workers) {
      const role = classifyWorkerRole(w.workerId)
      groups[role].push(w)
    }
    return groups
  }, [workers])

  // 角色概览聚合统计
  const roleSummaries = React.useMemo(() => {
    const out: Record<
      WorkerRoleCategory,
      {
        total: number
        ready: number
        stopped: number
        abnormal: number
        occupiedSlots: number
        totalSlots: number
        slotPercent: number
        browserCount: number
        crashCount: number
        avgCpu: number | null
        avgRssBytes: number | null
      }
    > = {
      executor: { total: 0, ready: 0, stopped: 0, abnormal: 0, occupiedSlots: 0, totalSlots: 0, slotPercent: 0, browserCount: 0, crashCount: 0, avgCpu: null, avgRssBytes: null },
      scheduler: { total: 0, ready: 0, stopped: 0, abnormal: 0, occupiedSlots: 0, totalSlots: 0, slotPercent: 0, browserCount: 0, crashCount: 0, avgCpu: null, avgRssBytes: null },
      analyst: { total: 0, ready: 0, stopped: 0, abnormal: 0, occupiedSlots: 0, totalSlots: 0, slotPercent: 0, browserCount: 0, crashCount: 0, avgCpu: null, avgRssBytes: null },
      maintenance: { total: 0, ready: 0, stopped: 0, abnormal: 0, occupiedSlots: 0, totalSlots: 0, slotPercent: 0, browserCount: 0, crashCount: 0, avgCpu: null, avgRssBytes: null },
      monolithic: { total: 0, ready: 0, stopped: 0, abnormal: 0, occupiedSlots: 0, totalSlots: 0, slotPercent: 0, browserCount: 0, crashCount: 0, avgCpu: null, avgRssBytes: null },
    }

    for (const [role, list] of Object.entries(workersByRole) as [WorkerRoleCategory, typeof workers][]) {
      const total = list.length
      let ready = 0
      let stopped = 0
      let abnormal = 0
      let occupiedSlots = 0
      let totalSlots = 0
      let browserCount = 0
      let crashCount = 0
      let cpuSum = 0
      let cpuCount = 0
      let rssSum = 0
      let rssCount = 0

      for (const w of list) {
        if (w.status === 'READY' && w.heartbeatFresh) {
          ready++
        } else if (w.status === 'STOPPED') {
          stopped++
        } else {
          abnormal++
        }

        occupiedSlots += w.counts.occupiedSlots
        totalSlots += w.maxSessions ?? w.capacity

        const s = sampleMap.get(w.workerId)
        if (s) {
          if (s.cpuPercent?.availability === 'known') {
            cpuSum += s.cpuPercent.value
            cpuCount++
          }
          if (s.rssBytes?.availability === 'known') {
            rssSum += s.rssBytes.value
            rssCount++
          }
          if (s.browserProcessCount?.availability === 'known') {
            browserCount += s.browserProcessCount.value
          }
          if (s.browserHostLostCount?.availability === 'known') {
            crashCount += s.browserHostLostCount.value
          }
        }
      }

      out[role] = {
        total,
        ready,
        stopped,
        abnormal,
        occupiedSlots,
        totalSlots,
        slotPercent: totalSlots > 0 ? Math.round((occupiedSlots / totalSlots) * 100) : 0,
        browserCount,
        crashCount,
        avgCpu: cpuCount > 0 ? Math.round(cpuSum / cpuCount) : null,
        avgRssBytes: rssCount > 0 ? Math.round(rssSum / rssCount) : null,
      }
    }

    return out
  }, [workersByRole, sampleMap])

  // 卡片配置（4 核心角色 + 若有单机全功能则补充展示）
  const roleCardConfigs: {
    key: WorkerRoleCategory
    icon: React.ComponentType<{ className?: string }>
  }[] = [
    { key: 'executor', icon: Layers },
    { key: 'scheduler', icon: Clock },
    { key: 'analyst', icon: Sparkles },
    { key: 'maintenance', icon: Wrench },
  ]
  if (workersByRole.monolithic.length > 0) {
    roleCardConfigs.push({ key: 'monolithic', icon: Server })
  }

  // 筛选后的节点列表
  const filteredWorkers = selectedRole === 'all' ? workers : workersByRole[selectedRole]

  if (!canReadWorkers) {
    return (
      <FailureAlert {...permissionFailure('查看节点列表需要会话读取权限。可从容量水位了解舰队计数。')} />
    )
  }

  if (query.isPending) return <PageSkeleton rows={4} />

  return (

    <div className="space-y-4">
      {/* 第一层：角色集群概览卡片 (体现数量、健康度与宏观水位) */}
      <div
        className={cn(
          'grid grid-cols-1 sm:grid-cols-2 gap-3',
          roleCardConfigs.length >= 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'
        )}
      >
        {roleCardConfigs.map(({ key, icon: Icon }) => {
          const meta = WORKER_ROLE_METAS[key]
          const stats = roleSummaries[key]
          const isSelected = selectedRole === key

          return (
            <button
              key={key}
              type="button"
              aria-label={`聚焦${meta.label}`}
              onClick={() => setSelectedRole((prev) => (prev === key ? 'all' : key))}
              className={cn(
                'group relative flex flex-col justify-between rounded-lg border p-3.5 text-left transition-all',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                isSelected
                  ? 'border-primary bg-primary/[0.04] shadow-xs ring-1 ring-primary'
                  : 'border-border-card bg-card hover:border-border hover:shadow-xs'
              )}
            >
              {/* 顶栏：图标、角色名称、数量与健康 Badge */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-md border',
                      meta.bgClass,
                      meta.borderClass,
                      meta.colorClass
                    )}
                  >
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="text-body font-semibold text-foreground">
                      {meta.label}
                    </span>
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      {meta.description}
                    </p>
                  </div>
                </div>

                {/* 数量与状态徽章 */}
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <span className="font-mono text-base font-bold tabular-nums text-foreground">
                    {stats.total} <span className="text-xs font-normal text-muted-foreground">实例</span>
                  </span>
                  {stats.total === 0 ? (
                    <span className="text-xs text-muted-foreground">未部署</span>
                  ) : stats.ready === stats.total ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-status-success">
                      <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
                      全部就绪
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-status-warning font-mono">
                      <span className="size-1.5 rounded-full bg-status-warning" />
                      {stats.ready}/{stats.total} 就绪
                    </span>
                  )}
                </div>
              </div>

              {/* 中间指标区 */}
              <div className="mt-3 pt-2.5 border-t border-border-divider/60 text-xs">
                {key === 'executor' || key === 'monolithic' ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>会话槽位占用</span>
                      <span className="font-mono font-medium text-foreground">
                        {stats.occupiedSlots}/{stats.totalSlots}{' '}
                        <span className="text-muted-foreground">({stats.slotPercent}%)</span>
                      </span>
                    </div>
                    <Progress
                      value={stats.slotPercent}
                      className="h-1.5"
                      indicatorClassName={stats.slotPercent >= 80 ? 'bg-status-warning' : 'bg-primary'}
                    />
                    <div className="flex items-center justify-between pt-0.5 text-muted-foreground">
                      <span>浏览器沙箱</span>
                      <span className="font-mono text-foreground">
                        {stats.browserCount} 进程
                        {stats.crashCount > 0 ? (
                          <span className="ml-1 text-status-error font-semibold">· {stats.crashCount} 崩溃</span>
                        ) : (
                          ' · 0 崩溃'
                        )}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>硬件均值</span>
                      <span className="font-mono text-foreground">
                        CPU {stats.avgCpu != null ? `${stats.avgCpu}%` : '—'} ·{' '}
                        RSS {stats.avgRssBytes != null ? formatBytes({ availability: 'known', value: stats.avgRssBytes }) : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>工作状态</span>
                      <span className="text-foreground">
                        {stats.ready > 0 ? '集群正常待命' : '暂无活跃心跳'}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* 底部交互指引 */}
              <div className="mt-2.5 flex items-center justify-end text-[11px]">
                {isSelected ? (
                  <span className="inline-flex items-center gap-1 font-medium text-primary">
                    已聚焦下钻
                    <Check className="size-3" />
                  </span>
                ) : (
                  <span className="text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
                    点击筛选此集群
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* 快速角色过滤药丸条 (快捷切换与重置) */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-label text-muted-foreground mr-1">查看范围：</span>
          <Button
            variant={selectedRole === 'all' ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-label gap-1.5 font-mono"
            onClick={() => setSelectedRole('all')}
          >
            全部节点
            <span className="rounded-full bg-muted/50 px-1.5 py-0.2 text-[10px]">
              {workers.length}
            </span>
          </Button>
          {roleCardConfigs.map(({ key }) => {
            const meta = WORKER_ROLE_METAS[key]
            const count = roleSummaries[key].total
            return (
              <Button
                key={key}
                variant={selectedRole === key ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-label gap-1.5 font-mono"
                onClick={() => setSelectedRole(key)}
              >
                {meta.shortLabel}
                <span className="rounded-full bg-muted/50 px-1.5 py-0.2 text-[10px]">
                  {count}
                </span>
              </Button>
            )
          })}
        </div>

        {selectedRole !== 'all' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-label text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedRole('all')}
          >
            查看全部节点 ({workers.length})
          </Button>
        )}
      </div>

      {/* 第二层：节点沙箱明细下钻表格 */}
      <div className="overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
        {/* 表格标题栏 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-card bg-muted/30 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-primary shrink-0" aria-hidden />
            <span className="text-body font-semibold text-foreground">
              {selectedRole === 'all'
                ? '全部 Worker 节点沙箱明细'
                : `${WORKER_ROLE_METAS[selectedRole].label} 节点明细`}
            </span>
            <span className="font-mono text-label text-muted-foreground">
              (共 {filteredWorkers.length} 个节点)
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-label text-muted-foreground">
            <span>就绪 {filteredWorkers.filter((w) => w.status === 'READY' && w.heartbeatFresh).length}</span>
            <span>·</span>
            <span>已停止 {filteredWorkers.filter((w) => w.status === 'STOPPED').length}</span>
            {filteredWorkers.some((w) => w.status === 'LOST' || (!w.heartbeatFresh && w.status === 'READY')) && (
              <>
                <span>·</span>
                <span className="text-status-error font-medium">
                  异常 {filteredWorkers.filter((w) => w.status === 'LOST' || (!w.heartbeatFresh && w.status === 'READY')).length}
                </span>
              </>
            )}
          </div>
        </div>

        {filteredWorkers.length === 0 ? (
          <div className="p-8 text-center text-label text-muted-foreground">
            当前所选集群分类暂无注册的 Worker 节点。
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-muted/20">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[18%] text-label font-medium">节点 ID</TableHead>
                <TableHead className="w-[11%] text-label font-medium">角色集群</TableHead>
                <TableHead className="w-[10%] text-label font-medium">生命周期</TableHead>
                <TableHead className="w-[11%] text-label font-medium">会话槽位</TableHead>
                <TableHead className="w-[11%] text-label font-medium">内存 RSS</TableHead>
                <TableHead className="w-[9%] text-label font-medium">CPU</TableHead>
                <TableHead className="w-[14%] text-label font-medium">磁盘健康</TableHead>
                <TableHead className="w-[14%] text-right text-label font-medium">沙箱/崩溃/超时</TableHead>
                <TableHead className="w-[8%] text-right text-label font-medium">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredWorkers.map((item) => {
                const role = classifyWorkerRole(item.workerId)
                const roleMeta = WORKER_ROLE_METAS[role]
                const isExecutorLike = role === 'executor' || role === 'monolithic'

                const lifecycle = workerLifecycle(item)
                const sample = sampleMap.get(item.workerId)
                const maxSlots = item.maxSessions ?? item.capacity
                const occupied = item.counts.occupiedSlots

                const diskFree = sample?.diskFreeBytes ? formatBytes(sample.diskFreeBytes) : '—'
                const diskPercent =
                  sample?.diskUsagePercent?.availability === 'known' ? sample.diskUsagePercent.value : 0
                const crashes =
                  sample?.browserHostLostCount?.availability === 'known' ? sample.browserHostLostCount.value : 0
                const hardTimeouts =
                  sample?.stepHardTimeoutCount?.availability === 'known' ? sample.stepHardTimeoutCount.value : 0

                return (
                  <TableRow key={item.workerId} className="h-11 transition-colors hover:bg-muted/20">
                    <TableCell className="font-mono text-body font-medium">
                      <div className="flex items-center gap-2">
                        <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span title={item.workerId}>{item.workerId}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-xs font-mono font-medium',
                          roleMeta.bgClass,
                          roleMeta.borderClass,
                          roleMeta.colorClass
                        )}
                      >
                        {roleMeta.shortLabel}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={lifecycle.tone}>{lifecycle.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-body">
                      {isExecutorLike ? (
                        <div className="flex items-center gap-2">
                          <span>{occupied}/{maxSlots}</span>
                          <div className="hidden sm:block h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all',
                                maxSlots > 0 && occupied / maxSlots >= 0.8 ? 'bg-status-warning' : 'bg-primary'
                              )}
                              style={{ width: `${Math.min(100, Math.round((maxSlots > 0 ? occupied / maxSlots : 0) * 100))}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-label text-muted-foreground font-mono">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-body text-foreground">
                      {sample?.rssBytes ? formatBytes(sample.rssBytes) : '—'}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-body text-foreground">
                      {sample?.cpuPercent ? formatMetric(sample.cpuPercent, '%') : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-label">
                          <span className="text-muted-foreground">余 {diskFree}</span>
                          <span className="font-mono tabular-nums">{diskPercent}%</span>
                        </div>
                        <Progress
                          value={diskPercent}
                          className="h-1"
                          indicatorClassName={diskPercent > 85 ? 'bg-status-error' : 'bg-primary'}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-body">
                      {isExecutorLike ? (
                        <>
                          <span>{sample?.browserProcessCount ? formatMetric(sample.browserProcessCount) : 0} 进程</span>
                          {crashes > 0 && (
                            <span className="ml-1.5 rounded bg-status-error/10 px-1 py-0.5 text-label font-bold text-status-error">
                              {crashes}崩
                            </span>
                          )}
                          {hardTimeouts > 0 && (
                            <span className="ml-1.5 rounded bg-status-warning/10 px-1 py-0.5 text-label font-bold text-status-warning">
                              {hardTimeouts}超时
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-label text-muted-foreground font-normal">
                          非执行角色
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="h-7 text-label" asChild>
                        <Link
                          to="/workers/$workerId"
                          params={{ workerId: item.workerId }}
                          aria-label={`查看节点 ${item.workerId}`}
                        >
                          查看节点
                          <ArrowUpRight className="size-3.5" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function AiModelsTab() {
  const query = useQuery({
    queryKey: ['monitoring', 'ai', 'models'],
    queryFn: () => fetchAiModels(),
  })

  if (query.isPending) return <PageSkeleton rows={4} />

  const items = query.data?.items ?? []
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border-card bg-card p-8 text-center text-muted-foreground">
        近 24 小时无模型调用事实记录。
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[30%] text-label font-medium">模型标识 (Model)</TableHead>
            <TableHead className="w-[14%] text-label font-medium">调用总量</TableHead>
            <TableHead className="w-[14%] text-label font-medium">调用失败</TableHead>
            <TableHead className="w-[14%] text-label font-medium">P95 响应耗时</TableHead>
            <TableHead className="w-[18%] text-label font-medium">Token 流速 (入/出)</TableHead>
            <TableHead className="w-[10%] text-right text-label font-medium">429 限流</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.model} className="h-11 transition-colors hover:bg-muted/20">
              <TableCell className="font-mono font-medium text-foreground">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-tech-cyan shrink-0" />
                  <span>{item.model}</span>
                </div>
              </TableCell>
              <TableCell className="font-mono tabular-nums text-foreground">{item.totalCalls}</TableCell>
              <TableCell>
                {item.failedCalls > 0 ? (
                  <span className="font-mono font-semibold text-status-warning">
                    {item.failedCalls} ({item.errorRate}%)
                  </span>
                ) : (
                  <span className="font-mono text-muted-foreground">0</span>
                )}
              </TableCell>
              <TableCell className="font-mono tabular-nums text-foreground">
                {(item.p95DurationMs / 1000).toFixed(1)}s
              </TableCell>
              <TableCell className="font-mono tabular-nums text-label text-muted-foreground">
                {item.inputTokensPerMin} / {item.outputTokensPerMin} T/m
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {item.rateLimitHits > 0 ? (
                  <span className="rounded bg-status-error/10 px-1.5 py-0.5 text-label font-bold text-status-error">
                    {item.rateLimitHits} 次
                  </span>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

