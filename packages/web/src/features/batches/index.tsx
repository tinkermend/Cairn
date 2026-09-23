import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Layers,
  Plus,
  Play,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react'
import { fetchBatches } from '@/lib/batches-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchDatasets } from '@/lib/datasets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { Can } from '@/components/rbac/can'
import { CursorPagination } from '@/components/data-table'
import { BatchCreateWizard } from './create-wizard'

export function BatchesPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [scenarioFilter, setScenarioFilter] = useState('all')

  const scenariosQuery = useQuery({
    queryKey: ['scenarios', { limit: 100 }],
    queryFn: () => fetchScenarios({ limit: 100 }),
  })

  const datasetsQuery = useQuery({
    queryKey: ['datasets', { limit: 100 }],
    queryFn: () => fetchDatasets({ limit: 100 }),
  })

  const filters = useMemo(
    () => ({
      scenarioId: scenarioFilter === 'all' ? undefined : scenarioFilter,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [scenarioFilter, page.pageSize, page.cursor]
  )

  const batchesQuery = useQuery({
    queryKey: ['batches', filters],
    queryFn: () => fetchBatches(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  })

  const items = batchesQuery.data?.items ?? []
  const scenarioNames = new Map((scenariosQuery.data?.items ?? []).map((s) => [s.id, s.name]))
  const datasetNames = new Map((datasetsQuery.data?.items ?? []).map((d) => [d.id, d.name]))

  const runningCount = items.filter((b) => b.status === 'RUNNING').length
  const pausedCount = items.filter((b) => b.status === 'PAUSED').length
  const completedCount = items.filter((b) => b.status === 'COMPLETED').length

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='批量自动化运行 (Batches)'
          description='基于数据表列与动态生成器驱动的高并发场景批量运行，支持自适应熔断与防风控节奏保护。'
          actions={
            <Can permission='batch:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className='h-4 w-4 mr-1' />
                新建批量运行
              </Button>
            </Can>
          }
        />

        {batchesQuery.isPending ? (
          <PageSkeleton />
        ) : batchesQuery.isError ? (
          <QueryErrorState
            title='无法加载批次列表'
            onRetry={() => void batchesQuery.refetch()}
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '批次总数',
                  value: items.length,
                  description: '当前页自动化批量运行总数',
                  icon: <Layers className='h-4 w-4' />,
                },
                {
                  label: '运行中',
                  value: runningCount,
                  description: '当前正在并发执行中的批次',
                  icon: <Play className='h-4 w-4' />,
                },
                {
                  label: '熔断 / 暂停',
                  value: pausedCount,
                  description: '因保护机制或人工介入处于暂停状态',
                  icon: <AlertTriangle className='h-4 w-4' />,
                },
                {
                  label: '已完成',
                  value: completedCount,
                  description: '所有项均已执行完毕并产生判定结论',
                  icon: <CheckCircle2 className='h-4 w-4' />,
                },
              ]}
            />

            <div className='flex items-center gap-3'>
              <Select value={scenarioFilter} onValueChange={setScenarioFilter}>
                <SelectTrigger className='w-56 h-9 text-xs'>
                  <SelectValue placeholder='按场景筛选' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部场景</SelectItem>
                  {scenariosQuery.data?.items.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {items.length === 0 ? (
              <EmptyState
                title='暂无批量自动化任务'
                description='通过选择场景与驱动数据集，启动多实例、多参数的自动化批量运行。'
                action={
                  <Can permission='batch:write'>
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className='h-4 w-4 mr-1' />
                      新建批量运行
                    </Button>
                  </Can>
                }
              />
            ) : (
              <div className='border rounded-xl bg-card overflow-hidden'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>批次名称</TableHead>
                      <TableHead>关联场景</TableHead>
                      <TableHead>驱动数据集</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className='text-right'>执行进度 (成功/失败/总项)</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead className='w-24 text-right'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((batch) => (
                      <TableRow key={batch.id}>
                        <TableCell className='font-medium'>
                          <Link
                            to='/batches/$batchId'
                            params={{ batchId: batch.id }}
                            className='hover:underline text-foreground flex items-center gap-1.5'
                          >
                            <Layers className='h-4 w-4 text-primary shrink-0' />
                            <span>{batch.name}</span>
                            {batch.createdByAccountId == null && (
                              <span className='text-xs text-muted-foreground'>已删除账号</span>
                            )}
                          </Link>
                        </TableCell>
                        <TableCell className='text-xs'>
                          {scenarioNames.get(batch.scenarioId) ?? batch.scenarioId}
                        </TableCell>
                        <TableCell className='text-xs'>
                          {datasetNames.get(batch.datasetId) ?? batch.datasetId}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              batch.status === 'COMPLETED'
                                ? 'secondary'
                                : batch.status === 'RUNNING'
                                  ? 'default'
                                  : batch.status === 'PAUSED'
                                    ? 'destructive'
                                    : 'outline'
                            }
                            className='text-[10px] font-mono'
                          >
                            {batch.status}
                          </Badge>
                        </TableCell>
                        <TableCell className='text-right text-xs font-mono'>
                          <span className='text-emerald-600 dark:text-emerald-400 font-bold'>
                            {batch.successItems}
                          </span>
                          {' / '}
                          <span className='text-destructive font-bold'>{batch.failedItems}</span>
                          {' / '}
                          <span>{batch.totalItems}</span>
                        </TableCell>
                        <TableCell className='text-xs text-muted-foreground'>
                          {new Date(batch.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className='text-right'>
                          <Button
                            type='button'
                            variant='ghost'
                            size='sm'
                            className='h-8 text-xs gap-1'
                            onClick={() => void navigate({ to: `/batches/${batch.id}` })}
                          >
                            <span>详情</span>
                            <ExternalLink className='h-3 w-3' />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
              <p role='status' className='text-label text-muted-foreground'>
                本页 {items.length} 条
              </p>
              <CursorPagination
                pageIndex={page.pageIndex}
                pageSize={page.pageSize}
                hasPreviousPage={page.pageIndex > 0}
                hasNextPage={Boolean(batchesQuery.data?.nextCursor)}
                updating={batchesQuery.isFetching && batchesQuery.isPlaceholderData}
                onPageSizeChange={page.setPageSize}
                onPreviousPage={page.goPrev}
                onNextPage={() => {
                  if (batchesQuery.data?.nextCursor) page.goNext(batchesQuery.data.nextCursor)
                }}
              />
            </div>
          </>
        )}
      </Main>

      <BatchCreateWizard
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(id) => {
          void queryClient.invalidateQueries({ queryKey: ['batches'] })
          void navigate({ to: `/batches/${id}` })
        }}
      />
    </>
  )
}
