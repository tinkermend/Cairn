import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DatasetDetail } from '@cairn/shared'
import { fetchDatasetRows, fetchDatasetProfile } from '@/lib/datasets-api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table2, ChevronLeft, ChevronRight, BarChart3, AlertCircle } from 'lucide-react'

export function DatasetRowsDialog({
  dataset,
  open,
  onOpenChange,
}: {
  dataset: DatasetDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<'rows' | 'profile'>('rows')
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([])

  const rowsQuery = useQuery({
    queryKey: ['dataset-rows', dataset?.id, cursor],
    queryFn: () => (dataset ? fetchDatasetRows(dataset.id, { limit: 50, cursor }) : null),
    enabled: Boolean(dataset && open && activeTab === 'rows'),
  })

  const profileQuery = useQuery({
    queryKey: ['dataset-profile', dataset?.id],
    queryFn: () => (dataset ? fetchDatasetProfile(dataset.id) : null),
    enabled: Boolean(dataset && open && activeTab === 'profile'),
  })

  if (!dataset) return null

  const items = rowsQuery.data?.items ?? []
  const columns = dataset.columns
  const profile = profileQuery.data

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-5xl max-h-[85vh] flex flex-col'>
        <DialogHeader>
          <div className='flex items-center justify-between'>
            <DialogTitle className='flex items-center gap-2'>
              <Table2 className='h-5 w-5 text-primary' />
              {dataset.name}
            </DialogTitle>
            <Badge variant='outline' className='text-xs'>
              共 {dataset.rowCount} 行记录
            </Badge>
          </div>
          <DialogDescription>
            原始文件：{dataset.sourceFilename} {dataset.selectedSheet ? `(${dataset.selectedSheet})` : ''} · 来源：{dataset.sourceType.toUpperCase()}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'rows' | 'profile')}
          className='flex flex-col flex-1 min-h-0'
        >
          <TabsList className='mb-2'>
            <TabsTrigger value='rows' className='gap-1.5'>
              <Table2 className='h-3.5 w-3.5' />
              行数据浏览
            </TabsTrigger>
            <TabsTrigger value='profile' className='gap-1.5'>
              <BarChart3 className='h-3.5 w-3.5' />
              结构画像与预警
            </TabsTrigger>
          </TabsList>

          <TabsContent value='rows' className='flex flex-col flex-1 min-h-0'>
            <div className='flex-1 overflow-auto border rounded-lg'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-14 text-center text-xs'>行号</TableHead>
                    <TableHead className='w-20 text-center text-xs'>状态</TableHead>
                    {columns.map((col) => (
                      <TableHead key={col.key} className='text-xs font-medium'>
                        <div className='flex flex-col'>
                          <span>{col.name}</span>
                          <span className='text-[10px] text-muted-foreground font-mono font-normal'>
                            {col.key}
                          </span>
                        </div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length + 2}
                        className='h-32 text-center text-muted-foreground text-xs'
                      >
                        {rowsQuery.isPending ? '正在加载数据行...' : '暂无数据行'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className='text-center font-mono text-xs text-muted-foreground'>
                          {row.rowIndex + 1}
                        </TableCell>
                        <TableCell className='text-center'>
                          {row.validStatus === 'valid' ? (
                            <Badge variant='outline' className='text-[10px] text-emerald-600 border-emerald-300 dark:text-emerald-400'>
                              有效
                            </Badge>
                          ) : row.validStatus === 'warning' ? (
                            <Badge variant='outline' className='text-[10px] text-amber-600 border-amber-300 dark:text-amber-400'>
                              警告
                            </Badge>
                          ) : (
                            <Badge variant='outline' className='text-[10px] text-destructive border-destructive/30'>
                              异常
                            </Badge>
                          )}
                        </TableCell>
                        {columns.map((col) => (
                          <TableCell
                            key={col.key}
                            className='font-mono text-xs max-w-xs truncate'
                            title={String(row.rowData[col.key] ?? '')}
                          >
                            {String(row.rowData[col.key] ?? '')}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className='flex items-center justify-between pt-2'>
              <span className='text-xs text-muted-foreground'>
                显示 {items.length} 行
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
                  disabled={!rowsQuery.data?.nextCursor}
                  onClick={() => {
                    if (rowsQuery.data?.nextCursor) {
                      setCursorHistory((prev) => [...prev, cursor])
                      setCursor(rowsQuery.data.nextCursor)
                    }
                  }}
                >
                  下一页
                  <ChevronRight className='h-4 w-4 ml-1' />
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value='profile' className='flex flex-col flex-1 min-h-0'>
            {profileQuery.isPending && (
              <div className='h-48 flex items-center justify-center text-sm text-muted-foreground'>
                正在计算数据画像与异常预检...
              </div>
            )}
            {profileQuery.isError && (
              <div className='h-48 flex items-center justify-center text-sm text-destructive gap-2'>
                <AlertCircle className='h-4 w-4' />
                获取数据画像失败
              </div>
            )}
            {profile && (
              <div className='flex flex-col gap-3 flex-1 min-h-0 overflow-auto'>
                <div className='flex flex-wrap items-center gap-4 p-3 rounded-md bg-muted/30 border text-xs'>
                  <div>
                    <span className='text-muted-foreground'>真实总行数: </span>
                    <span className='font-mono font-semibold'>{profile.totalRows}</span>
                  </div>
                  <div>
                    <span className='text-muted-foreground'>分析行数: </span>
                    <span className='font-mono font-semibold'>{profile.analyzedRows}</span>
                    <Badge variant='secondary' className='ml-1 text-[10px]'>
                      {profile.isSampled ? '采样分析' : '全量覆盖'}
                    </Badge>
                  </div>
                  <div>
                    <span className='text-muted-foreground'>算法版本: </span>
                    <span className='font-mono'>{profile.algorithmVersion}</span>
                  </div>
                </div>

                <div className='border rounded-lg overflow-auto'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='text-xs'>字段名称</TableHead>
                        <TableHead className='text-xs'>推断类型</TableHead>
                        <TableHead className='text-xs'>空值率 (缺失数)</TableHead>
                        <TableHead className='text-xs'>唯一值数</TableHead>
                        <TableHead className='text-xs'>文本长度区间</TableHead>
                        <TableHead className='text-xs'>预警与提示</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profile.columns.map((col) => (
                        <TableRow key={col.name}>
                          <TableCell className='text-xs font-medium font-mono'>
                            {col.name}
                          </TableCell>
                          <TableCell>
                            <Badge variant='outline' className='text-[10px] font-mono'>
                              {col.inferredType}
                            </Badge>
                          </TableCell>
                          <TableCell className='text-xs font-mono'>
                            {(col.nullRate * 100).toFixed(1)}% ({col.nullCount})
                          </TableCell>
                          <TableCell className='text-xs font-mono'>
                            {col.distinctCount}
                          </TableCell>
                          <TableCell className='text-xs font-mono text-muted-foreground'>
                            {col.minLength ?? 0} ~ {col.maxLength ?? 0} 字符
                          </TableCell>
                          <TableCell className='text-xs'>
                            {col.sampleAnomalies.length > 0 ? (
                              <div className='flex flex-wrap gap-1'>
                                {col.sampleAnomalies.map((a, i) => (
                                  <Badge
                                    key={i}
                                    variant='outline'
                                    className='text-[10px] text-amber-600 border-amber-300 dark:text-amber-400'
                                  >
                                    {a}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className='text-muted-foreground text-xs'>正常</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
