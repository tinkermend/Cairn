import { useState, useTransition } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { BatchItemStatus } from '@cairn/shared'
import {
  fetchBatch,
  fetchBatchItems,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  retryFailedBatchItems,
  exportBatchResults,
} from '@/lib/batches-api'
import { fetchScenario } from '@/lib/scenarios-api'
import { fetchDataset } from '@/lib/datasets-api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/status-badge'
import { batchStatusTone, batchItemStatusTone } from './labels'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  StopCircle,
} from 'lucide-react'

export function BatchDetailPage({ batchId }: { batchId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [itemStatusFilter, setItemStatusFilter] = useState<string>('all')
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([])
  const [isActionPending, startTransition] = useTransition()
  const [exportPending, setExportPending] = useState(false)

  const batchQuery = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => fetchBatch(batchId),
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.status === 'RUNNING' || data?.status === 'QUEUED' ? 2500 : false
    },
  })

  const batch = batchQuery.data
  const scenarioId = batch?.scenarioId
  const datasetId = batch?.datasetId

  const itemsQuery = useQuery({
    queryKey: ['batch-items', batchId, itemStatusFilter, cursor],
    queryFn: () =>
      fetchBatchItems(batchId, {
        limit: 50,
        cursor,
        status: itemStatusFilter === 'all' ? undefined : (itemStatusFilter as BatchItemStatus),
      }),
    refetchInterval: () =>
      batch?.status === 'RUNNING' || batch?.status === 'QUEUED' ? 3000 : false,
    enabled: Boolean(batch),
  })

  const scenarioQuery = useQuery({
    queryKey: ['scenario', scenarioId],
    queryFn: () => (scenarioId ? fetchScenario(scenarioId) : null),
    enabled: Boolean(scenarioId),
  })

  const datasetQuery = useQuery({
    queryKey: ['dataset', datasetId],
    queryFn: () => (datasetId ? fetchDataset(datasetId) : null),
    enabled: Boolean(datasetId),
  })

  function handlePause() {
    startTransition(async () => {
      await pauseBatch(batchId, { reason: '用户手动暂停' })
      void queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
    })
  }

  function handleResume() {
    startTransition(async () => {
      await resumeBatch(batchId)
      void queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
    })
  }

  function handleCancel() {
    startTransition(async () => {
      await cancelBatch(batchId, { reason: '用户手动终止批次' })
      void queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
    })
  }

  function handleRetryFailed() {
    startTransition(async () => {
      await retryFailedBatchItems(batchId)
      void queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      void queryClient.invalidateQueries({ queryKey: ['batch-items', batchId] })
    })
  }

  async function handleExport() {
    setExportPending(true)
    try {
      const res = await exportBatchResults(batchId)
      const byteCharacters = atob(res.base64)
      const byteNumbers = new Array(byteCharacters.length)
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i)
      }
      const byteArray = new Uint8Array(byteNumbers)
      const blob = new Blob([byteArray], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setExportPending(false)
    }
  }

  if (batchQuery.isPending) {
    return <PageSkeleton />
  }

  if (batchQuery.isError || !batch) {
    return <QueryErrorState title='无法加载批量任务详情' onRetry={() => void batchQuery.refetch()} />
  }

  const items = itemsQuery.data?.items ?? []
  const isCircuitBreakerPaused =
    batch.status === 'PAUSED' &&
    batch.pausedReason?.includes('连续 TARGET 错误')

  const percentComplete =
    batch.totalItems > 0
      ? Math.round(
          ((batch.successItems + batch.failedItems + batch.reviewItems) / batch.totalItems) * 100
        )
      : 0

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <div className='flex items-center gap-2'>
        <Button
          variant='ghost'
          size='sm'
          className='gap-1 text-label'
          onClick={() => void navigate({ to: '/batches' })}
        >
          <ArrowLeft className='h-4 w-4' />
          返回批次列表
        </Button>
      </div>

      <PageHeader
        title={batch.name}
        description={`场景：${scenarioQuery.data?.name ?? batch.scenarioId} · 数据集：${datasetQuery.data?.name ?? batch.datasetId} · 创建于 ${new Date(batch.createdAt).toLocaleString()}${batch.createdByAccountId == null ? ' · 已删除账号' : ''}`}
        actions={
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              className='gap-1 text-label'
              disabled={exportPending}
              onClick={handleExport}
            >
              <Download className='h-3.5 w-3.5' />
              {exportPending ? '正在导出...' : '导出结果 Excel'}
            </Button>

            <Can permission='batch:execute'>
              {batch.status === 'RUNNING' && (
                <Button
                  variant='outline'
                  size='sm'
                  className='gap-1 text-label'
                  disabled={isActionPending}
                  onClick={handlePause}
                >
                  <Pause className='h-3.5 w-3.5' />
                  暂停
                </Button>
              )}

              {batch.status === 'PAUSED' && (
                <Button
                  variant='default'
                  size='sm'
                  className='gap-1 text-label'
                  disabled={isActionPending}
                  onClick={handleResume}
                >
                  <Play className='h-3.5 w-3.5 fill-current' />
                  继续运行
                </Button>
              )}

              {batch.status !== 'COMPLETED' && batch.status !== 'CANCELLED' && (
                <Button
                  variant='destructive'
                  size='sm'
                  className='gap-1 text-label'
                  disabled={isActionPending}
                  onClick={handleCancel}
                >
                  <StopCircle className='h-3.5 w-3.5' />
                  终止
                </Button>
              )}

              {batch.failedItems > 0 && (
                <Button
                  variant='secondary'
                  size='sm'
                  className='gap-1 text-label'
                  disabled={isActionPending || batch.status === 'RUNNING'}
                  onClick={handleRetryFailed}
                >
                  <RefreshCw className='h-3.5 w-3.5' />
                  重试失败项 ({batch.failedItems})
                </Button>
              )}
            </Can>
          </div>
        }
      />

      {batch.status === 'FAILED' && batch.pausedReason && (
        <div className='flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive'>
          <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0' />
          <div>
            <h4 className='text-section font-semibold'>批次未能开始执行</h4>
            <p className='mt-1 text-small text-destructive/90'>{batch.pausedReason}</p>
          </div>
        </div>
      )}

      {/* Circuit Breaker Alert Banner */}
      {isCircuitBreakerPaused && (
        <div className='p-4 rounded-xl border border-destructive/30 bg-destructive/10 text-destructive flex items-start justify-between gap-4'>
          <div className='flex items-start gap-3'>
            <AlertTriangle className='h-5 w-5 shrink-0 mt-0.5' />
            <div>
              <h4 className='font-semibold text-section'>自适应熔断器已触发保护性暂停</h4>
              <p className='text-small mt-1 text-destructive/90'>
                {batch.pausedReason}。系统已阻止并发扩散与无效重试。排查目标系统服务可用性后，可一键恢复运行。
              </p>
            </div>
          </div>
          <div className='flex items-center gap-2 shrink-0'>
            <Can permission='batch:execute'>
              <Button
                size='sm'
                variant='outline'
                className='border-destructive/30 hover:bg-destructive/20 text-label'
                onClick={handleResume}
                disabled={isActionPending}
              >
                恢复执行
              </Button>
              <Button
                size='sm'
                variant='destructive'
                className='text-label'
                onClick={handleCancel}
                disabled={isActionPending}
              >
                终止批次
              </Button>
            </Can>
          </div>
        </div>
      )}

      {/* Multi-segment Progress Bar */}
      {batch.totalItems > 0 && (
        <div className='rounded-xl border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between text-small'>
            <span className='font-medium text-text-primary'>整体执行进度</span>
            <span className='font-mono font-semibold tabular-nums text-text-primary'>
              {percentComplete}% ({batch.successItems + batch.failedItems}/{batch.totalItems})
            </span>
          </div>
          <div className='mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-subtle'>
            {batch.successItems > 0 && (
              <div
                className='bg-status-success transition-[width] duration-300'
                style={{ width: `${(batch.successItems / batch.totalItems) * 100}%` }}
                title={`成功: ${batch.successItems}`}
              />
            )}
            {batch.failedItems > 0 && (
              <div
                className='bg-status-error transition-[width] duration-300'
                style={{ width: `${(batch.failedItems / batch.totalItems) * 100}%` }}
                title={`失败: ${batch.failedItems}`}
              />
            )}
            {batch.reviewItems > 0 && (
              <div
                className='bg-status-warning transition-[width] duration-300'
                style={{ width: `${(batch.reviewItems / batch.totalItems) * 100}%` }}
                title={`需复核: ${batch.reviewItems}`}
              />
            )}
          </div>
          <div className='mt-2.5 flex flex-wrap items-center gap-4 text-label text-muted-foreground'>
            <span className='flex items-center gap-1.5'>
              <span className='size-2 rounded-full bg-status-success' aria-hidden />
              成功 {batch.successItems}
            </span>
            {batch.failedItems > 0 && (
              <span className='flex items-center gap-1.5'>
                <span className='size-2 rounded-full bg-status-error' aria-hidden />
                失败 {batch.failedItems}
              </span>
            )}
            {batch.reviewItems > 0 && (
              <span className='flex items-center gap-1.5'>
                <span className='size-2 rounded-full bg-status-warning' aria-hidden />
                需人工复核 {batch.reviewItems}
              </span>
            )}
            <span className='flex items-center gap-1.5'>
              <span className='size-2 rounded-full bg-surface-subtle' aria-hidden />
              剩余 {Math.max(0, batch.totalItems - batch.successItems - batch.failedItems - batch.reviewItems)}
            </span>
          </div>
        </div>
      )}

      {/* Progress & Metrics Card */}
      <div className='grid grid-cols-2 md:grid-cols-5 gap-3'>
        <div className='p-4 rounded-xl border border-border-card bg-card flex flex-col justify-between shadow-card'>
          <div className='text-label text-muted-foreground'>运行状态</div>
          <div className='flex items-center gap-2 mt-2'>
            <StatusBadge tone={batchStatusTone(batch.status)}>
              {batch.status}
            </StatusBadge>
            <span className='text-label text-muted-foreground font-mono tabular-nums'>{percentComplete}%</span>
          </div>
        </div>

        <div className='p-4 rounded-xl border border-border-card bg-card flex flex-col justify-between shadow-card'>
          <div className='text-label text-muted-foreground'>总执行项</div>
          <div className='text-stat font-bold font-mono text-text-primary mt-1'>{batch.totalItems}</div>
        </div>

        <div className='p-4 rounded-xl border border-border-card bg-card flex flex-col justify-between shadow-card'>
          <div className='text-label text-muted-foreground'>成功执行</div>
          <div className='text-stat font-bold font-mono text-status-success mt-1'>
            {batch.successItems}
          </div>
        </div>

        <div className='p-4 rounded-xl border border-border-card bg-card flex flex-col justify-between shadow-card'>
          <div className='text-label text-muted-foreground'>失败错误</div>
          <div className='text-stat font-bold font-mono text-status-error mt-1'>
            {batch.failedItems}
          </div>
        </div>

        <div className='p-4 rounded-xl border border-border-card bg-card flex flex-col justify-between shadow-card'>
          <div className='text-label text-muted-foreground'>需人工复核</div>
          <div className='text-stat font-bold font-mono text-status-warning mt-1'>
            {batch.reviewItems}
          </div>
        </div>
      </div>

      {/* Items Table Section */}
      <div className='space-y-3'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <h3 className='text-section font-semibold'>执行明细项</h3>
            <Badge variant='outline' className='text-label'>
              共 {itemsQuery.data?.total ?? 0} 项
            </Badge>
          </div>

          <div className='flex items-center gap-2'>
            <Select value={itemStatusFilter} onValueChange={setItemStatusFilter}>
              <SelectTrigger className='h-8 w-36 text-label'>
                <SelectValue placeholder='状态筛选' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部状态</SelectItem>
                <SelectItem value='PENDING'>排队中 (PENDING)</SelectItem>
                <SelectItem value='RUNNING'>运行中 (RUNNING)</SelectItem>
                <SelectItem value='SUCCEEDED'>成功 (SUCCEEDED)</SelectItem>
                <SelectItem value='FAILED'>失败 (FAILED)</SelectItem>
                <SelectItem value='NEEDS_REVIEW'>待复核 (NEEDS_REVIEW)</SelectItem>
                <SelectItem value='CANCELLED'>已取消 (CANCELLED)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className='border rounded-xl bg-card overflow-hidden'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-16 text-center text-label'>行号</TableHead>
                <TableHead className='w-28 text-label'>执行状态</TableHead>
                <TableHead className='w-28 text-label'>判定结论</TableHead>
                <TableHead className='w-24 text-label'>故障归因</TableHead>
                <TableHead className='text-label'>错误详情 / 诊断简讯</TableHead>
                <TableHead className='w-36 text-label'>耗时 / 时间</TableHead>
                <TableHead className='w-24 text-right text-label'>单次运行</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className='h-32 text-center text-small text-muted-foreground'>
                    {itemsQuery.isPending ? '正在加载明细...' : '暂无符合条件的执行项'}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => {
                  const durationMs =
                    item.startedAt && item.finishedAt
                      ? new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()
                      : null

                  return (
                    <TableRow key={item.id}>
                      <TableCell className='text-center font-mono text-small text-muted-foreground'>
                        {item.datasetRowIndex + 1}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={batchItemStatusTone(item.itemStatus)}>
                          {item.itemStatus}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className='text-small font-mono truncate max-w-28'>
                        {item.outcomeVerdict ?? '-'}
                      </TableCell>
                      <TableCell>
                        {item.failureDomain ? (
                          <Badge
                            variant={
                              item.failureDomain === 'TARGET'
                                ? 'destructive'
                                : item.failureDomain === 'SESSION'
                                  ? 'outline'
                                  : 'secondary'
                            }
                            className='text-label font-mono'
                          >
                            {item.failureDomain}
                          </Badge>
                        ) : (
                          <span className='text-small text-muted-foreground'>-</span>
                        )}
                      </TableCell>
                      <TableCell className='text-small text-muted-foreground max-w-md truncate' title={item.errorMessage ?? ''}>
                        {item.errorMessage ?? '-'}
                      </TableCell>
                      <TableCell className='text-small text-muted-foreground font-mono'>
                        {durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : '-'}
                      </TableCell>
                      <TableCell className='text-right'>
                        {item.runId ? (
                          <Link
                            to='/runs/$runId'
                            params={{ runId: item.runId }}
                            className='inline-flex items-center gap-1 text-small text-primary hover:underline font-mono'
                          >
                            <span>查看</span>
                            <ExternalLink className='h-3 w-3' />
                          </Link>
                        ) : (
                          <span className='text-small text-muted-foreground'>-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className='flex items-center justify-between pt-2'>
          <span className='text-small text-muted-foreground'>
            显示 {items.length} 项
          </span>
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={cursorHistory.length === 0}
              onClick={() => {
                const prev = [...cursorHistory]
                const last = prev.pop()
                setCursorHistory(prev)
                setCursor(last)
              }}
            >
              <ChevronLeft className='h-4 w-4 mr-1' />
              上一页
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={!itemsQuery.data?.nextCursor}
              onClick={() => {
                if (itemsQuery.data?.nextCursor) {
                  setCursorHistory((prev) => [...prev, cursor])
                  setCursor(itemsQuery.data.nextCursor)
                }
              }}
            >
              下一页
              <ChevronRight className='h-4 w-4 ml-1' />
            </Button>
          </div>
        </div>
      </div>
    </Main>
  )
}
