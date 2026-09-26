import { Link } from '@tanstack/react-router'
import {
  Activity,
  ArrowUpRight,
  Brain,
  Clock,
  HardDrive,
  Layers,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import type {
  MonitorAiCard,
  MonitorAnomaliesCard,
  MonitorQueuesCard,
  MonitoringOverviewResponse,
} from '@cairn/shared'
import { useCan } from '@/hooks/use-permissions'
import { cn } from '@/lib/utils'
import { FailureAlert, Section } from '../facts'
import {
  formatAsOf,
  formatMetric,
  formatWait,
  partitionFailure,
} from '../labels'

export function QueuesSection({
  partition,
}: {
  partition: MonitoringOverviewResponse['partitions']['queues']
}) {
  if (partition.availability === 'unavailable') {
    return (
      <Section title="队列与积压">
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      </Section>
    )
  }

  const data = partition.data
  const backlogCount =
    (data.claimableRuns.availability === 'known' ? data.claimableRuns.value : 0) +
    (data.unclaimableRuns.availability === 'known' ? data.unclaimableRuns.value : 0) +
    (data.recovering.availability === 'known' ? data.recovering.value : 0) +
    (data.needsReview.availability === 'known' ? data.needsReview.value : 0) +
    (data.schedulePending.availability === 'known' ? data.schedulePending.value : 0) +
    (data.mapJobsActive.availability === 'known' ? data.mapJobsActive.value : 0)

  const badge =
    backlogCount === 0 ? (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-status-success/30 bg-status-success/10 px-2 py-0.5 text-label font-medium text-status-success">
        <span className="size-1.5 rounded-full bg-status-success" />
        队列畅通 · 无积压
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-label font-medium text-status-warning">
        <span className="size-1.5 rounded-full bg-status-warning" />
        {backlogCount} 项积压待处理
      </span>
    )

  return (
    <Section title="队列与积压" action={badge}>
      <QueuesContent data={data} />
    </Section>
  )
}

function QueuesContent({ data }: { data: MonitorQueuesCard }) {
  const isClaimableActive = data.claimableRuns.availability === 'known' && data.claimableRuns.value > 0
  const isUnclaimableActive = data.unclaimableRuns.availability === 'known' && data.unclaimableRuns.value > 0
  const isReviewActive = data.needsReview.availability === 'known' && data.needsReview.value > 0
  const isMismatchActive =
    data.mapJobsActiveGuardMismatch.availability === 'known' && data.mapJobsActiveGuardMismatch.value > 0

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {/* 栏 1: 运行派发与等待 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div>
          <div className="flex items-center justify-between pb-3">
            <span className="flex items-center gap-1.5 text-small font-semibold">
              <Activity className="size-4 text-primary" aria-hidden />
              运行派发与排队
            </span>
            <span className="text-label text-muted-foreground">吞吐待办</span>
          </div>

          <div className="flex items-baseline justify-between rounded-md bg-surface-subtle p-3">
            <div>
              <span className="text-label text-muted-foreground">待领取 Run</span>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-stat font-bold tabular-nums text-foreground">
                  {formatMetric(data.claimableRuns)}
                </span>
                <span className="text-label text-muted-foreground">
                  最久等待 {formatWait(data.oldestWaitMs)}
                </span>
              </div>
            </div>
            {isClaimableActive ? (
              <span className="rounded-full bg-status-warning/10 px-2 py-0.5 text-label font-medium text-status-warning">
                排队中
              </span>
            ) : (
              <span className="rounded-full bg-status-success/10 px-2 py-0.5 text-label font-medium text-status-success">
                空闲
              </span>
            )}
          </div>

          <div className="mt-3 space-y-2 text-label">
            <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
              <span className="text-muted-foreground">无人可领的 Run</span>
              <span className={cn('font-mono font-medium', isUnclaimableActive ? 'font-bold text-status-warning' : 'text-foreground')}>
                {formatMetric(data.unclaimableRuns)}
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
              <span className="text-muted-foreground">自愈恢复中</span>
              <span className="font-mono font-medium text-foreground">
                {formatMetric(data.recovering)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">待核查 Run</span>
              <span className={cn('font-mono font-medium', isReviewActive ? 'font-bold text-status-warning' : 'text-foreground')}>
                {formatMetric(data.needsReview)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 栏 2: 任务流水线与积压 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div>
          <div className="flex items-center justify-between pb-3">
            <span className="flex items-center gap-1.5 text-small font-semibold">
              <Layers className="size-4 text-tech-purple-primary" aria-hidden />
              任务流水线与积压
            </span>
            <span className="text-label text-muted-foreground">作业流水</span>
          </div>

          <div className="flex items-baseline justify-between rounded-md bg-surface-subtle p-3">
            <div>
              <span className="text-label text-muted-foreground">调度积压</span>
              <div className="font-mono text-stat font-bold tabular-nums text-foreground">
                {formatMetric(data.schedulePending)}
              </div>
            </div>
            <span className="text-label text-muted-foreground">待分配槽位</span>
          </div>

          <div className="mt-3 space-y-2 text-label">
            <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
              <span className="text-muted-foreground">地图作业积压</span>
              <div className="flex items-center gap-1 font-mono text-label">
                <span className="font-semibold text-foreground">{formatMetric(data.mapJobsActive)}</span>
                <span className="text-muted-foreground">(排队 {formatMetric(data.mapJobsQueued)} · 运行 {formatMetric(data.mapJobsRunning)})</span>
              </div>
            </div>
            <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
              <span className="text-muted-foreground">会话维护队列</span>
              <span className="font-mono font-medium text-foreground">
                {formatMetric(data.sessionOperations)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">地图作业守卫不一致</span>
              <span className={cn('font-mono font-medium', isMismatchActive ? 'font-bold text-status-warning' : 'text-foreground')}>
                {formatMetric(data.mapJobsActiveGuardMismatch)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 栏 3: 调度器与排队治理 */}
      <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div>
          <div className="flex items-center justify-between pb-3">
            <span className="flex items-center gap-1.5 text-small font-semibold">
              <Clock className="size-4 text-tech-cyan" aria-hidden />
              排队治理与回收
            </span>
            <span className="text-label text-muted-foreground">系统健康</span>
          </div>

          <div className="flex items-baseline justify-between rounded-md bg-surface-subtle p-3">
            <div>
              <span className="text-label text-muted-foreground">单目标最大积压</span>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-stat font-bold tabular-nums text-foreground">
                  {formatMetric(data.maxTargetBacklog)}
                </span>
                <span className="text-label text-muted-foreground">
                  积压目标 {formatMetric(data.targetsWithBacklog)}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-3 space-y-2 text-label">
            <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
              <span className="text-muted-foreground">最近领取扫描</span>
              <span className="font-mono font-medium text-foreground">
                {formatMetric(data.lastClaimScanCount)} 次
              </span>
            </div>
            <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
              <span className="text-muted-foreground">全局回收新鲜度</span>
              <span className="font-mono font-medium text-foreground">
                {formatWait(data.lastGlobalReclaimAgeMs)}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">排队调度模式</span>
              <span className="text-label text-muted-foreground">公平轮询就绪</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AnomaliesSection({
  partition,
}: {
  partition: MonitoringOverviewResponse['partitions']['anomalies']
}) {
  if (partition.availability === 'unavailable') {
    return (
      <Section title="异常与风险">
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      </Section>
    )
  }

  const data = partition.data
  const anomalyCount =
    (data.leases.expiredActiveRunLeases.availability === 'known' ? data.leases.expiredActiveRunLeases.value : 0) +
    (data.leases.expiredActiveSessionLeases.availability === 'known' ? data.leases.expiredActiveSessionLeases.value : 0) +
    (data.leases.leftoverAuthHolds.availability === 'known' ? data.leases.leftoverAuthHolds.value : 0) +
    (data.leases.orphanAttempts.availability === 'known' ? data.leases.orphanAttempts.value : 0) +
    (data.leases.recoveryCappedRuns.availability === 'known' ? data.leases.recoveryCappedRuns.value : 0) +
    (data.evidence.uploadFailed.availability === 'known' ? data.evidence.uploadFailed.value : 0) +
    (data.evidence.purgeFailed.availability === 'known' ? data.evidence.purgeFailed.value : 0)

  const badge =
    anomalyCount === 0 ? (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-status-success/30 bg-status-success/10 px-2 py-0.5 text-label font-medium text-status-success">
        <span className="size-1.5 rounded-full bg-status-success" />
        租约与数据平稳 · 无异常
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-status-error/30 bg-status-error/10 px-2 py-0.5 text-label font-medium text-status-error">
        <span className="size-1.5 rounded-full bg-status-error" />
        {anomalyCount} 项异常风险
      </span>
    )

  return (
    <Section title="异常与风险" action={badge}>
      <AnomaliesContent data={data} />
    </Section>
  )
}

function AnomaliesContent({ data }: { data: MonitorAnomaliesCard }) {
  const canReadEvidence = useCan('run:read')

  const expiredRuns = data.leases.expiredActiveRunLeases.availability === 'known' ? data.leases.expiredActiveRunLeases.value : 0
  const expiredSessions = data.leases.expiredActiveSessionLeases.availability === 'known' ? data.leases.expiredActiveSessionLeases.value : 0
  const hasExpiredLeases = expiredRuns > 0 || expiredSessions > 0
  const hasAuthHolds = data.leases.leftoverAuthHolds.availability === 'known' && data.leases.leftoverAuthHolds.value > 0
  const hasOrphanAttempts = data.leases.orphanAttempts.availability === 'known' && data.leases.orphanAttempts.value > 0
  const hasRecoveryCapped = data.leases.recoveryCappedRuns.availability === 'known' && data.leases.recoveryCappedRuns.value > 0

  const uploadFailed = data.evidence.uploadFailed.availability === 'known' && data.evidence.uploadFailed.value > 0
  const purgeFailed = data.evidence.purgeFailed.availability === 'known' && data.evidence.purgeFailed.value > 0

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {/* 栏 1: 租约与运行状态守卫 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-3">
          <span className="flex items-center gap-1.5 text-small font-semibold">
            <ShieldAlert className="size-4 text-tech-purple-primary" aria-hidden />
            租约与状态防护
          </span>
          <span className="text-label text-muted-foreground">租约守卫</span>
        </div>

        <div className="space-y-2 text-label">
          <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
            <div>
              <span className="text-muted-foreground">过期 ACTIVE 租约</span>
              <p className="text-label text-muted-foreground">Run / Session</p>
            </div>
            <span className={cn('font-mono font-medium', hasExpiredLeases ? 'font-bold text-status-error' : 'text-foreground')}>
              {formatMetric(data.leases.expiredActiveRunLeases)} / {formatMetric(data.leases.expiredActiveSessionLeases)}
            </span>
          </div>

          <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
            <span className="text-muted-foreground">遗留认证占用</span>
            <span className={cn('font-mono font-medium', hasAuthHolds ? 'font-bold text-status-warning' : 'text-foreground')}>
              {formatMetric(data.leases.leftoverAuthHolds)}
            </span>
          </div>

          <div className="flex items-center justify-between border-b border-border-divider/50 py-1.5">
            <span className="text-muted-foreground">孤儿 Attempt</span>
            <span className={cn('font-mono font-medium', hasOrphanAttempts ? 'font-bold text-status-warning' : 'text-foreground')}>
              {formatMetric(data.leases.orphanAttempts)}
            </span>
          </div>

          <div className="flex items-center justify-between py-1.5">
            <span className="text-muted-foreground">恢复次数触顶</span>
            <span className={cn('font-mono font-medium', hasRecoveryCapped ? 'font-bold text-status-warning' : 'text-foreground')}>
              {formatMetric(data.leases.recoveryCappedRuns)}
            </span>
          </div>
        </div>
      </div>

      {/* 栏 2: 证据存管与清理治理 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-3">
          <span className="flex items-center gap-1.5 text-small font-semibold">
            <HardDrive className="size-4 text-tech-cyan" aria-hidden />
            证据存管与归档
          </span>
          <span className="text-label text-muted-foreground">生命周期</span>
        </div>

        <div className="space-y-1 text-label">
          <AnomalyRow
            title="证据待上传"
            value={formatMetric(data.evidence.pendingUpload)}
            to={canReadEvidence ? '/evidence' : undefined}
            search={canReadEvidence ? { availability: 'collecting' } : undefined}
          />
          <AnomalyRow
            title="证据上传失败"
            value={formatMetric(data.evidence.uploadFailed)}
            to={canReadEvidence ? '/evidence' : undefined}
            search={canReadEvidence ? { view: 'capture_upload_anomaly' } : undefined}
            isError={uploadFailed}
          />
          <AnomalyRow
            title="清理积压"
            value={formatMetric(data.evidence.purgeBacklog)}
            to={canReadEvidence ? '/evidence' : undefined}
            search={canReadEvidence ? { tab: 'retention', retentionView: 'pending_cleanup' } : undefined}
          />
          <AnomalyRow
            title="清理失败"
            value={formatMetric(data.evidence.purgeFailed)}
            to={canReadEvidence ? '/evidence' : undefined}
            search={canReadEvidence ? { view: 'purge_failed' } : undefined}
            isError={purgeFailed}
          />
        </div>
      </div>

      {/* 栏 3: 节点时间同步与偏斜 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-3">
          <span className="flex items-center gap-1.5 text-small font-semibold">
            <Clock className="size-4 text-primary" aria-hidden />
            时间基准与偏移
          </span>
          <span className="text-label text-muted-foreground">集群时钟</span>
        </div>

        <div className="flex items-baseline justify-between rounded-md bg-surface-subtle p-3">
          <div>
            <span className="text-label text-muted-foreground">时钟偏移</span>
            <div className="font-mono text-stat font-bold tabular-nums text-foreground">
              {formatMetric(data.clockSkew.maxAbsSkewMs, ' 毫秒')}
            </div>
          </div>
          <span className="rounded-full bg-status-success/10 px-2 py-0.5 text-label font-medium text-status-success">
            NTP 稳定
          </span>
        </div>

        <div className="mt-4 text-label text-muted-foreground">
          <p>分布式节点间物理时钟偏差容忍度为 1000 毫秒，当前各 Worker 采样处于健康时间区间。</p>
        </div>
      </div>
    </div>
  )
}

function AnomalyRow({
  title,
  value,
  to,
  search,
  isError,
}: {
  title: string
  value: string
  to?: string
  search?: Record<string, string>
  isError?: boolean
}) {
  const content = (
    <div className="flex items-center justify-between rounded px-2 py-1.5 transition-colors hover:bg-surface-subtle">
      <span className="text-muted-foreground">{title}</span>
      <div className="flex items-center gap-1">
        <span className={cn('font-mono font-medium', isError ? 'font-bold text-status-error' : 'text-foreground')}>
          {value}
        </span>
        {to && <ArrowUpRight className="size-3 text-muted-foreground" aria-hidden />}
      </div>
    </div>
  )

  if (to) {
    return (
      <Link to={to} search={search} aria-label={title} className="block">
        {content}
      </Link>
    )
  }

  return content
}

export function AiSection({
  partition,
}: {
  partition: MonitoringOverviewResponse['partitions']['ai']
}) {
  if (partition.availability === 'unavailable') {
    return (
      <Section title="AI 调用">
        <FailureAlert {...partitionFailure(partition.reasonCode)} />
      </Section>
    )
  }

  const data = partition.data
  const hasError = data.errors.availability === 'known' && data.errors.value > 0

  const badge = hasError ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-status-error/30 bg-status-error/10 px-2 py-0.5 text-label font-medium text-status-error">
      <span className="size-1.5 rounded-full bg-status-error" />
      调用存在失败
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-status-success/30 bg-status-success/10 px-2 py-0.5 text-label font-medium text-status-success">
      <span className="size-1.5 rounded-full bg-status-success" />
      AI 服务正常
    </span>
  )

  return (
    <Section title="AI 调用" action={badge}>
      <AiContent data={data} />
    </Section>
  )
}

function AiContent({ data }: { data: MonitorAiCard }) {
  const hasError = data.errors.availability === 'known' && data.errors.value > 0

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* 卡片 1: 24h 调用与调用失败 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-2">
          <span className="flex items-center gap-1.5 text-small font-semibold">
            <Brain className="size-4 text-tech-purple-primary" aria-hidden />
            24 小时调用
          </span>
          <span className="text-label text-muted-foreground">频次</span>
        </div>
        <div className="font-mono text-stat font-bold tabular-nums text-foreground">
          {formatMetric(data.calls)}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-border-divider/50 pt-2 text-label">
          <span className="text-muted-foreground">失败</span>
          <span className={cn('font-mono font-medium', hasError ? 'font-bold text-status-error' : 'text-foreground')}>
            {formatMetric(data.errors)}
          </span>
        </div>
        {data.textCalls && data.visionCalls && (data.textCalls.availability === 'known' || data.visionCalls.availability === 'known') ? (
          <div className="mt-1.5 flex items-center justify-between border-t border-border-divider/50 pt-1.5 text-label">
            <span className="text-muted-foreground">文本 / 视觉</span>
            <span className="font-mono text-foreground">
              {formatMetric(data.textCalls)} / {formatMetric(data.visionCalls)}
            </span>
          </div>
        ) : null}
      </div>

      {/* 卡片 2: Token 吞吐 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-2">
          <span className="flex items-center gap-1.5 text-small font-semibold">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Token 消耗
          </span>
          <span className="text-label text-muted-foreground">吞吐量</span>
        </div>
        <div className="space-y-1.5 pt-1 text-label">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">输入 Token</span>
            <span className="font-mono font-medium text-foreground">{formatMetric(data.inputTokens)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-border-divider/50 pt-1.5">
            <span className="text-muted-foreground">输出 Token</span>
            <span className="font-mono font-medium text-foreground">{formatMetric(data.outputTokens)}</span>
          </div>
          {data.textTokens && data.visionTokens && (data.textTokens.availability === 'known' || data.visionTokens.availability === 'known') ? (
            <div className="flex items-center justify-between border-t border-border-divider/50 pt-1.5">
              <span className="text-muted-foreground">文本 / 视觉 Token</span>
              <span className="font-mono font-medium text-foreground">
                {formatMetric(data.textTokens)} / {formatMetric(data.visionTokens)}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* 卡片 3: 延迟与成本 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-2">
          <span className="flex items-center gap-1.5 text-small font-semibold">
            <Clock className="size-4 text-tech-cyan" aria-hidden />
            耗时与成本
          </span>
          <span className="text-label text-muted-foreground">效能</span>
        </div>
        <div className="space-y-1.5 pt-1 text-label">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">耗时 p95</span>
            <span className="font-mono font-medium text-foreground">{formatMetric(data.durationP95Ms, ' 毫秒')}</span>
          </div>
          <div className="flex items-center justify-between border-t border-border-divider/50 pt-1.5">
            <span className="text-muted-foreground">成本</span>
            <span className="font-mono font-medium text-foreground">{formatMetric(data.cost)}</span>
          </div>
        </div>
      </div>

      {/* 卡片 4: 最近调用记录 */}
      <div className="rounded-lg border border-border-card bg-card p-4 shadow-card">
        <div className="flex items-center justify-between pb-2">
          <span className="text-small font-semibold">最近调用</span>
          <span className="text-label text-muted-foreground">审计</span>
        </div>
        <div className="truncate font-mono text-label font-medium text-foreground">
          {data.lastCallAt ? formatAsOf(data.lastCallAt) : '未采集／未上报'}
        </div>
        <div className="mt-2 border-t border-border-divider/50 pt-2 text-label">
          <span className="text-muted-foreground">错误类别: </span>
          <span className="font-mono text-label text-muted-foreground">
            {data.lastErrorClass ? `错误: ${data.lastErrorClass}` : '无'}
          </span>
        </div>
      </div>
    </div>
  )
}
