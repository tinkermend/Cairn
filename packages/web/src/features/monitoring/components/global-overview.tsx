import { Bot, Database, HardDrive, Layers, Radio, Server, ShieldCheck } from 'lucide-react'
import type {
  MonitorAiCard,
  MonitoringOverviewResponse,
  MonitorSlaCard,
} from '@cairn/shared'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { FailureAlert, Section } from '../facts'
import { formatMetric, partitionFailure } from '../labels'
import { SegmentedStatusBar } from './segmented-status-bar'

type ServicePartition = MonitoringOverviewResponse['partitions']['service']
type CapacityPartition = MonitoringOverviewResponse['partitions']['capacity']

export function GlobalOverview({
  service,
  capacity,
  sla,
  ai,
}: {
  service: ServicePartition
  capacity: CapacityPartition
  sla?: MonitorSlaCard
  ai?: MonitorAiCard
}) {
  return (
    <Section title="全局概览">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {service.availability === 'available' ? (
          <ServiceCard service={service.data} />
        ) : (
          <FailureCard>
            <FailureAlert {...partitionFailure(service.reasonCode)} />
          </FailureCard>
        )}

        <SlaCard sla={sla} />

        <AiCard ai={ai} />

        {capacity.availability === 'available' ? (
          <CapacityFleetCard capacity={capacity.data} />
        ) : (
          <FailureCard>
            <FailureAlert {...partitionFailure(capacity.reasonCode)} />
          </FailureCard>
        )}
      </div>
    </Section>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <article className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-3.5 shadow-card transition-colors hover:border-border-hover">
      {children}
    </article>
  )
}

function FailureCard({ children }: { children: React.ReactNode }) {
  return <article className="flex flex-col justify-center rounded-lg border border-border-card bg-card p-3.5 shadow-card">{children}</article>
}

function ServiceCard({ service }: { service: Extract<ServicePartition, { availability: 'available' }>['data'] }) {
  const dbOk = service.database.ping === 'up'
  const storeOk = service.objectStore.status.availability === 'known' && service.objectStore.status.value === 1
  const sseOk = service.changeHint.status !== 'down'
  const allServicesHealthy = dbOk && storeOk && sseOk

  return (
    <CardShell>
      <div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-small font-semibold text-foreground">
            <Server className="size-4 text-primary" aria-hidden />
            核心服务基线
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label font-medium ${
              allServicesHealthy
                ? 'border border-status-success/30 bg-status-success-background text-status-success-foreground'
                : 'border border-status-error/30 bg-status-error-background text-status-error-foreground'
            }`}
          >
            <span className={`size-1.5 rounded-full ${allServicesHealthy ? 'bg-status-success' : 'bg-status-error'}`} />
            {allServicesHealthy ? '就绪' : '异常'}
          </span>
        </div>

        <div className="mt-2.5 space-y-1.5 text-label">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Database className="size-3 text-muted-foreground" />
              PostgreSQL
            </span>
            <span className="font-mono font-medium text-foreground">
              {dbOk
                ? `${service.database.pingLatencyMs.availability === 'known' ? service.database.pingLatencyMs.value : '—'}ms`
                : '断开'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <HardDrive className="size-3 text-muted-foreground" />
              对象存储
            </span>
            <span className="font-mono font-medium text-foreground">
              {storeOk ? `${service.objectStore.latencyMs.availability === 'known' ? service.objectStore.latencyMs.value : '—'}ms` : '未就绪'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Radio className="size-3 text-muted-foreground" />
              提示通道
            </span>
            <span className="font-mono font-medium text-foreground uppercase">{service.changeHint.status}</span>
          </div>
        </div>
      </div>

      <div className="mt-2.5 border-t border-border-divider/50 pt-1.5 text-label text-muted-foreground">
        <span>API 实例: {formatMetric(service.apiInstances.ready)} 就绪</span>
      </div>
    </CardShell>
  )
}

function SlaCard({ sla }: { sla?: MonitorSlaCard }) {
  const totalRuns = sla?.totalRuns ?? 0
  const successRate = sla?.successRate ?? 100
  const failedRuns = sla?.failedRuns ?? 0
  const p95Duration = sla?.p95DurationMs != null ? `${(sla.p95DurationMs / 1000).toFixed(1)}s` : '—'
  const rpm = sla?.throughputRpm ?? 0

  return (
    <CardShell>
      <div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-small font-semibold text-foreground">
            <ShieldCheck className="size-4 text-tech-purple-primary" aria-hidden />
            业务执行 SLA (24h)
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label font-medium ${
              successRate >= 95
                ? 'border border-status-success/30 bg-status-success-background text-status-success-foreground'
                : 'border border-status-warning/30 bg-status-warning-background text-status-warning-foreground'
            }`}
          >
            <span className={`size-1.5 rounded-full ${successRate >= 95 ? 'bg-status-success' : 'bg-status-warning'}`} />
            {successRate}% 通过
          </span>
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          <span
            className={cn(
              'font-mono text-stat font-bold tabular-nums',
              successRate >= 95
                ? 'text-status-success-foreground'
                : successRate >= 80
                  ? 'text-status-warning-foreground'
                  : 'text-status-error-foreground'
            )}
          >
            {successRate}%
          </span>
          <span className="text-label text-muted-foreground">
            总运行 {totalRuns} 次
          </span>
        </div>

        <div className="mt-2">
          <Progress
            value={successRate}
            indicatorClassName={successRate >= 95 ? 'bg-status-success' : successRate >= 80 ? 'bg-status-warning' : 'bg-status-error'}
          />
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-border-divider/50 pt-1.5 text-label text-muted-foreground">
        <span>
          失败:{' '}
          <strong
            className={cn(
              'font-mono',
              failedRuns > 0
                ? 'rounded bg-status-error-background px-1.5 py-0.5 font-bold text-status-error-foreground'
                : 'text-foreground'
            )}
          >
            {failedRuns}
          </strong>
        </span>
        <span>P95 耗时: <strong className="font-mono text-foreground">{p95Duration}</strong></span>
        <span>吞吐: <strong className="font-mono text-foreground">{rpm}</strong> RPM</span>
      </div>
    </CardShell>
  )
}

