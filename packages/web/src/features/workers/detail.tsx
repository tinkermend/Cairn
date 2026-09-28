import { useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Trash2,
} from 'lucide-react'
import type { WorkerSummary } from '@cairn/shared'
import {
  disableWorker,
  disposeWorkerSession,
  enableWorker,
  fetchWorker,
  removeWorker,
} from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { formatAsOf } from '@/lib/formatters'
import {
  MISMATCH_LABELS,
  ROUTE_REASON_LABELS,
  SESSION_AUTH_STATE_LABELS,
  SESSION_HEALTH_LABELS,
  SESSION_STATUS_LABELS,
  workerLifecycle,
} from './labels'

const route = getRouteApi('/_authenticated/workers/$workerId/')

export function WorkerDetailPage() {
  const { workerId } = route.useParams()
  const navigate = useNavigate()
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const [disposingId, setDisposingId] = useState<string | null>(null)
  const [disabling, setDisabling] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [removing, setRemoving] = useState(false)

  const filters = useMemo(
    () => ({ limit: page.pageSize, cursor: page.cursor }),
    [page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['workers', workerId, filters],
    queryFn: () => fetchWorker(workerId, filters),
    placeholderData: keepPreviousData,
  })

  const dispose = useMutation({
    mutationFn: (sessionId: string) => disposeWorkerSession(sessionId, { note: note.trim() || undefined }),
    onSuccess: async () => {
      toast.success('已提交处置')
      setDisposingId(null)
      setNote('')
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '处置失败')
    },
  })

  const disableMutation = useMutation({
    mutationFn: () => disableWorker(workerId),
    onSuccess: async () => {
      toast.success('节点已标记为禁用维护')
      setDisabling(false)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '禁用节点失败')
    },
  })

  const enableMutation = useMutation({
    mutationFn: () => enableWorker(workerId),
    onSuccess: async () => {
      toast.success('节点已恢复就绪')
      setEnabling(false)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '启用节点失败')
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => removeWorker(workerId),
    onSuccess: async () => {
      toast.success('执行节点记录已成功删除')
      setRemoving(false)
      await queryClient.invalidateQueries({ queryKey: ['workers'] })
      await navigate({ to: '/workers' })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '删除节点失败')
    },
  })

  const worker = query.data?.worker
  const sessions = query.data?.sessions.items ?? []
  const life = worker ? workerLifecycle(worker) : null

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          parent={
            <Link to='/workers' className='inline-flex items-center gap-1.5 hover:text-link'>
              <ArrowLeft className='size-4' />
              返回列表
            </Link>
          }
          title={workerId}
          description={query.data ? `截至 ${formatAsOf(query.data.asOf)}` : '查看节点占用与可处置残留。'}
          actions={
            worker ? (
              <Can permission='session:manage'>
                <div className='flex items-center gap-2'>
                  {worker.status === 'READY' ? (
                    <Button
                      variant='outline'
                      size='sm'
                      className='text-warning hover:text-warning'
                      onClick={() => setDisabling(true)}
                    >
                      <Ban className='mr-1.5 size-4' />
                      禁用节点 (维护)
                    </Button>
                  ) : null}
                  {worker.status === 'DISABLED' ? (
                    <Button
                      variant='outline'
                      size='sm'
                      className='text-success hover:text-success'
                      onClick={() => setEnabling(true)}
                    >
                      <CheckCircle2 className='mr-1.5 size-4' />
                      启用节点
                    </Button>
                  ) : null}
                  {worker.status === 'DISABLED' || worker.status === 'STOPPED' || worker.status === 'LOST' ? (
                    <Button
                      variant='outline'
                      size='sm'
                      className='text-destructive hover:text-destructive hover:bg-destructive/10'
                      onClick={() => setRemoving(true)}
                    >
                      <Trash2 className='mr-1.5 size-4' />
                      删除节点
                    </Button>
                  ) : null}
                </div>
              </Can>
            ) : null
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载执行节点' onRetry={() => void query.refetch()} />
        ) : !worker || !life ? (
          <EmptyState title='执行节点不存在' description='它可能已被移除，或你没有查看权限。' />
        ) : (
          <>
            <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <div className='flex flex-wrap items-center gap-3'>
                <StatusBadge tone={life.tone}>{life.label}</StatusBadge>
                <StatusBadge tone={worker.routeAvailability === 'eligible' ? 'success' : 'warning'}>
                  {worker.routeAvailability === 'eligible'
                    ? '可转发'
                    : worker.routeReason
                      ? ROUTE_REASON_LABELS[worker.routeReason]
                      : '不可用'}
                </StatusBadge>
                <StatusBadge
                  tone={
                    worker.handleSample.mismatchState === 'persistent'
                      ? 'warning'
                      : worker.handleSample.mismatchState === 'pending'
                        ? 'info'
                        : 'neutral'
                  }
                >
                  {MISMATCH_LABELS[worker.handleSample.mismatchState]}
                </StatusBadge>
              </div>
              <p className='mt-3 text-label text-muted-foreground'>
                策略保活不占人工保留配额，但占会话容量。容量不足时先驱逐空闲会话。
              </p>
              <dl className='mt-4 grid gap-4 sm:grid-cols-2 text-small'>
                <div>
                  <dt className='text-label text-muted-foreground'>服务网络地址</dt>
                  <dd className='mt-1 font-mono font-medium'>
                    {worker.listenHost ? `${worker.listenHost}:${worker.listenPort ?? 8091}` : '未上报'}
                  </dd>
                </div>
                {worker.hostname ? (
                  <div>
                    <dt className='text-label text-muted-foreground'>容器 / 主机名</dt>
                    <dd className='mt-1 font-mono text-muted-foreground'>{worker.hostname}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className='text-label text-muted-foreground'>心跳时间</dt>
                  <dd className='mt-1'>{formatAsOf(worker.heartbeatAt)}</dd>
                </div>
                <div>
                  <dt className='text-label text-muted-foreground'>占用 / 失联 / 在跑</dt>
                  <dd className='mt-1 tabular-nums'>
                    {worker.counts.occupiedSlots} / {worker.counts.lostOccupied} / {worker.counts.running}
                  </dd>
                </div>
                <div>
                  <dt className='text-label text-muted-foreground'>调试暂停 / 等待认证 / 过期残留</dt>
                  <dd className='mt-1 tabular-nums'>
                    {worker.counts.holding} / {worker.counts.waitingForAuth} / {worker.counts.expiredLeaseResidue}
                  </dd>
                </div>
                <div>
                  <dt className='text-label text-muted-foreground'>会话容量</dt>
                  <dd className='mt-1 tabular-nums'>{worker.maxSessions}</dd>
                </div>
                {worker.internalEndpoint ? (
                  <div>
                    <dt className='text-label text-muted-foreground'>内部入口</dt>
                    <dd className='mt-1 break-all font-mono text-label'>{worker.internalEndpoint.baseUrl}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
            <section className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
              <div className='border-b border-border-divider p-4'>
                <h2 className='text-section font-semibold'>未关闭占用</h2>
                <p className='mt-1 text-label text-muted-foreground'>
                  计数统计该节点全部相关占用，不随本页筛选变化。
                </p>
              </div>
              {sessions.length === 0 ? (
                <EmptyState title='没有未关闭占用' description='当前节点没有可展示的浏览器占用。' />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>目标 / 账号</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>健康</TableHead>
                      <TableHead>认证</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((session) => {
                      const statusLabel = SESSION_STATUS_LABELS[session.status] ?? session.status
                      const subline = `槽位 #${session.accountSlot ?? 1} · ${statusLabel} · 代次 #${session.generation}`
                      return (
                        <TableRow key={session.id}>
                          <TableCell>
                            <div>
                              <Link
                                className='font-medium text-text-primary underline hover:text-link'
                                to='/sessions/$targetId/$accountId'
                                params={{ targetId: session.targetId, accountId: session.targetAccountId }}
                              >
                                {session.targetName || '未知系统'} · {session.accountDisplayName || '未知账号'}
                              </Link>
                            </div>
                            <div className='text-label text-muted-foreground'>
                              {subline}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge tone={session.status === 'LOST' ? 'warning' : 'neutral'}>
                              {statusLabel}
                            </StatusBadge>
                          </TableCell>
                          <TableCell>{SESSION_HEALTH_LABELS[session.health] ?? session.health}</TableCell>
                          <TableCell>{SESSION_AUTH_STATE_LABELS[session.authState] ?? session.authState}</TableCell>
                          <TableCell>
                          <Can permission='session:dispose'>
                            {session.disposable ? (
                              <Button
                                variant='ghost'
                                size='sm'
                                className='text-destructive'
                                onClick={() => setDisposingId(session.id)}
                              >
                                处置
                              </Button>
                            ) : null}
                          </Can>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  </TableBody>
                </Table>
              )}
              <div className='flex justify-end border-t border-border-divider px-4 py-3'>
                <CursorPagination
                  pageIndex={page.pageIndex}
                  pageSize={page.pageSize}
                  hasPreviousPage={page.pageIndex > 0}
                  hasNextPage={Boolean(query.data?.sessions.nextCursor)}
                  updating={query.isFetching && query.isPlaceholderData}
                  onPageSizeChange={page.setPageSize}
                  onPreviousPage={page.goPrev}
                  onNextPage={() => {
                    if (query.data?.sessions.nextCursor) page.goNext(query.data.sessions.nextCursor)
                  }}
                />
              </div>
            </section>
          </>
        )}
      </Main>
      <ConfirmDialog
        open={Boolean(disposingId)}
        onOpenChange={(open) => {
          if (!open) {
            setDisposingId(null)
            setNote('')
          }
        }}
        title='处置残留占用'
        desc='请确认旧浏览器已停止或已隔离。处置只改持久化状态，不会关闭远程浏览器。'
        confirmText='确认处置'
        destructive
        isLoading={dispose.isPending}
        handleConfirm={() => {
          if (disposingId) dispose.mutate(disposingId)
        }}
      >
        <Input
          aria-label='处置说明'
          placeholder='可选说明，将写入审计'
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </ConfirmDialog>

      {/* 禁用确认弹窗 */}
      <ConfirmDialog
        open={disabling}
        onOpenChange={setDisabling}
        title='禁用执行节点'
        desc={
          <div className='space-y-2 text-body'>
            <p>
              确定要禁用节点 <span className='font-mono font-semibold'>{workerId}</span> 吗？
            </p>
            <p className='text-muted-foreground text-small'>
              禁用后该节点将<strong>不再接收新任务调度</strong>。已持有的在途任务将平稳执行直至结束，关联目标系统账号后续产生的新任务与
              Profile 将<strong>自动平滑漂移至其他就绪节点</strong>。
            </p>
          </div>
        }
        confirmText='确认禁用'
        isLoading={disableMutation.isPending}
        handleConfirm={() => disableMutation.mutate()}
      />

      {/* 启用确认弹窗 */}
      <ConfirmDialog
        open={enabling}
        onOpenChange={setEnabling}
        title='启用执行节点'
        desc={
          <div className='space-y-2 text-body'>
            <p>
              确定要启用节点 <span className='font-mono font-semibold'>{workerId}</span> 吗？
            </p>
            <p className='text-muted-foreground text-small'>
              启用后该节点将恢复正常就绪状态，重新承接新任务分配与会话亲和调度。
            </p>
          </div>
        }
        confirmText='确认启用'
        isLoading={enableMutation.isPending}
        handleConfirm={() => enableMutation.mutate()}
      />

      {/* 删除与安全强拦截确认弹窗 */}
      {worker && removing ? (
        <RemoveWorkerDialog
          worker={worker}
          open={removing}
          onOpenChange={setRemoving}
          isLoading={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate()}
        />
      ) : null}
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

