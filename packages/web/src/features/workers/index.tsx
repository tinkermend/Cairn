import { useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { WorkerStatus, WorkerSummary } from '@cairn/shared'
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronRight,
  MoreHorizontal,
  RefreshCw,
  Search,
  Server,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import {
  disableWorker,
  enableWorker,
  fetchWorkers,
  purgeStaleWorkers,
  removeWorker,
} from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import {
  MISMATCH_LABELS,
  ROUTE_REASON_LABELS,
  WORKER_STATUS_FILTER_LABELS,
  workerLifecycle,
} from './labels'

const STATUS_FILTERS = ['all', 'READY', 'DISABLED', 'DRAINING', 'STOPPED', 'LOST'] as const
const FRESH_FILTERS = ['all', 'fresh', 'stale'] as const

function formatAsOf(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function WorkersPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('all')
  const [fresh, setFresh] = useState<(typeof FRESH_FILTERS)[number]>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 治理弹窗状态
  const [disablingWorker, setDisablingWorker] = useState<WorkerSummary | null>(null)
  const [enablingWorker, setEnablingWorker] = useState<WorkerSummary | null>(null)
  const [removingWorker, setRemovingWorker] = useState<WorkerSummary | null>(null)
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false)

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      status: status === 'all' ? undefined : (status as WorkerStatus),
      heartbeatFresh: fresh === 'all' ? undefined : fresh === 'fresh',
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, status, fresh, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['workers', filters],
    queryFn: () => fetchWorkers(filters),
    placeholderData: keepPreviousData,
  })

  const disableMutation = useMutation({
    mutationFn: (workerId: string) => disableWorker(workerId),
    onSuccess: async () => {
      toast.success('节点已进入禁用维护状态')
      setDisablingWorker(null)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '禁用失败')
    },
  })

  const enableMutation = useMutation({
    mutationFn: (workerId: string) => enableWorker(workerId),
    onSuccess: async () => {
      toast.success('节点已恢复就绪')
      setEnablingWorker(null)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '启用失败')
    },
  })

  const removeMutation = useMutation({
    mutationFn: (workerId: string) => removeWorker(workerId),
    onSuccess: async () => {
      toast.success('节点已成功注销移除')
      setRemovingWorker(null)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '删除失败')
    },
  })

  const purgeMutation = useMutation({
    mutationFn: () => purgeStaleWorkers(),
    onSuccess: async (data) => {
      toast.success(`已成功清理 ${data.purgedCount} 个离线僵尸节点`)
      setPurgeDialogOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '清理失败')
    },
  })

  const items = query.data?.items ?? []
  const selected = items.find((item) => item.workerId === selectedId) ?? items[0]

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='执行节点'
          description='查看 Worker 生命周期、心跳新鲜度、浏览器占用和转发条件。内部入口只对运维权限可见。'
          actions={
            <div className='flex items-center gap-2'>
              <Can permission='session:manage'>
                <Button
                  onClick={() => setPurgeDialogOpen(true)}
                  variant='outline'
                  size='sm'
                  className='text-muted-foreground hover:text-text-primary'
                >
                  <Trash2 className='size-3.5 mr-1 text-muted-foreground' />
                  清理离线节点
                </Button>
              </Can>
              <Button onClick={() => void query.refetch()} variant='outline' size='sm'>
                <RefreshCw className='size-3.5 mr-1' />
                刷新
              </Button>
            </div>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载执行节点' onRetry={() => void query.refetch()} />
        ) : items.length === 0 && !search && status === 'all' && fresh === 'all' ? (
          <EmptyState title='还没有执行节点' description='Worker 启动后会向数据库登记，并出现在此列表。' />
        ) : (
          <>
            <p className='text-label text-muted-foreground'>
              截至 {query.data ? formatAsOf(query.data.asOf) : '—'}
            </p>
            <CollectionSummary
              items={[
                {
                  label: '本页节点',
                  value: items.length,
                  description: '当前页登记',
                  icon: <Server className='size-4' />,
                },
                {
                  label: '在跑',
                  value: items.reduce((sum, item) => sum + item.counts.running, 0),
                  description: '关联 Run 正在执行',
                  icon: <Server className='size-4' />,
                },
                {
                  label: '等待认证',
                  value: items.reduce((sum, item) => sum + item.counts.waitingForAuth, 0),
                  description: '绑定完整的认证占用',
                  icon: <Server className='size-4' />,
                },
                {
                  label: '失联占用',
                  value: items.reduce((sum, item) => sum + item.counts.lostOccupied, 0),
                  description: '仍占账号键',
                  icon: <Server className='size-4' />,
                },
              ]}
            />
            <div className='grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]'>
              <section
                aria-label='执行节点列表'
                className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                  <div className='flex flex-wrap gap-1' aria-label='节点状态筛选'>
                    {STATUS_FILTERS.map((value) => (
                      <Button
                        key={value}
                        variant={status === value ? 'secondary' : 'ghost'}
                        size='sm'
                        aria-pressed={status === value}
                        onClick={() => {
                          setStatus(value)
                          page.reset()
                        }}
                      >
                        {value === 'all' ? '全部状态' : WORKER_STATUS_FILTER_LABELS[value]}
                      </Button>
                    ))}
                  </div>
                  <div className='relative w-full sm:w-64'>
                    <Search className='pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
                    <Input
                      type='search'
                      placeholder='搜索节点 ID...'
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value)
                        page.reset()
                      }}
                      className='pl-9'
                    />
                  </div>
                </div>
                <div className='flex flex-wrap gap-1 border-b border-border-divider px-4 py-2' aria-label='心跳新鲜度'>
                  {FRESH_FILTERS.map((value) => (
                    <Button
                      key={value}
                      variant={fresh === value ? 'secondary' : 'ghost'}
                      size='sm'
                      aria-pressed={fresh === value}
                      onClick={() => {
                        setFresh(value)
                        page.reset()
                      }}
                    >
                      {value === 'all' ? '全部心跳' : value === 'fresh' ? '心跳新鲜' : '心跳过期'}
                    </Button>
                  ))}
                </div>
                {items.length === 0 ? (
                  <EmptyState
                    title='没有匹配的执行节点'
                    description='试试其他关键词，或清除筛选条件。'
                    action={
                      <Button
                        variant='outline'
                        onClick={() => {
                          setSearch('')
                          setStatus('all')
                          setFresh('all')
                          page.reset()
                        }}
                      >
                        清除筛选
                      </Button>
                    }
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>节点与服务地址</TableHead>
                        <TableHead>生命周期</TableHead>
                        <TableHead>占用</TableHead>
                        <TableHead>转发</TableHead>
                        <TableHead className='w-24 text-right'>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => {
                        const life = workerLifecycle(item)
                        return (
                          <TableRow
                            key={item.workerId}
                            className='cursor-pointer'
                            onClick={() => setSelectedId(item.workerId)}
                            data-state={selected?.workerId === item.workerId ? 'selected' : undefined}
                          >
                            <TableCell className='py-4'>
                              <div className='min-w-0'>
                                <button
                                  type='button'
                                  aria-pressed={selected?.workerId === item.workerId}
                                  aria-controls='worker-overview'
                                  className='block max-w-64 truncate rounded-sm text-body font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                                  title={item.workerId}
                                >
                                  {item.workerId}
                                </button>
                                <p className='mt-1 text-label text-muted-foreground flex flex-wrap items-center gap-1.5'>
                                  <span className='font-mono font-medium text-text-secondary'>
                                    {item.listenHost ? `${item.listenHost}:${item.listenPort ?? 8091}` : '未上报端口'}
                                  </span>
                                  {item.hostname ? (
                                    <span className='rounded bg-muted/60 px-1 py-0.5 text-label text-muted-foreground' title='容器/主机名'>
                                      {item.hostname}
                                    </span>
                                  ) : null}
                                  <span>· 容量 {item.capacity}</span>
                                  <span>· 槽位 {item.counts.occupiedSlots}</span>
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>
                              <StatusBadge tone={life.tone}>{life.label}</StatusBadge>
                            </TableCell>
                            <TableCell className='tabular-nums'>
                              {item.counts.running}/{item.counts.holding}/{item.counts.waitingForAuth}
                            </TableCell>
                            <TableCell>
                              <StatusBadge tone={item.routeAvailability === 'eligible' ? 'success' : 'warning'}>
                                {item.routeAvailability === 'eligible'
                                  ? '可转发'
                                  : item.routeReason
                                    ? ROUTE_REASON_LABELS[item.routeReason]
                                    : '不可用'}
                              </StatusBadge>
                            </TableCell>
                            <TableCell className='text-right' onClick={(e) => e.stopPropagation()}>
                              <div className='inline-flex items-center justify-end gap-1'>
                                <Can permission='session:manage'>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant='ghost' size='icon' aria-label={`管理节点 ${item.workerId}`}>
                                        <MoreHorizontal className='size-4' />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align='end' className='w-40'>
                                      {item.status === 'READY' ? (
                                        <DropdownMenuItem onClick={() => setDisablingWorker(item)}>
                                          <Ban className='mr-2 size-4 text-warning' />
                                          禁用节点
                                        </DropdownMenuItem>
                                      ) : null}
                                      {item.status === 'DISABLED' ? (
                                        <DropdownMenuItem onClick={() => setEnablingWorker(item)}>
                                          <CheckCircle2 className='mr-2 size-4 text-success' />
                                          启用节点
                                        </DropdownMenuItem>
                                      ) : null}
                                      {item.status === 'DISABLED' || item.status === 'STOPPED' || item.status === 'LOST' ? (
                                        <DropdownMenuItem
                                          onClick={() => setRemovingWorker(item)}
                                          className='text-destructive focus:text-destructive'
                                        >
                                          <Trash2 className='mr-2 size-4' />
                                          删除节点
                                        </DropdownMenuItem>
                                      ) : null}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </Can>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  aria-label={`查看${item.workerId}概览`}
                                  onClick={() => setSelectedId(item.workerId)}
                                >
                                  <ChevronRight className='size-4' />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}
                <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
                  <p role='status' className='text-label text-muted-foreground'>
                    显示 {items.length} 个节点
                  </p>
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
              </section>
              {selected ? (
                <WorkerOverview
                  worker={selected}
                  asOf={query.data?.asOf}
                  onDisable={() => setDisablingWorker(selected)}
                  onEnable={() => setEnablingWorker(selected)}
                  onRemove={() => setRemovingWorker(selected)}
                />
              ) : null}
            </div>
          </>
        )}
      </Main>

      {/* 禁用确认弹窗 */}
      <ConfirmDialog
        open={Boolean(disablingWorker)}
        onOpenChange={(open) => !open && setDisablingWorker(null)}
        title='禁用执行节点'
        desc={
          <div className='space-y-2 text-body'>
            <p>
              确定要禁用节点 <span className='font-mono font-semibold'>{disablingWorker?.workerId}</span> 吗？
            </p>
            <p className='text-muted-foreground text-small'>
              禁用后该节点将<strong>不再接收新任务调度</strong>。已持有的在途任务将平稳执行直至结束，关联目标系统账号后续产生的新任务与
              Profile 将<strong>自动平滑漂移至其他就绪节点</strong>。
            </p>
          </div>
        }
        confirmText='确认禁用'
        isLoading={disableMutation.isPending}
        handleConfirm={() => disablingWorker && disableMutation.mutate(disablingWorker.workerId)}
      />

      {/* 启用确认弹窗 */}
      <ConfirmDialog
        open={Boolean(enablingWorker)}
        onOpenChange={(open) => !open && setEnablingWorker(null)}
        title='启用执行节点'
        desc={
          <div className='space-y-2 text-body'>
            <p>
              确定要启用节点 <span className='font-mono font-semibold'>{enablingWorker?.workerId}</span> 吗？
            </p>
            <p className='text-muted-foreground text-small'>
              启用后该节点将恢复正常就绪状态，重新承接新任务分配与会话亲和调度。
            </p>
          </div>
        }
        confirmText='确认启用'
        isLoading={enableMutation.isPending}
        handleConfirm={() => enablingWorker && enableMutation.mutate(enablingWorker.workerId)}
      />

      {/* 删除与安全强拦截确认弹窗 */}
      {removingWorker ? (
        <RemoveWorkerDialog
          worker={removingWorker}
          open={Boolean(removingWorker)}
          onOpenChange={(open) => !open && setRemovingWorker(null)}
          isLoading={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate(removingWorker.workerId)}
        />
      ) : null}

      {/* 一键清理离线节点弹窗 */}
      <ConfirmDialog
        open={purgeDialogOpen}
        onOpenChange={setPurgeDialogOpen}
        title='一键清理离线节点'
        desc={
          <div className='space-y-2 text-body'>
            <p>确定要清理所有已停止（STOPPED）或已失联（LOST）的历史僵尸节点吗？</p>
            <p className='text-muted-foreground text-small'>
              此操作将物理清除无任何任务占用的历史离线 Worker 记录（包括早期测试残留），恢复页面清爽。当前在跑的节点不受影响。
            </p>
          </div>
        }
        confirmText='立即清理'
        destructive
        isLoading={purgeMutation.isPending}
        handleConfirm={() => purgeMutation.mutate()}
      />
    </>
  )
}