function AiCard({ ai }: { ai?: MonitorAiCard }) {
  const aiCalls = ai?.calls.availability === 'known' ? ai.calls.value : 0
  const aiErrors = ai?.errors.availability === 'known' ? ai.errors.value : 0
  const aiDuration = ai?.durationP95Ms.availability === 'known' ? `${(ai.durationP95Ms.value / 1000).toFixed(1)}s` : '—'

  return (
    <CardShell>
      <div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-small font-semibold text-foreground">
            <Bot className="size-4 text-tech-cyan" aria-hidden />
            AI 推理流速
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-tech-cyan/30 bg-tech-cyan/10 px-2 py-0.5 text-label font-medium text-tech-cyan">
            <span className="size-1.5 rounded-full bg-tech-cyan" />
            模型在线
          </span>
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-stat font-bold tabular-nums text-foreground">{aiCalls}</span>
          <span className="text-label text-muted-foreground">次调用 (24h)</span>
        </div>

        <div className="mt-2.5 space-y-1.5 text-label">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">调用失败</span>
            <span
              className={cn(
                'font-mono font-medium',
                aiErrors > 0
                  ? 'rounded bg-status-warning-background px-1.5 py-0.5 font-bold text-status-warning-foreground'
                  : 'text-foreground'
              )}
            >
              {aiErrors} 次
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">P95 响应耗时</span>
            <span className="font-mono font-medium text-foreground">{aiDuration}</span>
          </div>
        </div>
      </div>

      <div className="mt-2.5 border-t border-border-divider/50 pt-1.5 text-label text-muted-foreground">
        <span>Token: 入 {ai?.inputTokens ? formatMetric(ai.inputTokens) : '—'} · 出 {ai?.outputTokens ? formatMetric(ai.outputTokens) : '—'}</span>
      </div>
    </CardShell>
  )
}

