import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { MonitorServiceCard } from '@cairn/shared'
import {
  Activity,
  Database,
  Radio,
  Server,
} from 'lucide-react'
import { probeObjectStore } from '@/lib/monitoring-api'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { Section } from '../facts'
import {
  apiStatusTone,
  formatAsOf,
  formatMetric,
  objectFailure,
  objectStoreTone,
  pingTone,
  schemaTone,
} from '../labels'

export function InfrastructureGrid({
  data,
  canProbe,
}: {
  data: MonitorServiceCard
  freshness?: string
  canProbe: boolean
}) {
  const queryClient = useQueryClient()
  const probe = useMutation({
    mutationFn: () => probeObjectStore(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['monitoring'] })
    },
  })

  const api = apiStatusTone(data.api.status)
  const ping = pingTone(data.database.ping)
  const schema = schemaTone(data.database.schemaConsistency)
  const hintUnused = data.changeHint.status === 'unused'
  const realtimeDown = data.changeHint.status === 'down'
  const store = objectStoreTone(data.objectStore.status)

  const dbBadge =
    data.database.ping === 'down'
      ? { tone: 'error' as const, label: '被监控对象故障' }
      : ping

  const storeBadge =
    data.objectStore.status.availability === 'known' && data.objectStore.status.value !== 1
      ? { tone: 'error' as const, label: '被监控对象故障' }
      : store

  return (
    <Section title="核心服务连通">
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {/* 1. API 实例 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Server className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">API 实例</span>
            </div>
            <StatusBadge tone={api.tone}>{api.label}</StatusBadge>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold tabular-nums">{formatMetric(data.apiInstances.ready)}</span>
            <span className="text-body text-muted-foreground">就绪</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-label text-muted-foreground">
            <span>运行: {formatMetric(data.api.uptimeSeconds, 's')}</span>
            {data.apiInstances.derivedCount.availability === 'known' && (
              <span>(自动派生)</span>
            )}
          </div>
        </article>

        {/* 2. 数据库 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Database className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">数据库</span>
            </div>
            <StatusBadge tone={dbBadge.tone}>{dbBadge.label}</StatusBadge>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold capitalize">{data.database.driver}</span>
            {data.database.ping === 'up' && data.database.pingLatencyMs.availability === 'known' && (
              <span className="text-body text-muted-foreground tabular-nums">
                {data.database.pingLatencyMs.value}ms
              </span>
            )}
          </div>
          <div className="mt-1 text-label text-muted-foreground">
            {data.database.ping === 'down' ? (
              <span className="text-status-error">{objectFailure('数据库不可达。').description}</span>
            ) : (
              <span>
                Schema: {schema.label} · 连接池: {formatMetric(data.database.pool.totalCount)}
              </span>
            )}
          </div>
        </article>

        {/* 3. 提示通道 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Radio className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">提示通道</span>
            </div>
            <StatusBadge
              tone={
                hintUnused
                  ? 'neutral'
                  : realtimeDown
                    ? 'warning'
                    : 'success'
              }
            >
              {hintUnused ? '未使用' : realtimeDown ? '降级' : '可用'}
            </StatusBadge>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold uppercase">{data.changeHint.status}</span>
          </div>
          <div className="mt-1 text-label text-muted-foreground">
            {data.changeHint.consequence ?? (data.changeHint.realtime ? '实时进度可用' : '实时进度不可用')}
          </div>
        </article>

        {/* 4. 对象存储 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Activity className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">对象存储</span>
            </div>
            <div className="flex items-center gap-1.5">
              {canProbe && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-label"
                  disabled={probe.isPending}
                  onClick={() => probe.mutate()}
                >
                  {probe.isPending ? '探测中…' : '探测'}
                </Button>
              )}
              <StatusBadge tone={storeBadge.tone}>{storeBadge.label}</StatusBadge>
            </div>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold">
              {data.objectStore.status.availability === 'known' ? storeBadge.label : '未采集／未上报'}
            </span>
            {data.objectStore.latencyMs.availability === 'known' && (
              <span className="text-body text-muted-foreground tabular-nums">
                {data.objectStore.latencyMs.value}ms
              </span>
            )}
          </div>
          <div className="mt-1 text-label text-muted-foreground truncate">
            {data.objectStore.probedAt ? `探测于 ${formatAsOf(data.objectStore.probedAt)}` : '等待主动探测'}
          </div>
        </article>
      </div>
    </Section>
  )
}
