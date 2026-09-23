import { Link } from '@tanstack/react-router'
import type { MonitorCapacityCard } from '@cairn/shared'
import { ArrowUpRight, Cpu, HardDrive, Layers, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Section } from '../facts'
import { SegmentedStatusBar } from './segmented-status-bar'
import {
  formatAsOf,
  formatBytes,
  formatMetric,
} from '../labels'

export function CapacityOverview({
  data,
}: {
  data: MonitorCapacityCard
  freshness?: string
}) {
  // 1. Run 容量计算
  const runUsed = data.capacity.used.availability === 'known' ? data.capacity.used.value : 0
  const runTotal = data.capacity.total.availability === 'known' ? data.capacity.total.value : 0
  const runPercent = runTotal > 0 ? Math.round((runUsed / runTotal) * 100) : 0

  // 2. 会话槽位计算
  const sessUsed = data.sessions.used.availability === 'known' ? data.sessions.used.value : 0
  const sessTotal = data.sessions.total.availability === 'known' ? data.sessions.total.value : 0
  const sessPercent = sessTotal > 0 ? Math.round((sessUsed / sessTotal) * 100) : 0

  // 3. Worker 舰队分布
  const workerReady = data.workers.ready.availability === 'known' ? data.workers.ready.value : 0
  const workerDraining = data.workers.draining.availability === 'known' ? data.workers.draining.value : 0
  const workerStopped = data.workers.stopped.availability === 'known' ? data.workers.stopped.value : 0
  const workerLost = data.workers.lost.availability === 'known' ? data.workers.lost.value : 0
  const workerTotal = workerReady + workerDraining + workerStopped + workerLost

  // 4. 槽位状态
  const slotRunning = data.slots.running.availability === 'known' ? data.slots.running.value : 0
  const slotHolding = data.slots.holding.availability === 'known' ? data.slots.holding.value : 0
  const slotWaiting = data.slots.waitingForAuth.availability === 'known' ? data.slots.waitingForAuth.value : 0

  const runBarColor =
    runPercent > 85
      ? 'bg-status-error'
      : runPercent > 70
        ? 'bg-status-warning'
        : 'bg-primary'

  const sessBarColor =
    sessPercent > 85
      ? 'bg-status-error'
      : sessPercent > 70
        ? 'bg-status-warning'
        : 'bg-primary'

  return (
    <Section title="容量水位">
      {/* 核心容量与舰队：Run 容量、会话槽位、Worker 舰队、硬件采样 */}
      <div className={`grid gap-2.5 ${data.workerSamples.items.length === 1 ? 'xl:grid-cols-4 sm:grid-cols-2' : 'lg:grid-cols-3'}`}>
        {/* 卡片 1: Run 容量 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Layers className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">Run 并发容量</span>
            </div>
            <span className="text-label font-medium tabular-nums text-muted-foreground">
              水位 {runPercent}%
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold tabular-nums">{runUsed}</span>
            <span className="text-body text-muted-foreground">/ {runTotal > 0 ? runTotal : '—'} 最大并发</span>
          </div>
          <div className="mt-2">
            <Progress value={runPercent} indicatorClassName={runBarColor} />
          </div>
        </article>

        {/* 卡片 2: 会话槽位分配 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <HardDrive className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">会话槽位分配</span>
            </div>
            <span className="text-label font-medium tabular-nums text-muted-foreground">
              水位 {sessPercent}%
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold tabular-nums">{sessUsed}</span>
            <span className="text-body text-muted-foreground">/ {sessTotal > 0 ? sessTotal : '—'} 总槽位</span>
          </div>
          <div className="mt-2">
            <Progress value={sessPercent} indicatorClassName={sessBarColor} />
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border-divider pt-1.5 text-label text-muted-foreground">
            <span>在跑: {slotRunning}</span>
            <span>调试: {slotHolding}</span>
            <span>待认证: {slotWaiting}</span>
          </div>
        </article>

        {/* 卡片 3: Worker 舰队 */}
        <article className="rounded-lg border border-border-card bg-card p-3 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Server className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-small font-semibold">Worker 舰队状态</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-label tabular-nums text-muted-foreground">共 {workerTotal} 节点</span>
              <Button variant="ghost" size="sm" className="h-6 px-1 text-label" asChild>
                <Link to="/workers">
                  管理
                  <ArrowUpRight className="size-3" />
                </Link>
              </Button>
            </div>
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-stat font-semibold tabular-nums text-status-success">{workerReady}</span>
            <span className="text-body text-muted-foreground">就绪可用</span>
          </div>
          <div className="mt-2">
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
        </article>

        {/* 单节点时作为第 4 张卡片紧凑并排 */}
        {data.workerSamples.items.length === 1 && renderWorkerSample(data.workerSamples.items[0])}
      </div>

      {/* 多节点时在下方网格展示 */}
      {data.workerSamples.items.length > 1 && (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {data.workerSamples.items.map((node) => renderWorkerSample(node))}
        </div>
      )}
    </Section>
  )
}

function renderWorkerSample(
  node: MonitorCapacityCard['workerSamples']['items'][number]
) {
  const cpuVal = node.cpuPercent.availability === 'known' ? node.cpuPercent.value : null
  const loopVal = node.eventLoopDelayMs.availability === 'known' ? node.eventLoopDelayMs.value : null
  const cpuColor =
    cpuVal != null && cpuVal > 85
      ? 'bg-status-error'
      : cpuVal != null && cpuVal > 70
        ? 'bg-status-warning'
        : 'bg-primary'

  return (
    <article
      key={node.workerId}
      className="rounded-lg border border-border-card bg-card p-3 shadow-card"
    >
      <div className="flex items-center justify-between border-b border-border-divider pb-1.5 text-label">
        <div className="flex items-center gap-1.5 font-mono font-semibold text-foreground">
          <Cpu className="size-3.5 text-primary" aria-hidden />
          <span>节点 {node.workerId}</span>
        </div>
        <span className="text-muted-foreground">
          {node.sampledAt ? formatAsOf(node.sampledAt) : '未采集／未上报'}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-label">
        <div>
          <span className="text-muted-foreground">内存 RSS: </span>
          <span className="font-semibold tabular-nums text-foreground">{formatBytes(node.rssBytes)}</span>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">CPU: </span>
            <span className="font-semibold tabular-nums text-foreground">{formatMetric(node.cpuPercent, '%')}</span>
          </div>
          {cpuVal != null && (
            <div className="mt-0.5">
              <Progress value={Math.min(100, Math.max(0, cpuVal))} className="h-1" indicatorClassName={cpuColor} />
            </div>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">事件循环: </span>
          <span className="font-semibold tabular-nums text-foreground">
            {formatMetric(node.eventLoopDelayMs, ' 毫秒')}
          </span>
          {loopVal != null && (
            <span className={`ml-1 text-label ${loopVal < 50 ? 'text-status-success' : 'text-status-warning'}`}>
              {loopVal < 50 ? '· 优' : '· 稍高'}
            </span>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">浏览器进程: </span>
          <span className="font-semibold tabular-nums text-foreground">{formatMetric(node.browserProcessCount)}</span>
        </div>
      </div>
    </article>
  )
}