function CapacityFleetCard({ capacity }: { capacity: Extract<CapacityPartition, { availability: 'available' }>['data'] }) {
  const runUsed = capacity.capacity.used.availability === 'known' ? capacity.capacity.used.value : 0
  const runTotal = capacity.capacity.total.availability === 'known' ? capacity.capacity.total.value : 0
  const runPercent = runTotal > 0 ? Math.round((runUsed / runTotal) * 100) : 0

  const sessUsed = capacity.sessions.used.availability === 'known' ? capacity.sessions.used.value : 0
  const sessTotal = capacity.sessions.total.availability === 'known' ? capacity.sessions.total.value : 0

  const workerReady = capacity.workers.ready.availability === 'known' ? capacity.workers.ready.value : 0
  const workerDraining = capacity.workers.draining.availability === 'known' ? capacity.workers.draining.value : 0
  const workerStopped = capacity.workers.stopped.availability === 'known' ? capacity.workers.stopped.value : 0
  const workerLost = capacity.workers.lost.availability === 'known' ? capacity.workers.lost.value : 0
  const workerTotal = workerReady + workerDraining + workerStopped + workerLost

  const slotRunning = capacity.slots.running.availability === 'known' ? capacity.slots.running.value : 0
  const slotHolding = capacity.slots.holding.availability === 'known' ? capacity.slots.holding.value : 0
  const slotWaiting = capacity.slots.waitingForAuth.availability === 'known' ? capacity.slots.waitingForAuth.value : 0

  const samples = capacity.workerSamples.items
  const maxCpu = samples.reduce((acc, s) => {
    const val = s.cpuPercent.availability === 'known' ? s.cpuPercent.value : 0
    return Math.max(acc, val)
  }, 0)
  const maxDiskPercent = samples.reduce((acc, s) => {
    const val = s.diskUsagePercent?.availability === 'known' ? s.diskUsagePercent.value : 0
    return Math.max(acc, val)
  }, 0)

  return (
    <CardShell>
      <div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-small font-semibold text-foreground">
            <Layers className="size-4 text-primary" aria-hidden />
            平台容量与舰队
          </span>
          <span
            className={cn(
              'font-mono text-label',
              runPercent > 80
                ? 'font-bold text-status-error-foreground'
                : runPercent > 60
                  ? 'font-bold text-status-warning-foreground'
                  : 'text-muted-foreground'
            )}
          >
            水位 {runPercent}%
          </span>
        </div>

        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-stat font-bold tabular-nums text-foreground">{runUsed}</span>
          <span className="text-label text-muted-foreground">/ {runTotal > 0 ? runTotal : '—'} 并发 Run</span>
        </div>

        <div className="mt-2">
          <Progress
            value={runPercent}
            indicatorClassName={runPercent > 80 ? 'bg-status-error' : runPercent > 60 ? 'bg-status-warning' : 'bg-primary'}
          />
        </div>

        <div className="mt-2.5">
          <SegmentedStatusBar
            total={workerTotal}
            segments={[
              { key: 'ready', label: '就绪', count: workerReady, color: 'var(--status-success)' },
              { key: 'draining', label: '收尾', count: workerDraining, color: 'var(--status-warning)' },
              { key: 'stopped', label: '已停止', count: workerStopped, color: 'var(--chart-3)' },
              { key: 'lost', label: '失联', count: workerLost, color: 'var(--status-error)' },
            ]}
          />
        </div>
      </div>

      <div className="mt-2.5 space-y-1 border-t border-border-divider/50 pt-1.5 text-label text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>会话: <strong className="font-mono text-foreground">{sessUsed}</strong>/{sessTotal}</span>
          <span>最高 CPU/盘: <strong className="font-mono text-foreground">{maxCpu}% / {maxDiskPercent}%</strong></span>
        </div>
        <div className="flex items-center justify-between">
          <span>在跑: {slotRunning}</span>
          <span>调试: {slotHolding}</span>
          <span>待认证: {slotWaiting}</span>
        </div>
      </div>
    </CardShell>
  )
}
