import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DatasetDetail } from '@cairn/shared'
import { fetchDatasetRows } from '@/lib/datasets-api'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table2, ChevronLeft, ChevronRight } from 'lucide-react'

export function DatasetRowsDialog({
  dataset,
  open,
  onOpenChange,
}: {
  dataset: DatasetDetail | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([])

  const rowsQuery = useQuery({
    queryKey: ['dataset-rows', dataset?.id, cursor],
    queryFn: () => (dataset ? fetchDatasetRows(dataset.id, { limit: 50, cursor }) : null),
    enabled: Boolean(dataset && open),
  })

  if (!dataset) return null

  const items = rowsQuery.data?.items ?? []
  const columns = dataset.columns

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-5xl max-h-[85vh] flex flex-col'>
        <DialogHeader>
          <div className='flex items-center justify-between'>
            <DialogTitle className='flex items-center gap-2'>
              <Table2 className='h-5 w-5 text-primary' />
              {dataset.name} - 行数据浏览
            </DialogTitle>
            <Badge variant='outline' className='text-xs'>
              共 {dataset.rowCount} 行记录
            </Badge>
          </div>
          <DialogDescription>
            原始文件：{dataset.sourceFilename} {dataset.selectedSheet ? `(${dataset.selectedSheet})` : ''} · 来源：{dataset.sourceType.toUpperCase()}
          </DialogDescription>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  )
}