function RemoveWorkerDialog({
  worker,
  open,
  onOpenChange,
  isLoading,
  onConfirm,
}: {
  worker: WorkerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  isLoading: boolean
  onConfirm: () => void
}) {
  const hasActiveTasks = worker.counts.occupiedSlots > 0 || worker.counts.running > 0
  const isActiveReady = worker.status === 'READY' && worker.heartbeatFresh

  let blockReason: string | null = null
  if (hasActiveTasks) {
    blockReason = `当前节点有名下正在运行的任务或活跃会话（在跑 ${worker.counts.running} 个 / 占用 ${worker.counts.occupiedSlots} 槽位），严禁删除！请先等待任务结束或先将其【禁用】。`
  } else if (isActiveReady) {
    blockReason = '当前节点进程正在正常运行中，严禁直接删除。若要移除请先将节点【禁用】或在服务器上停止 Worker 进程。'
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='注销与删除执行节点'
      disabled={Boolean(blockReason)}
      desc={
        <div className='space-y-3 text-body'>
          {blockReason ? (
            <div className='flex items-start gap-2.5 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-small text-destructive'>
              <AlertTriangle className='size-4 shrink-0 mt-0.5' />
              <div>
                <p className='font-semibold'>操作已被安全阻断</p>
                <p className='mt-1'>{blockReason}</p>
              </div>
            </div>
          ) : (
            <>
              <p>
                确定要物理删除节点 <span className='font-mono font-semibold'>{worker.workerId}</span> 吗？
              </p>
              <p className='text-muted-foreground text-small'>
                该节点的登记记录将被从数据库中彻底移除。若未来在该服务器上重新启动该 Worker 进程，它将自动以全新身份重新注册。
              </p>
            </>
          )}
        </div>
      }
      confirmText={blockReason ? '不允许删除' : '确认删除'}
      destructive={!blockReason}
      isLoading={isLoading}
      handleConfirm={onConfirm}
    />
  )
}

