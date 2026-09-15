import { useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { disposeWorkerSession, fetchWorker } from '@/lib/workers-api'
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
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import {
  MISMATCH_LABELS,
  ROUTE_REASON_LABELS,
  SESSION_STATUS_LABELS,
  workerLifecycle,
} from './labels'

const route = getRouteApi('/_authenticated/workers/$workerId/')

function formatAsOf(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function WorkerDetailPage() {
  const { workerId } = route.useParams()
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const [disposingId, setDisposingId] = useState<string | null>(null)

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

  const worker = query.data?.worker
  const sessions = query.data?.sessions.items ?? []
  const life = worker ? workerLifecycle(worker) : null

  return (
    <>
      <AppHeader
        fixed
        leading={
          <span className='me-auto text-small text-muted-foreground'>
            治理 <span className='mx-2'>/</span> 执行节点
          </span>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title={workerId}
          description={query.data ? `截至 ${formatAsOf(query.data.asOf)}` : '查看节点占用与可处置残留。'}
          actions={
            <Button variant='outline' asChild>
              <Link to='/workers'>
                <ArrowLeft />
                返回列表
              </Link>
            </Button>
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
              <dl className='mt-4 grid gap-4 sm:grid-cols-2 text-small'>
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
                    {sessions.map((session) => (
                      <TableRow key={session.id}>
                        <TableCell>
                          <p className='font-mono text-label break-all'>{session.profileKey}</p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={session.status === 'LOST' ? 'warning' : 'neutral'}>
                            {SESSION_STATUS_LABELS[session.status]}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>{session.health}</TableCell>
                        <TableCell>{session.authState}</TableCell>
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
                    ))}
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
    </>
  )
}
