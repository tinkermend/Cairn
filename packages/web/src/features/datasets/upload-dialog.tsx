import { useState, useTransition } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  parseDatasetSheet,
  type DatasetColumn,
  type ParsedDataset,
  type ScenarioInputType,
} from '@cairn/shared'
import { fetchTargets } from '@/lib/targets-api'
import { createDataset } from '@/lib/datasets-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { AlertCircle, FileSpreadsheet, Upload, Check, Table2 } from 'lucide-react'

interface DatasetUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (datasetId: string) => void
}

export function DatasetUploadDialog({
  open,
  onOpenChange,
  onSuccess,
}: DatasetUploadDialogProps) {
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null)
  const [filename, setFilename] = useState('')
  const [datasetName, setDatasetName] = useState('')
  const [targetId, setTargetId] = useState('')
  const [parsed, setParsed] = useState<ParsedDataset | null>(null)
  const [columns, setColumns] = useState<DatasetColumn[]>([])
  const [selectedSheet, setSelectedSheet] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const targetsQuery = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: open,
  })

  function resetState() {
    setFileBytes(null)
    setFilename('')
    setDatasetName('')
    setTargetId('')
    setParsed(null)
    setColumns([])
    setSelectedSheet('')
    setErrorMsg(null)
  }

  async function handleFileSelected(file: File) {
    setErrorMsg(null)
    try {
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      setFileBytes(bytes)
      setFilename(file.name)
      if (!datasetName) {
        setDatasetName(file.name.replace(/\.[^/.]+$/, ''))
      }

      const result = parseDatasetSheet(bytes, file.name)
      setParsed(result)
      setColumns(result.activeSheet.columns)
      setSelectedSheet(result.activeSheet.name)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '解析数据表失败，请检查文件格式')
      setParsed(null)
    }
  }

  function handleSheetChange(sheetName: string) {
    if (!fileBytes || !filename) return
    try {
      const result = parseDatasetSheet(fileBytes, filename, { sheet: sheetName })
      setParsed(result)
      setColumns(result.activeSheet.columns)
      setSelectedSheet(sheetName)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '切换工作表失败')
    }
  }

  function handleColumnTypeChange(index: number, newType: ScenarioInputType) {
    setColumns((prev) =>
      prev.map((col, idx) => (idx === index ? { ...col, type: newType } : col))
    )
  }

  function handleSubmit() {
    if (!parsed || !datasetName.trim()) return
    if (!targetId) {
      setErrorMsg('请选择数据集所属的目标系统')
      return
    }
    setErrorMsg(null)

    startTransition(async () => {
      try {
        const created = await createDataset({
          name: datasetName.trim(),
          targetId,
          sourceType: parsed.sourceType,
          sourceFilename: filename,
          selectedSheet: selectedSheet || undefined,
          columns,
          rows: parsed.activeSheet.rows,
        })
        resetState()
        onOpenChange(false)
        onSuccess(created.id)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '创建数据集失败')
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetState()
        onOpenChange(next)
      }}
    >
      <DialogContent className='max-w-4xl max-h-[90vh] flex flex-col'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <FileSpreadsheet className='h-5 w-5 text-primary' />
            导入数据集 (Excel / CSV)
          </DialogTitle>
          <DialogDescription>
            支持 .xlsx 和 .csv 格式。系统将完整保留条形码、带前导零的单号等文本格式，不会发生数值精度截断。
          </DialogDescription>
        </DialogHeader>

        {errorMsg && (
          <div className='p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs flex items-center gap-2'>
            <AlertCircle className='h-4 w-4 shrink-0' />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className='flex-1 overflow-y-auto space-y-4 pr-1'>
          {!parsed ? (
            <div className='border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center gap-3 bg-muted/20 hover:bg-muted/30 transition-colors'>
              <div className='h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-primary'>
                <Upload className='h-6 w-6' />
              </div>
              <div className='text-center space-y-1'>
                <p className='text-sm font-medium'>拖拽 Excel 或 CSV 文件到此处，或点击浏览</p>
                <p className='text-xs text-muted-foreground'>支持 .xlsx, .csv，最大 10MB</p>
              </div>
              <input
                type='file'
                id='dataset-file-input'
                className='sr-only'
                accept='.xlsx,.csv'
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handleFileSelected(file)
                }}
              />
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => document.getElementById('dataset-file-input')?.click()}
              >
                选择本地文件
              </Button>
            </div>
          ) : (
            <div className='space-y-4'>
              <div className='grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-lg border bg-muted/10'>
                <div className='space-y-1.5'>
                  <Label className='text-xs'>数据集名称</Label>
                  <Input
                    className='h-8 text-xs'
                    value={datasetName}
                    onChange={(e) => setDatasetName(e.target.value)}
                    placeholder='为数据集命名'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label className='text-xs'>关联目标系统</Label>
                  <Select value={targetId} onValueChange={setTargetId}>
                    <SelectTrigger className='h-8 text-xs'>
                      <SelectValue placeholder='选择数据集所属的目标系统' />
                    </SelectTrigger>
                    <SelectContent>
                      {targetsQuery.data?.items.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {parsed.sheetNames.length > 1 && (
                <div className='flex items-center gap-2'>
                  <Label className='text-xs text-muted-foreground whitespace-nowrap'>
                    选择工作表 (Sheet):
                  </Label>
                  <Select value={selectedSheet} onValueChange={handleSheetChange}>
                    <SelectTrigger className='h-8 w-48 text-xs'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {parsed.sheetNames.map((sheet) => (
                        <SelectItem key={sheet} value={sheet}>
                          {sheet}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className='space-y-2'>
                <div className='flex items-center justify-between text-xs'>
                  <div className='flex items-center gap-2'>
                    <Table2 className='h-4 w-4 text-primary' />
                    <span className='font-medium'>字段结构与列类型推断</span>
                    <Badge variant='secondary' className='text-[10px]'>
                      共 {columns.length} 列
                    </Badge>
                  </div>
                  <span className='text-muted-foreground'>
                    已成功解析 {parsed.activeSheet.rowCount} 行有效数据
                  </span>
                </div>

                <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-36 overflow-y-auto p-2 border rounded-lg bg-card text-xs'>
                  {columns.map((col, idx) => (
                    <div
                      key={col.key}
                      className='p-2 rounded border bg-muted/20 flex flex-col justify-between gap-1.5'
                    >
                      <div className='truncate font-medium' title={col.name}>
                        {col.name}
                      </div>
                      <div className='flex items-center justify-between gap-1'>
                        <span className='text-[10px] text-muted-foreground font-mono truncate'>
                          {col.key}
                        </span>
                        <Select
                          value={col.type}
                          onValueChange={(val: ScenarioInputType) =>
                            handleColumnTypeChange(idx, val)
                          }
                        >
                          <SelectTrigger className='h-6 w-20 text-[10px] px-1.5'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='string'>文本</SelectItem>
                            <SelectItem value='number'>数值</SelectItem>
                            <SelectItem value='boolean'>布尔</SelectItem>
                            <SelectItem value='date'>日期</SelectItem>
                            <SelectItem value='file'>文件</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className='space-y-2'>
                <div className='text-xs font-medium text-muted-foreground'>
                  数据行预览 (前 5 行)
                </div>
                <div className='border rounded-lg overflow-x-auto max-h-48'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='w-12 text-[11px] text-center'>#</TableHead>
                        {columns.map((col) => (
                          <TableHead key={col.key} className='text-[11px] font-medium'>
                            {col.name}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsed.activeSheet.rows.slice(0, 5).map((row, rIdx) => (
                        <TableRow key={rIdx}>
                          <TableCell className='text-[11px] text-center text-muted-foreground font-mono'>
                            {rIdx + 1}
                          </TableCell>
                          {columns.map((col) => (
                            <TableCell
                              key={col.key}
                              className='text-[11px] font-mono whitespace-nowrap'
                            >
                              {String(row[col.key] ?? '')}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className='pt-3 border-t'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            取消
          </Button>
          {parsed && (
            <Button
              type='button'
              size='sm'
              disabled={isPending || !datasetName.trim() || columns.length === 0 || !targetId}
              onClick={handleSubmit}
            >
              <Check className='h-4 w-4 mr-1' />
              {isPending ? '正在保存...' : '确认导入'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