function WorkerOverview({
  worker,
  asOf,
  onDisable,
  onEnable,
  onRemove,
}: {
  worker: WorkerSummary
  asOf?: string
  onDisable: () => void
  onEnable: () => void
  onRemove: () => void
}) {
  const life = workerLifecycle(worker)
  return (
    <aside
      id='worker-overview'
      aria-label='节点概览'
      className='min-w-0 rounded-lg border border-border-card bg-card shadow-card'
    >
      <div className='space-y-4 border-b border-border-divider p-5'>
        <p className='text-label text-muted-foreground'>当前节点</p>
        <h2 className='text-section font-semibold break-all'>{worker.workerId}</h2>
        <div className='flex flex-wrap items-center gap-2'>
          <StatusBadge tone={life.tone}>{life.label}</StatusBadge>
          <StatusBadge tone={worker.routeAvailability === 'eligible' ? 'success' : 'warning'}>
            {worker.routeAvailability === 'eligible'
              ? '可转发'
              : worker.routeReason
                ? ROUTE_REASON_LABELS[worker.routeReason]
                : '不可用'}
          </StatusBadge>
        </div>
      </div>
      <dl className='space-y-4 p-5 text-small'>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>服务网络地址</dt>
          <dd className='font-mono font-medium'>
            {worker.listenHost ? `${worker.listenHost}:${worker.listenPort ?? 8091}` : '未上报'}
          </dd>
        </div>
        {worker.hostname ? (
          <div className='flex justify-between gap-3'>
            <dt className='text-muted-foreground'>容器 / 主机名</dt>
            <dd className='font-mono text-muted-foreground'>{worker.hostname}</dd>
          </div>
        ) : null}
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>心跳时间</dt>
          <dd>{formatAsOf(worker.heartbeatAt)}</dd>
        </div>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>在跑 / 暂停 / 认证</dt>
          <dd className='tabular-nums'>
            {worker.counts.running} / {worker.counts.holding} / {worker.counts.waitingForAuth}
          </dd>
        </div>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>容量 / 已占槽位</dt>
          <dd className='tabular-nums font-medium'>
            {worker.capacity} / {worker.counts.occupiedSlots}
          </dd>
        </div>
        <div className='flex justify-between gap-3'>
          <dt className='text-muted-foreground'>句柄采样</dt>
          <dd>{MISMATCH_LABELS[worker.handleSample.mismatchState]}</dd>
        </div>
        {asOf ? (
          <div className='flex justify-between gap-3'>
            <dt className='text-muted-foreground'>读取时间</dt>
            <dd>{formatAsOf(asOf)}</dd>
          </div>
        ) : null}
      </dl>

      <Can permission='session:manage'>
        <div className='border-t border-border-divider p-4 flex flex-col gap-2'>
          {worker.status === 'READY' ? (
            <Button variant='outline' className='w-full justify-start text-warning hover:text-warning' onClick={onDisable}>
              <Ban className='mr-2 size-4' />
              禁用该节点 (下线维护)
            </Button>
          ) : null}
          {worker.status === 'DISABLED' ? (
            <Button variant='outline' className='w-full justify-start text-success hover:text-success' onClick={onEnable}>
              <CheckCircle2 className='mr-2 size-4' />
              启用该节点
            </Button>
          ) : null}
          {worker.status === 'DISABLED' || worker.status === 'STOPPED' || worker.status === 'LOST' ? (
            <Button
              variant='outline'
              className='w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10'
              onClick={onRemove}
            >
              <Trash2 className='mr-2 size-4' />
              删除该节点记录
            </Button>
          ) : null}
        </div>
      </Can>

      <div className='border-t border-border-divider p-4'>
        <Button variant='outline' className='w-full' asChild>
          <Link to='/workers/$workerId' params={{ workerId: worker.workerId }}>
            查看节点详情
            <ArrowUpRight className='ml-1 size-4' />
          </Link>
        </Button>
      </div>
    </aside>
  )
}
