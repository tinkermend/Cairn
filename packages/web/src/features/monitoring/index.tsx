import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import {
  DEFAULT_MONITOR_SAMPLE_INTERVAL_MS,
  MONITOR_DEFAULT_SERIES_KEYS,
  alignMonitorSampleBucket,
  type MonitorAiCard,
  type MonitorAnomaliesCard,
  type MonitorCapacityCard,
  type MonitorMetricNumber,
  type MonitorQueuesCard,
  type MonitorServiceCard,
  type MonitoringOverviewResponse,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMonitorProfiles, fetchMonitorSeries, probeObjectStore } from '@/lib/monitoring-api'
import { fetchWorkers } from '@/lib/workers-api'
import { useCan } from '@/hooks/use-permissions'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { workerLifecycle } from '@/features/workers/labels'
import { FactCard, FailureAlert, Section } from './facts'
import {
  SERIES_KEY_LABELS,
  apiStatusTone,
  formatAsOf,
  formatBytes,
  formatMetric,
  formatWait,
  freshnessLabel,
  objectFailure,
  objectStoreTone,
  partitionFailure,
  permissionFailure,
  pingTone,
  profileStateLabel,
  schemaTone,
} from './labels'
import { AlertsSection } from './alerts'
import { TimeseriesChart } from './timeseries-chart'
import { connectionLabel, useMonitoringObservation } from './use-monitoring-observation'

export function MonitoringPage() {
  const { overview, connection, autoRefresh, setAutoRefresh, intervalMs, refresh } =
    useMonitoringObservation()
  const canReadWorkers = useCan('session:read')
  const canProbe = useCan('monitor:operate')

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='平台监控'
        description='查看平台自有服务是否健康、容量还剩多少、队列堵在哪里，以及异常落在哪个节点。本页不下发调度或处置。'
        actions={
          <div className='flex flex-wrap items-center gap-3'>
            <div className='flex items-center gap-2'>
              <Switch
                id='monitor-auto-refresh'
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
              />
              <Label htmlFor='monitor-auto-refresh'>自动刷新</Label>
            </div>
            <StatusBadge tone={connection === 'live' ? 'success' : connection === 'forbidden' ? 'error' : 'neutral'}>
              {connectionLabel(connection)}
            </StatusBadge>
            <Button onClick={() => void refresh()} variant='outline'>
              <RefreshCw />
              刷新
            </Button>
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
          autoRefresh={autoRefresh}
          intervalMs={intervalMs}
          canReadWorkers={canReadWorkers}
          canProbe={canProbe}
        />
      ) : null}
    </Main>
  )
}

function overviewError(error: unknown, onRetry: () => void) {
  if (error instanceof ApiRequestError && error.status === 403) {
    return <FailureAlert kind='permission' description='当前账号没有平台监控读取权限。' />
  }
  return (
    <QueryErrorState
      title='监控数据读取失败'
      description='无法读取监控快照。当前筛选会保留，可以重试。'
      onRetry={onRetry}
    />
  )
}

function MonitoringBody({
  snapshot,
  autoRefresh,
  intervalMs,
  canReadWorkers,
  canProbe,
}: {
  snapshot: MonitoringOverviewResponse
  autoRefresh: boolean
  intervalMs: number
  canReadWorkers: boolean
  canProbe: boolean
}) {
  const { service, capacity, queues, anomalies, ai } = snapshot.partitions
  return (
    <div className='flex min-w-0 flex-col gap-8'>
      <p className='text-label text-muted-foreground'>
        截至 {formatAsOf(snapshot.asOf)}
        {autoRefresh ? ` · 推送间隔 ${Math.round(intervalMs / 1000)} 秒` : ' · 自动刷新已关闭'}
      </p>
      <AlertsSection />
      <ServiceSection partition={service} canProbe={canProbe} />
      <CapacitySection partition={capacity} />
      <QueuesSection partition={queues} />
      <AnomaliesSection partition={anomalies} />
      <AiSection partition={ai} />
      <WorkersSection partition={capacity} canReadWorkers={canReadWorkers} />
      <ProfilesSection />
      <TrendsSection snapshot={snapshot} />
    </div>
  )
}

function ServiceSection({
  partition,
  canProbe,
}: {
  partition: MonitoringOverviewResponse['partitions']['service']
  canProbe: boolean
}) {
  return (
    <Section title='服务'>
      {partition.availability === 'unavailable' ? (
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      ) : (
        <ServiceCards
          data={partition.data}
          freshness={freshnessLabel(partition.source, partition.sampledAt)}
          canProbe={canProbe}
        />
      )}
    </Section>
  )
}

