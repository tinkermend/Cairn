import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DatasetDetail } from '@cairn/shared'
import {
  FileSpreadsheet,
  Plus,
  Search,
  Trash2,
  Table2,
  Database,
  Layers,
} from 'lucide-react'
import { deleteDataset, fetchDatasets } from '@/lib/datasets-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { CursorPagination } from '@/components/data-table'
import { DatasetUploadDialog } from './upload-dialog'
import { DatasetRowsDialog } from './rows-dialog'

export function DatasetsPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const canReadTargets = useCan('target:read')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [viewingDataset, setViewingDataset] = useState<DatasetDetail | null>(null)
  const [deletingDataset, setDeletingDataset] = useState<DatasetDetail | null>(null)
  const [search, setSearch] = useState('')
  const [targetId, setTargetId] = useState('all')

  const targetsQuery = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      targetId: targetId === 'all' ? undefined : targetId,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, targetId, page.pageSize, page.cursor]
  )

  const datasetsQuery = useQuery({
    queryKey: ['datasets', filters],
    queryFn: () => fetchDatasets(filters),
    placeholderData: keepPreviousData,
  })

  const items = datasetsQuery.data?.items ?? []
  const targetNames = new Map(
    (canReadTargets ? (targetsQuery.data?.items ?? []) : []).map((item) => [item.id, item.name])
  )

  async function handleDeleteConfirm() {
    if (!deletingDataset) return
    try {
      await deleteDataset(deletingDataset.id)
      setDeletingDataset(null)
      void queryClient.invalidateQueries({ queryKey: ['datasets'] })
    } catch {
      // Handled by alert or mutation
    }
  }

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='数据集'
          description='管理测试与批量自动化运行所需的数据集，支持 Excel 与 CSV 格式结构化解析及前导零等文本格式完整保留。'
          actions={
            <Can permission='dataset:write'>
              <Button onClick={() => setUploadOpen(true)}>
                <Plus className='h-4 w-4 mr-1' />
                导入数据集
              </Button>
            </Can>
          }
        />

        {datasetsQuery.isPending ? (
          <PageSkeleton />
        ) : datasetsQuery.isError ? (
          <QueryErrorState
            title='无法加载数据集列表'
            onRetry={() => void datasetsQuery.refetch()}
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '数据集总数',
                  value: items.length,
                  description: '已导入可用于批量测试的数据集',
                  icon: <Database className='h-4 w-4' />,
                },
                {
                  label: '总记录行数',
                  value: items.reduce((sum, item) => sum + item.rowCount, 0),
                  description: '当前页数据集包含的数据行总计',
                  icon: <Layers className='h-4 w-4' />,
                },
              ]}
            />

            <div className='flex flex-wrap items-center gap-3'>
              <div className='relative flex-1 min-w-60'>
                <Search className='absolute left-3 top-2.5 h-4 w-4 text-muted-foreground' />
                <Input
                  aria-label='搜索数据集名称'
                  placeholder='搜索数据集名称...'
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className='pl-9 h-9 text-xs'
                />
              </div>
              {canReadTargets && (
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger aria-label='筛选目标系统' className='w-48 h-9 text-xs'>
                    <SelectValue placeholder='关联目标系统' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>全部目标系统</SelectItem>
                    {targetsQuery.data?.items.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {items.length === 0 ? (
              <EmptyState
                title='暂无数据集'
                description='通过导入 Excel (.xlsx) 或 CSV 格式文件，创建用于场景批量驱动的数据集。'
                action={
                  <Can permission='dataset:write'>
                    <Button onClick={() => setUploadOpen(true)}>
                      <Plus className='h-4 w-4 mr-1' />
                      导入数据集
                    </Button>
                  </Can>
                }
              />
            ) : (
              <div className='border rounded-lg bg-card overflow-hidden'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>数据集名称</TableHead>
                      <TableHead>来源类型</TableHead>
                      <TableHead>原始文件名</TableHead>
                      <TableHead>关联目标</TableHead>
                      <TableHead className='text-right'>行数 / 字段数</TableHead>
                      <TableHead>更新时间</TableHead>
                      <TableHead className='w-32 text-right'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className='font-medium'>
                          <div className='flex items-center gap-2'>
                            <FileSpreadsheet className='h-4 w-4 text-primary shrink-0' />
                            <span>{item.name}</span>
                            {item.createdByAccountId == null && (
                              <span className='text-xs text-muted-foreground'>已删除账号</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant='secondary' className='text-[10px] font-mono'>
                            {item.sourceType.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className='text-xs text-muted-foreground font-mono truncate max-w-48' title={item.sourceFilename}>
                          {item.sourceFilename}
                          {item.selectedSheet ? ` (${item.selectedSheet})` : ''}
                        </TableCell>
                        <TableCell className='text-xs'>
                          {targetNames.get(item.targetId) ?? item.targetId}
                        </TableCell>
                        <TableCell className='text-right text-xs font-mono'>
                          <span className='font-semibold'>{item.rowCount}</span> 行 / {item.columns.length} 字段
                        </TableCell>
                        <TableCell className='text-xs text-muted-foreground'>
                          {new Date(item.updatedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className='text-right'>
                          <div className='flex items-center justify-end gap-1'>
                            <Button
                              type='button'
                              variant='ghost'
                              size='sm'
                              className='h-8 text-xs'
                              onClick={() => setViewingDataset(item)}
                            >
                              <Table2 className='h-3.5 w-3.5 mr-1' />
                              查看数据
                            </Button>
                            <Can permission='dataset:delete'>
                              <Button
                                type='button'
                                variant='ghost'
                                size='sm'
                                className='h-8 w-8 p-0 text-muted-foreground hover:text-destructive'
                                onClick={() => setDeletingDataset(item)}
                              >
                                <Trash2 className='h-3.5 w-3.5' />
                              </Button>
                            </Can>
                          </div>
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
                hasNextPage={Boolean(datasetsQuery.data?.nextCursor)}
                updating={datasetsQuery.isFetching && datasetsQuery.isPlaceholderData}
                onPageSizeChange={page.setPageSize}
                onPreviousPage={page.goPrev}
                onNextPage={() => {
                  if (datasetsQuery.data?.nextCursor) page.goNext(datasetsQuery.data.nextCursor)
                }}
              />
            </div>
          </>
        )}
      </Main>

      <DatasetUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: ['datasets'] })
        }}
      />

      <DatasetRowsDialog
        dataset={viewingDataset}
        open={Boolean(viewingDataset)}
        onOpenChange={(open) => {
          if (!open) setViewingDataset(null)
        }}
      />

      <AlertDialog
        open={Boolean(deletingDataset)}
        onOpenChange={(open) => {
          if (!open) setDeletingDataset(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除数据集？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除数据集「{deletingDataset?.name}」及其包含的所有行数据。若存在依赖此数据集的执行批次，可能导致查询受影响。此操作不可逆。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              onClick={handleDeleteConfirm}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
