import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { previewScenarioModuleReplace, replaceScenarioModule } from '@/lib/scenarios-api'

export function ModuleReplacePreviewDialog({
  open,
  onOpenChange,
  scenarioId,
  stepIds,
  moduleVersionId,
  baseRevision,
  onReplaced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  stepIds: string[]
  moduleVersionId: string
  baseRevision: number
  onReplaced: () => void
}) {
  const preview = useQuery({
    queryKey: ['module-replace-preview', scenarioId, stepIds, moduleVersionId],
    queryFn: () => previewScenarioModuleReplace(scenarioId, { stepIds, moduleVersionId }),
    enabled: open && stepIds.length > 0 && Boolean(moduleVersionId),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!preview.data || busy) return
    setBusy(true)
    setError('')
    try {
      await replaceScenarioModule(scenarioId, {
        stepIds,
        moduleVersionId,
        baseRevision,
        parameterized: [],
        idempotencyKey: crypto.randomUUID(),
      })
      onOpenChange(false)
      toast.success('已用模块调用替换选中步骤')
      onReplaced()
    } catch (err) {
      setError(err instanceof Error ? err.message : '替换失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[85dvh] flex-col gap-4 overflow-hidden sm:max-w-3xl'>
        <DialogHeader className='shrink-0'>
          <DialogTitle>替换为模块调用</DialogTitle>
          <DialogDescription>左右对比原步骤与展开步骤。确认后只写入场景草稿。</DialogDescription>
        </DialogHeader>
        <div className='min-h-0 flex-1 space-y-3 overflow-y-auto text-body'>
          {preview.isLoading ? <p className='text-muted-foreground'>正在对比…</p> : null}
          {preview.isError ? <p role='alert' className='text-destructive'>{preview.error.message}</p> : null}
          {preview.data ? (
            <div className='space-y-3'>
              <p>{preview.data.equal ? '展开结果与原步骤语义一致。' : '存在差异，请核对后再写入。'}</p>
              <div className='overflow-x-auto rounded-xl border'>
                <table className='w-full min-w-[28rem] text-left text-small'>
                  <thead>
                    <tr className='border-b text-label text-muted-foreground'>
                      <th className='p-2 font-medium'>原步骤</th>
                      <th className='p-2 font-medium'>展开步骤</th>
                      <th className='p-2 font-medium'>差异</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.steps.map((row) => (
                      <tr key={row.index} className={row.equal ? 'border-b last:border-0' : 'border-b bg-status-warning-background last:border-0'}>
                        <td className='p-2'>{row.original.name} · {row.original.type} · {row.original.effectType}</td>
                        <td className='p-2'>{row.expanded ? `${row.expanded.name} · ${row.expanded.type} · ${row.expanded.effectType}` : '—'}</td>
                        <td className='p-2'>{row.differences.join('、') || '一致'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {error ? <p role='alert' className='text-destructive'>{error}</p> : null}
        </div>
        <DialogFooter className='shrink-0'>
          <Button variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={busy || !preview.data} onClick={() => void submit()}>{busy ? '写入中…' : '写入草稿'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
