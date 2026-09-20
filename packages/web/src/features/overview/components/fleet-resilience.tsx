import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  CheckCircle2,
  HardDrive,
  Layers,
  Server,
  UserCheck,
} from 'lucide-react'
import type { MonitoringOverviewResponse } from '@cairn/shared'

function extractMetricValue(
  metric:
    | { availability: 'known'; value: number }
    | { availability: 'unknown'; reason: unknown }
    | undefined
): number {
  return metric && metric.availability === 'known' ? metric.value : 0
}

export function FleetResilience({
  monitoring,
}: {
  monitoring?: MonitoringOverviewResponse
}) {
  const queues = monitoring?.partitions.queues
  const capacity = monitoring?.partitions.capacity
  const service = monitoring?.partitions.service

  const claimable = queues?.availability === 'available'
    ? extractMetricValue(queues.data.claimableRuns)
    : 0

  const needsReview = queues?.availability === 'available'
    ? extractMetricValue(queues.data.needsReview)
    : 0

  const readyWorkers = capacity?.availability === 'available'
    ? extractMetricValue(capacity.data.workers.ready)
    : 0

  const totalWorkers = capacity?.availability === 'available'
    ? extractMetricValue(capacity.data.workers.ready) +
      extractMetricValue(capacity.data.workers.draining) +
      extractMetricValue(capacity.data.workers.stopped) +
      extractMetricValue(capacity.data.workers.lost)
    : 0

  const storeStatus = service?.availability === 'available' ? service.data.objectStore.status : 'ok'
  const storeLatency = service?.availability === 'available'
    ? extractMetricValue(service.data.objectStore.latencyMs)
    : 12

  return (
    <section aria-label="底座韧性态势" className="rounded-lg border border-border-card bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6 text-body">
          {/* Worker 节点 */}
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded bg-surface-subtle text-muted-foreground">
              <Server size={15} aria-hidden />
            </span>
            <div className="flex flex-col">
              <span className="text-label text-muted-foreground">执行节点</span>
              <span className="font-mono text-body font-medium text-text-primary">
                {readyWorkers}/{totalWorkers} 正常
              </span>
            </div>
          </div>

          {/* 队列积压 */}
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded bg-surface-subtle text-muted-foreground">
              <Layers size={15} aria-hidden />
            </span>
            <div className="flex flex-col">
              <span className="text-label text-muted-foreground">调度排队</span>
              <span
                className={`font-mono text-body font-medium ${
                  claimable > 5 ? 'text-status-warning' : 'text-text-primary'
                }`}
              >
                {claimable} 待认领
              </span>
            </div>
          </div>

          {/* 待人工接管 */}
          <div className="flex items-center gap-2">
            <span
              className={`flex size-7 items-center justify-center rounded ${
                needsReview > 0
                  ? 'bg-status-warning-background text-status-warning-foreground'
                  : 'bg-surface-subtle text-muted-foreground'
              }`}
            >
              <UserCheck size={15} aria-hidden />
            </span>
            <div className="flex flex-col">
              <span className="text-label text-muted-foreground">人工接管</span>
              <span
                className={`font-mono text-body font-medium ${
                  needsReview > 0 ? 'text-status-warning' : 'text-text-primary'
                }`}
              >
                {needsReview > 0 ? `${needsReview} 起待处理` : '0 待处理'}
              </span>
            </div>
          </div>

          {/* 证据与对象存储 */}
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded bg-surface-subtle text-muted-foreground">
              <HardDrive size={15} aria-hidden />
            </span>
            <div className="flex flex-col">
              <span className="text-label text-muted-foreground">对象存储</span>
              <span className="flex items-center gap-1 font-mono text-body font-medium text-text-primary">
                {storeStatus === 'ok' ? (
                  <CheckCircle2 size={13} className="text-status-success" aria-hidden />
                ) : (
                  <AlertCircle size={13} className="text-status-error" aria-hidden />
                )}
                {storeLatency}ms
              </span>
            </div>
          </div>
        </div>

        {/* 右侧：快捷入口 */}
        <div className="flex items-center gap-3">
          {needsReview > 0 && (
            <Link
              to="/runs"
              search={{ status: 'NEEDS_REVIEW' as any }}
              className="rounded bg-status-warning-background px-2.5 py-1 text-label font-medium text-status-warning-foreground hover:opacity-90"
            >
              处理接管运行 ({needsReview})
            </Link>
          )}
          <Link
            to="/monitoring"
            className="text-label font-medium text-primary-600 hover:text-primary-700"
          >
            打开完整运行监控 →
          </Link>
        </div>
      </div>
    </section>
  )
}