function ServiceCards({
  data,
  freshness,
  canProbe,
}: {
  data: MonitorServiceCard
  freshness: string
  canProbe: boolean
}) {
  const api = apiStatusTone(data.api.status)
  const ping = pingTone(data.database.ping)
  const schema = schemaTone(data.database.schemaConsistency)
  const hintUnused = data.changeHint.status === 'unused'
  const realtimeDown = data.changeHint.status === 'down'
  const store = objectStoreTone(data.objectStore.status)
  const versions = [...new Set(data.apiInstances.items.map((item) => item.version).filter(Boolean))]
  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
      <FactCard
        title='API 实例'
        value={`${formatMetric(data.apiInstances.ready)} 就绪`}
        badge={api}
        description={
          <>
            {`${data.api.service} · 运行 ${formatMetric(data.api.uptimeSeconds, ' 秒')} · 失联 ${formatMetric(data.apiInstances.lost)} · 派生 ID ${formatMetric(data.apiInstances.derivedCount)}${versions.length ? ` · 版本 ${versions.join(', ')}` : ''}`}
            {data.apiInstances.items.length > 0 ? (
              <span className='mt-1 block space-y-0.5'>
                {data.apiInstances.items.map((item) => (
                  <span key={item.id} className='block'>
                    {item.id}
                    {item.idSource === 'derived' ? ' · 自动派生' : ''}
                    {` · ${item.status}`}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        }
        freshness={freshness}
      />
      <FactCard
        title='Worker 舰队'
        value='见容量水位'
        description='四值计数来自登记表此刻的事实，与执行节点页同一口径。'
        freshness={freshness}
      />
      <FactCard
        title='数据库'
        value={data.database.driver}
        badge={data.database.ping === 'down' ? { tone: 'error', label: '被监控对象故障' } : ping}
        description={
          data.database.ping === 'down'
            ? objectFailure('数据库不可达。').description
            : `Ping ${formatMetric(data.database.pingLatencyMs, ' 毫秒')} · 期望 ${data.database.expectedLogicalVersion} / 已应用 ${data.database.appliedPrefix ?? '未采集／未上报'} · ${schema.label} · 池 ${formatMetric(data.database.pool.totalCount)}`
        }
        freshness={freshness}
      />
      <FactCard
        title='提示通道'
        value={hintUnused ? '未使用' : realtimeDown ? '实时进度不可用' : data.changeHint.status}
        badge={
          hintUnused
            ? { tone: 'neutral', label: '未使用' }
            : realtimeDown
              ? { tone: 'warning', label: '实时进度不可用' }
              : { tone: 'success', label: '可用' }
        }
        description={
          data.changeHint.consequence ??
          (hintUnused ? '提示通道未启用。' : `realtime=${data.changeHint.realtime ? 'true' : 'false'}`)
        }
        freshness={freshness}
      />
      <FactCard
        title='对象存储'
        value={store.label}
        badge={data.objectStore.status.availability === 'known' && data.objectStore.status.value !== 1
          ? { tone: 'error', label: '被监控对象故障' }
          : store}
        description={
          data.objectStore.status.availability === 'unknown'
            ? '容量与可达性尚未采集，不显示 0。'
            : `延迟 ${formatMetric(data.objectStore.latencyMs, ' 毫秒')}${data.objectStore.errorClass ? ` · ${data.objectStore.errorClass}` : ''}`
        }
        freshness={data.objectStore.probedAt ? `上次探测 ${formatAsOf(data.objectStore.probedAt)}` : freshness}
      />
      {canProbe ? <ProbeButton /> : null}
    </div>
  )
}

function ProbeButton() {
  const queryClient = useQueryClient()
  const probe = useMutation({
    mutationFn: () => probeObjectStore(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['monitoring', 'overview'] })
    },
  })
  return (
    <article className='min-w-0 rounded-lg border border-border-card bg-card p-4 shadow-card'>
      <p className='text-small text-muted-foreground'>主动探测</p>
      <Button className='mt-3' onClick={() => probe.mutate()} disabled={probe.isPending}>
        {probe.isPending ? '探测中' : '探测对象存储'}
      </Button>
      {probe.isError ? (
        <p className='mt-2 text-label text-muted-foreground'>
          {probe.error instanceof ApiRequestError && probe.error.status === 429
            ? '探测过于频繁，请稍后再试。'
            : '探测失败，可重试。'}
        </p>
      ) : (
        <p className='mt-2 text-label text-muted-foreground'>写入最近一次结果并记审计，不经过 Worker。</p>
      )}
    </article>
  )
}

function CapacitySection({
  partition,
}: {
  partition: MonitoringOverviewResponse['partitions']['capacity']
}) {
  return (
    <Section title='容量水位'>
      {partition.availability === 'unavailable' ? (
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      ) : (
        <CapacityCards data={partition.data} freshness={freshnessLabel(partition.source, partition.sampledAt)} />
      )}
    </Section>
  )
}

function CapacityCards({ data, freshness }: { data: MonitorCapacityCard; freshness: string }) {
  return (
    <div className='space-y-3'>
      <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
        <FactCard
          title='Run 容量'
          value={`${formatMetric(data.capacity.used)} / ${formatMetric(data.capacity.total)}`}
          description='已用 / 合计'
          freshness={freshness}
        />
        <FactCard
          title='会话槽位'
          value={`${formatMetric(data.sessions.used)} / ${formatMetric(data.sessions.total)}`}
          description='已用 / 合计'
          freshness={freshness}
        />
        <FactCard title='在跑' value={formatMetric(data.slots.running)} freshness={freshness} />
        <FactCard title='调试暂停' value={formatMetric(data.slots.holding)} freshness={freshness} />
        <FactCard title='等待认证' value={formatMetric(data.slots.waitingForAuth)} freshness={freshness} />
        <FactCard
          title='舰队状态'
          value={`${formatMetric(data.workers.ready)} 就绪`}
          description={`收尾 ${formatMetric(data.workers.draining)} · 已停止 ${formatMetric(data.workers.stopped)} · 失联 ${formatMetric(data.workers.lost)}。已停止不因历史心跳变绿。`}
          freshness={freshness}
        />
      </div>
      {data.workerSamples.items.length > 0 ? (
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {data.workerSamples.items.map((node) => (
            <FactCard
              key={node.workerId}
              title={`节点 ${node.workerId}`}
              value={formatBytes(node.rssBytes)}
              description={`CPU ${formatMetric(node.cpuPercent, '%')} · 事件循环 ${formatMetric(node.eventLoopDelayMs, ' 毫秒')} · 浏览器进程 ${formatMetric(node.browserProcessCount)}`}
              freshness={node.sampledAt ? `上次采样 ${formatAsOf(node.sampledAt)}` : freshness}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function QueuesSection({
  partition,
}: {
  partition: MonitoringOverviewResponse['partitions']['queues']
}) {
  return (
    <Section title='队列与积压'>
      {partition.availability === 'unavailable' ? (
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      ) : (
        <QueueCards data={partition.data} freshness={freshnessLabel(partition.source, partition.sampledAt)} />
      )}
    </Section>
  )
}

function QueueCards({ data, freshness }: { data: MonitorQueuesCard; freshness: string }) {
  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
      <FactCard
        title='待领取 Run'
        value={formatMetric(data.claimableRuns)}
        description={`最久等待 ${formatWait(data.oldestWaitMs)}`}
        freshness={freshness}
      />
      <FactCard
        title='无人可领的 Run'
        value={formatMetric(data.unclaimableRuns)}
        description='在线节点没有所需协议能力'
        freshness={freshness}
      />
      <FactCard title='恢复中' value={formatMetric(data.recovering)} freshness={freshness} />
      <FactCard title='待核查' value={formatMetric(data.needsReview)} freshness={freshness} />
      <FactCard title='调度积压' value={formatMetric(data.schedulePending)} freshness={freshness} />
      <FactCard
        title='地图作业积压'
        value={formatMetric(data.mapJobsActive)}
        description={`排队 ${formatMetric(data.mapJobsQueued)} · 执行中 ${formatMetric(data.mapJobsRunning)}`}
        freshness={freshness}
      />
      <FactCard
        title='单目标最大积压'
        value={formatMetric(data.maxTargetBacklog)}
        description={`有积压目标 ${formatMetric(data.targetsWithBacklog)} · P95 ${formatMetric(data.targetBacklogP95)}`}
        freshness={freshness}
      />
      <FactCard
        title='最近领取扫描'
        value={formatMetric(data.lastClaimScanCount)}
        description='单次领取看过的 SQL 候选条数'
        freshness={freshness}
      />
      <FactCard
        title='全局回收新鲜度'
        value={formatWait(data.lastGlobalReclaimAgeMs)}
        freshness={freshness}
      />
      <FactCard
        title='会话维护队列'
        value={formatMetric(data.sessionOperations)}
        freshness={freshness}
      />
      <FactCard
        title='地图作业守卫不一致'
        value={formatMetric(data.mapJobsActiveGuardMismatch)}
        freshness={freshness}
      />
    </div>
  )
}

function AnomaliesSection({
  partition,
}: {
  partition: MonitoringOverviewResponse['partitions']['anomalies']
}) {
  return (
    <Section title='异常与风险'>
      {partition.availability === 'unavailable' ? (
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      ) : (
        <AnomalyCards data={partition.data} freshness={freshnessLabel(partition.source, partition.sampledAt)} />
      )}
    </Section>
  )
}

function AnomalyCards({ data, freshness }: { data: MonitorAnomaliesCard; freshness: string }) {
  const canReadEvidence = useCan('run:read')
  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
      <FactCard
        title='过期 ACTIVE 租约'
        value={`${formatMetric(data.leases.expiredActiveRunLeases)} / ${formatMetric(data.leases.expiredActiveSessionLeases)}`}
        description='Run / Session'
        freshness={freshness}
      />
      <FactCard title='遗留认证占用' value={formatMetric(data.leases.leftoverAuthHolds)} freshness={freshness} />
      <FactCard title='孤儿 Attempt' value={formatMetric(data.leases.orphanAttempts)} freshness={freshness} />
      <FactCard title='恢复次数触顶' value={formatMetric(data.leases.recoveryCappedRuns)} freshness={freshness} />
      <FactCard
        title='证据待上传'
        value={formatMetric(data.evidence.pendingUpload)}
        freshness={freshness}
        to={canReadEvidence ? '/evidence' : undefined}
        search={canReadEvidence ? { availability: 'collecting' } : undefined}
      />
      <FactCard
        title='证据上传失败'
        value={formatMetric(data.evidence.uploadFailed)}
        freshness={freshness}
        to={canReadEvidence ? '/evidence' : undefined}
        search={canReadEvidence ? { view: 'capture_upload_anomaly' } : undefined}
      />
      <FactCard
        title='清理积压'
        value={formatMetric(data.evidence.purgeBacklog)}
        freshness={freshness}
        to={canReadEvidence ? '/evidence' : undefined}
        search={canReadEvidence ? { tab: 'retention', retentionView: 'pending_cleanup' } : undefined}
      />
      <FactCard
        title='清理失败'
        value={formatMetric(data.evidence.purgeFailed)}
        freshness={freshness}
        to={canReadEvidence ? '/evidence' : undefined}
        search={canReadEvidence ? { view: 'purge_failed' } : undefined}
      />
      <FactCard
        title='时钟偏移'
        value={formatMetric(data.clockSkew.maxAbsSkewMs, ' 毫秒')}
        description='心跳未过期节点的最大绝对值'
        freshness={freshness}
      />
    </div>
  )
}

function AiSection({ partition }: { partition: MonitoringOverviewResponse['partitions']['ai'] }) {
  return (
    <Section title='AI 调用'>
      {partition.availability === 'unavailable' ? (
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      ) : (
        <AiCards data={partition.data} freshness={freshnessLabel(partition.source, partition.sampledAt)} />
      )}
    </Section>
  )
}

function AiCards({ data, freshness }: { data: MonitorAiCard; freshness: string }) {
  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
      <FactCard title='24 小时调用' value={formatMetric(data.calls)} freshness={freshness} />
      <FactCard title='失败' value={formatMetric(data.errors)} freshness={freshness} />
      <FactCard title='输入 Token' value={formatMetric(data.inputTokens)} freshness={freshness} />
      <FactCard title='输出 Token' value={formatMetric(data.outputTokens)} freshness={freshness} />
      <FactCard title='耗时 p95' value={formatMetric(data.durationP95Ms, ' 毫秒')} freshness={freshness} />
      <FactCard title='成本' value={formatMetric(data.cost)} description='供应商未回传，不显示 0。' freshness={freshness} />
      <FactCard
        title='最近调用'
        value={data.lastCallAt ? formatAsOf(data.lastCallAt) : '未采集／未上报'}
        description={data.lastErrorClass ? `最近错误 ${data.lastErrorClass}` : undefined}
        freshness={freshness}
      />
    </div>
  )
}

function TrendsSection({ snapshot }: { snapshot: MonitoringOverviewResponse }) {
  const keys = [...MONITOR_DEFAULT_SERIES_KEYS]
  const bucket = alignMonitorSampleBucket(new Date(snapshot.asOf), DEFAULT_MONITOR_SAMPLE_INTERVAL_MS).toISOString()
  const query = useQuery({
    queryKey: ['monitoring', 'series', keys.join(','), bucket],
    queryFn: () => fetchMonitorSeries({ keys: keys.join(',') }),
  })
  const preview = previewPoints(snapshot)
  const series = (query.data?.items ?? []).map((item) => ({
    key: item.key,
    label: SERIES_KEY_LABELS[item.key] ?? item.key,
    points: withPreview(item.points, preview[item.key], snapshot.asOf),
  }))
  return (
    <Section title='趋势'>
      {query.isError ? (
        query.error instanceof ApiRequestError && query.error.status === 403 ? (
          <FailureAlert {...permissionFailure('当前账号不能读取趋势。')} />
        ) : (
          <FailureAlert {...partitionFailure('AGGREGATE_FAILED')} />
        )
      ) : (
        <>
          <p className='text-label text-muted-foreground'>
            默认看待领取 Run、就绪 Worker 与证据待上传。末端未封桶只作预览，不写入采样。
          </p>
          {query.isPending ? <PageSkeleton rows={4} /> : <TimeseriesChart series={series} />}
        </>
      )}
    </Section>
  )
}

function previewPoints(snapshot: MonitoringOverviewResponse): Partial<Record<string, number>> {
  const values: Partial<Record<string, number>> = {}
  const queues = snapshot.partitions.queues
  const capacity = snapshot.partitions.capacity
  const anomalies = snapshot.partitions.anomalies
  if (queues.availability === 'available') assignKnown(values, 'queue.claimableRuns', queues.data.claimableRuns)
  if (capacity.availability === 'available') assignKnown(values, 'worker.status.ready', capacity.data.workers.ready)
  if (anomalies.availability === 'available') {
    assignKnown(values, 'evidence.pendingUpload', anomalies.data.evidence.pendingUpload)
  }
  return values
}

function assignKnown(
  target: Partial<Record<string, number>>,
  key: string,
  metric: MonitorMetricNumber,
): void {
  if (metric.availability === 'known') target[key] = metric.value
}

function withPreview(
  points: Array<{ bucketAt: string; value: number }>,
  preview: number | undefined,
  asOf: string,
): Array<{ bucketAt: string; value: number }> {
  if (preview == null) return points
  const last = points[points.length - 1]
  if (last && last.bucketAt === asOf) return points
  return [...points, { bucketAt: asOf, value: preview }]
}

function WorkersSection({
  partition,
  canReadWorkers,
}: {
  partition: MonitoringOverviewResponse['partitions']['capacity']
  canReadWorkers: boolean
}) {
  const page = useCursorPage(20, 'monitoring-workers')
  const query = useQuery({
    queryKey: ['monitoring', 'workers', page.pageSize, page.cursor],
    queryFn: () => fetchWorkers({ limit: page.pageSize, cursor: page.cursor, heartbeatFresh: undefined }),
    enabled: canReadWorkers,
    placeholderData: keepPreviousData,
  })
  return (
    <Section title='执行节点'>
      {partition.availability === 'available' ? (
        <p className='text-label text-muted-foreground'>
          舰队汇总：就绪 {formatMetric(partition.data.workers.ready)} · 收尾{' '}
          {formatMetric(partition.data.workers.draining)} · 已停止 {formatMetric(partition.data.workers.stopped)} ·
          失联 {formatMetric(partition.data.workers.lost)}。已停止不是失联。
        </p>
      ) : null}
      {!canReadWorkers ? (
        <FailureAlert {...permissionFailure('查看节点列表需要会话读取权限。可从容量水位了解舰队计数。')} />
      ) : query.isPending ? (
        <PageSkeleton rows={3} />
      ) : query.isError ? (
        query.error instanceof ApiRequestError && query.error.status === 403 ? (
          <FailureAlert {...permissionFailure('当前账号不能读取执行节点列表。')} />
        ) : (
          <FailureAlert {...partitionFailure('AGGREGATE_FAILED')} />
        )
      ) : query.data && query.data.items.length === 0 ? (
        <EmptyState title='还没有执行节点' description='Worker 启动后会向数据库登记。' />
      ) : query.data ? (
        <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>节点</TableHead>
                <TableHead>生命周期</TableHead>
                <TableHead>占用</TableHead>
                <TableHead>
                  <span className='sr-only'>下钻</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((item) => {
                const life = workerLifecycle(item)
                return (
                  <TableRow key={item.workerId}>
                    <TableCell className='text-body font-semibold'>{item.workerId}</TableCell>
                    <TableCell>
                      <StatusBadge tone={life.tone}>{life.label}</StatusBadge>
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {item.counts.running}/{item.counts.holding}/{item.counts.waitingForAuth}
                    </TableCell>
                    <TableCell>
                      <Button variant='outline' size='sm' asChild>
                        <Link
                          to='/workers/$workerId'
                          params={{ workerId: item.workerId }}
                          aria-label={`查看节点 ${item.workerId}`}
                        >
                          查看节点
                          <ArrowUpRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
            <p className='text-label text-muted-foreground'>显示 {query.data.items.length} 个节点</p>
            <CursorPagination
              pageIndex={page.pageIndex}
              pageSize={page.pageSize}
              hasPreviousPage={page.pageIndex > 0}
              hasNextPage={Boolean(query.data.nextCursor)}
              updating={query.isFetching && query.isPlaceholderData}
              onPageSizeChange={page.setPageSize}
              onPreviousPage={page.goPrev}
              onNextPage={() => {
                if (query.data.nextCursor) page.goNext(query.data.nextCursor)
              }}
            />
          </div>
        </div>
      ) : null}
    </Section>
  )
}

function ProfilesSection() {
  const page = useCursorPage(20, 'monitoring-profiles')
  const query = useQuery({
    queryKey: ['monitoring', 'profiles', page.pageSize, page.cursor],
    queryFn: () => fetchMonitorProfiles({ limit: page.pageSize, cursor: page.cursor }),
    placeholderData: keepPreviousData,
  })
  const items = query.data?.items ?? []
  const present = items.filter((item) => item.state === 'PRESENT').length
  const absent = items.filter((item) => item.state === 'ABSENT').length
  const pending = items.reduce((sum, item) => sum + item.pendingCleanups, 0)
  return (
    <Section title='浏览器与 Profile'>
      {query.isPending ? (
        <PageSkeleton rows={3} />
      ) : query.isError ? (
        query.error instanceof ApiRequestError && query.error.status === 403 ? (
          <FailureAlert {...permissionFailure('当前账号不能读取 Profile 落点。')} />
        ) : (
          <FailureAlert {...partitionFailure('AGGREGATE_FAILED')} />
        )
      ) : items.length === 0 ? (
        <EmptyState title='还没有 Profile 落点' description='会话创建后会出现在场或缺席状态。' />
      ) : (
        <>
          <p className='text-label text-muted-foreground'>
            本页 PRESENT {present} · ABSENT {absent} · pendingCleanups {pending}。逐条磁盘占用未采集／未上报，不显示
            0。节点根目录见下方。
          </p>
          {query.data?.nodes && query.data.nodes.length > 0 ? (
            <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
              {query.data.nodes.map((node) => (
                <FactCard
                  key={node.workerId}
                  title={`节点 ${node.workerId}`}
                  value={formatBytes(node.diskUsageBytes)}
                  description={`目录 ${formatMetric(node.profileCount)} · 可用 ${formatBytes(node.diskFreeBytes)} · Midscene ${formatBytes(node.midsceneBytes)}`}
                  freshness={node.sampledAt ? `上次采样 ${formatAsOf(node.sampledAt)}` : '上次采样尚未开始'}
                />
              ))}
            </div>
          ) : null}
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead>
                  <TableHead>落点</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>清理积压</TableHead>
                  <TableHead>磁盘</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.profileKey}>
                    <TableCell>
                      <p className='text-body font-semibold'>{item.profileKey}</p>
                      <p className='text-label text-muted-foreground'>
                        {item.targetName ?? item.targetId} · {item.accountLabel ?? item.targetAccountId}
                      </p>
                    </TableCell>
                    <TableCell className='text-body'>{item.locationWorkerId ?? '未落点'}</TableCell>
                    <TableCell>
                      <StatusBadge tone={item.state === 'PRESENT' ? 'success' : 'neutral'}>
                        {profileStateLabel(item.state)}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className='tabular-nums'>{item.pendingCleanups}</TableCell>
                    <TableCell>{formatMetric(item.diskUsageBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
              <p className='text-label text-muted-foreground'>显示 {items.length} 条</p>
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
          </div>
        </>
      )}
    </Section>
  )
}
