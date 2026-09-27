import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, HardDrive, Layers, Server } from 'lucide-react'
import type { MonitorCapacityCard, MonitorProfileNodeItem } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMonitorProfiles } from '@/lib/monitoring-api'
import { fetchWorkers } from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { StatusBadge } from '@/components/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { workerLifecycle } from '@/features/workers/labels'
import { FailureAlert, Section } from '../facts'
import {
  formatAsOf,
  formatBytes,
  formatMetric,
  partitionFailure,
  permissionFailure,
} from '../labels'

export function WorkersSection({
  partition,
  canReadWorkers,
}: {
  partition: MonitorCapacityCard
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
    <Section
      title="执行节点"
      action={
        <span className="font-mono text-label text-muted-foreground">
          就绪 {formatMetric(partition.workers.ready)} · 收尾 {formatMetric(partition.workers.draining)} · 已停止 {formatMetric(partition.workers.stopped)} · 失联 {formatMetric(partition.workers.lost)}
        </span>
      }
    >
      {!canReadWorkers ? (
        <FailureAlert {...permissionFailure('查看节点列表需要会话读取权限。可从容量水位了解舰队计数。')} />
      ) : query.isPending ? (
        <PageSkeleton rows={3} />
      ) : query.isError ? (
        query.error instanceof ApiRequestError && query.error.status === 403 ? (
          <FailureAlert {...permissionFailure('当前账号没有会话读取权限。')} />
        ) : (
          <FailureAlert {...partitionFailure('DATA_PLANE_UNAVAILABLE')} />
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[30%] text-label font-medium">节点</TableHead>
                <TableHead className="w-[22%] text-label font-medium">生命周期</TableHead>
                <TableHead className="w-[28%] text-label font-medium">槽位占用</TableHead>
                <TableHead className="w-[20%] text-right text-label font-medium">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data?.items ?? []).map((item) => {
                const lifecycle = workerLifecycle(item)
                const maxSlots = item.maxSessions ?? item.capacity
                const occupied = item.counts.occupiedSlots
                const ratio = maxSlots > 0 ? occupied / maxSlots : 0
                return (
                  <TableRow key={item.workerId} className="h-10 transition-colors hover:bg-muted/20">
                    <TableCell className="font-mono text-body font-medium">
                      <div className="flex items-center gap-2">
                        <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span>{item.workerId}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={lifecycle.tone}>{lifecycle.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="tabular-nums text-body">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono font-medium">
                          {occupied}/{maxSlots}
                        </span>
                        <div className="hidden sm:block h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              'h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none',
                              ratio >= 0.8 ? 'bg-status-warning' : 'bg-primary'
                            )}
                            style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                          />
                        </div>
                        <span className="hidden md:inline font-mono text-label text-muted-foreground">
                          ({Math.round(ratio * 100)}%)
                        </span>
                      </div>
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-divider bg-card px-4 py-2 text-label">
            <span className="font-mono text-muted-foreground">显示 {query.data?.items.length ?? 0} 个节点</span>
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
      )}
    </Section>
  )
}

export function ProfilesSection() {
  const query = useQuery({
    queryKey: ['monitoring', 'profiles'],
    queryFn: () => fetchMonitorProfiles({ limit: 50 }),
    placeholderData: keepPreviousData,
  })

  const items = query.data?.items ?? []
  const nodes = query.data?.nodes ?? []
  const present = items.filter((item) => item.state === 'PRESENT').length
  const absent = items.filter((item) => item.state === 'ABSENT').length
  const pending = items.reduce((sum, item) => sum + item.pendingCleanups, 0)
  const primaryNode = nodes[0]

  return (
    <Section
      title="浏览器与 Profile"
      action={
        <span className="font-mono text-label text-muted-foreground">
          在场 {present} · 缺席 {absent} · 清理积压 {pending}
        </span>
      }
    >
      {query.isPending ? (
        <PageSkeleton rows={3} />
      ) : query.isError ? (
        query.error instanceof ApiRequestError && query.error.status === 403 ? (
          <FailureAlert {...permissionFailure('当前账号不能读取 Profile 落点。')} />
        ) : (
          <FailureAlert {...partitionFailure('AGGREGATE_FAILED')} />
        )
      ) : items.length === 0 ? (
        <EmptyState title="还没有 Profile 落点" description="会话创建后会出现在场或缺席状态。" />
      ) : (
        /* 两列对称网格：左列受管 Profile 环境，右列节点存储采样，彻底杜绝单卡孤立与大片留白 */
        <div className="grid gap-4 lg:grid-cols-2">
          {/* 左列：受管 Profile 环境概况 */}
          <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-border-divider/50 pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Layers className="size-4" aria-hidden />
                  </div>
                  <div>
                    <h4 className="text-body font-semibold text-foreground">受管 Profile 环境</h4>
                    <span className="text-label text-muted-foreground">共纳管 {items.length} 个环境落点</span>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-label" asChild>
                  <Link to="/sessions">
                    前往会话管理
                    <ArrowUpRight className="size-3.5" />
                  </Link>
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-3 py-3.5">
                <div className="rounded-md border border-border-divider/60 bg-muted/20 p-2.5">
                  <div className="flex items-center gap-1.5 text-label text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-status-success" />
                    就绪可用 (在场)
                  </div>
                  <div className="mt-1 font-mono text-stat font-bold tabular-nums text-status-success">
                    {present}
                  </div>
                  <div className="mt-0.5 text-label text-muted-foreground">随时分配会话</div>
                </div>

                <div className="rounded-md border border-border-divider/60 bg-muted/20 p-2.5">
                  <div className="flex items-center gap-1.5 text-label text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                    冷态休眠 (缺席)
                  </div>
                  <div className="mt-1 font-mono text-stat font-bold tabular-nums text-foreground">
                    {absent}
                  </div>
                  <div className="mt-0.5 text-label text-muted-foreground">保留目录待唤醒</div>
                </div>

                <div className="rounded-md border border-border-divider/60 bg-muted/20 p-2.5">
                  <div className="flex items-center gap-1.5 text-label text-muted-foreground">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        pending > 0 ? 'bg-status-warning' : 'bg-muted-foreground/30'
                      )}
                    />
                    待清理积压
                  </div>
                  <div
                    className={cn(
                      'mt-1 font-mono text-stat font-bold tabular-nums',
                      pending > 0 ? 'text-status-warning' : 'text-muted-foreground'
                    )}
                  >
                    {pending}
                  </div>
                  <div className="mt-0.5 text-label text-muted-foreground">
                    {pending > 0 ? '待执行垃圾回收' : '无残留垃圾'}
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-border-divider/50 pt-3">
              <div className="mb-1.5 flex items-center justify-between text-label text-muted-foreground">
                <span>落点分布健康度</span>
                <span className="font-mono">
                  {items.length > 0 ? `${Math.round((present / items.length) * 100)}% 在场可用` : '0%'}
                </span>
              </div>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-status-success transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${items.length > 0 ? (present / items.length) * 100 : 0}%` }}
                />
                <div
                  className="bg-muted-foreground/40 transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${items.length > 0 ? (absent / items.length) * 100 : 0}%` }}
                />
                <div
                  className="bg-status-warning transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${items.length > 0 ? Math.min(100, (pending / items.length) * 100) : 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* 右列：节点存储与落点 */}
          <NodeStorageCard node={primaryNode} />
        </div>
      )}
    </Section>
  )
}

function NodeStorageCard({ node }: { node?: MonitorProfileNodeItem }) {
  const isUsedKnown = node?.diskUsageBytes.availability === 'known'
  const isFreeKnown = node?.diskFreeBytes.availability === 'known'
  const isProfileCountKnown = node?.profileCount.availability === 'known'
  const isMidsceneKnown = node?.midsceneBytes.availability === 'known'
  const usedVal = isUsedKnown ? (node?.diskUsageBytes as { value: number }).value : 0
  const freeVal = isFreeKnown ? (node?.diskFreeBytes as { value: number }).value : 0
  const totalVal = usedVal + freeVal
  const usageRatio = totalVal > 0 ? usedVal / totalVal : 0

  return (
    <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card">
      <div>
        <div className="flex items-center justify-between gap-2 border-b border-border-divider/50 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
              <HardDrive className="size-4" aria-hidden />
            </div>
            <div>
              <h4 className="text-body font-semibold text-foreground">
                {node ? `节点 ${node.workerId}` : '节点磁盘与缓存落点'}
              </h4>
              <span className="text-label text-muted-foreground">存储与缓存采样</span>
            </div>
          </div>
          <span className="font-mono text-label text-muted-foreground">
            {node?.sampledAt ? `上次采样 ${formatAsOf(node.sampledAt)}` : '未采集／未上报'}
          </span>
        </div>

        {node ? (
          <div className="grid grid-cols-3 gap-3 py-3.5">
            <div className="rounded-md border border-border-divider/60 bg-muted/20 p-2.5">
              <div className="text-label text-muted-foreground">磁盘已用容量</div>
              <div className="mt-1 font-mono text-stat font-bold tabular-nums text-foreground">
                {isUsedKnown ? formatBytes(node.diskUsageBytes) : <span className="font-mono font-medium text-muted-foreground/50">--</span>}
              </div>
              <div className="mt-0.5 text-label text-muted-foreground truncate">
                {isUsedKnown ? 'Profile 存储占用' : 'Profile 占用 · 未采集／未上报'}
              </div>
            </div>

            <div className="rounded-md border border-border-divider/60 bg-muted/20 p-2.5">
              <div className="text-label text-muted-foreground">可用空间</div>
              <div className="mt-1 font-mono text-stat font-bold tabular-nums text-foreground">
                {isFreeKnown ? formatBytes(node.diskFreeBytes) : <span className="font-mono font-medium text-muted-foreground/50">--</span>}
              </div>
              <div className="mt-0.5 text-label text-muted-foreground truncate">
                {isFreeKnown ? '节点磁盘空闲' : '磁盘可用 · 未采集／未上报'}
              </div>
            </div>

            <div className="rounded-md border border-border-divider/60 bg-muted/20 p-2.5">
              <div className="text-label text-muted-foreground">Midscene / 目录</div>
              <div className="mt-1 font-mono text-stat font-bold tabular-nums text-foreground">
                {isMidsceneKnown ? formatBytes(node.midsceneBytes) : <span className="font-mono font-medium text-muted-foreground/50">--</span>}
              </div>
              <div className="mt-0.5 text-label text-muted-foreground truncate">
                {isProfileCountKnown ? `${formatMetric(node.profileCount)} 个目录` : '目录 · 未采集／未上报'}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center py-8 text-center text-label text-muted-foreground">
            <span className="font-medium text-foreground">未采集／未上报</span>
            <span className="mt-1 text-muted-foreground">节点就绪后将周期性上报磁盘与缓存落点</span>
          </div>
        )}
      </div>

      <div className="border-t border-border-divider/50 pt-3">
        <div className="mb-1.5 flex items-center justify-between text-label text-muted-foreground">
          <span>存储健康态势</span>
          <span className="font-mono">
            {isUsedKnown && isFreeKnown ? `${Math.round(usageRatio * 100)}% 已用` : '待采样'}
          </span>
        </div>
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${isUsedKnown && isFreeKnown ? Math.round(usageRatio * 100) : 0}%` }}
          />
        </div>
      </div>
    </div>
  )
}
