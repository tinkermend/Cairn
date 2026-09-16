import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { latestSelectableVersion } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fetchActionModules, fetchActionModuleVersions } from '@/lib/action-modules-api'
import { ModuleReplacePreviewDialog } from './replace-preview-dialog'

export function ModuleReplaceDialog({
  open,
  onOpenChange,
  scenarioId,
  targetId,
  stepIds,
  baseRevision,
  onReplaced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  targetId: string
  stepIds: string[]
  baseRevision: number
  onReplaced: () => void
}) {
  const modules = useQuery({
    queryKey: ['action-modules', { targetId }],
    queryFn: () => fetchActionModules({ targetId }),
    enabled: open,
  })
  const [moduleId, setModuleId] = useState<string | null>(null)
  const versions = useQuery({
    queryKey: ['action-module-versions', moduleId],
    queryFn: () => fetchActionModuleVersions(moduleId!),
    enabled: open && Boolean(moduleId),
  })
  const selectable = useMemo(
    () => (modules.data?.items ?? []).filter((item) => item.publicationStatus !== 'withdrawn' && item.latestVersionNo),
    [modules.data],
  )
  const latest = latestSelectableVersion(versions.data?.items ?? [])
  const [previewOpen, setPreviewOpen] = useState(false)
  return (
    <>
      {open && !previewOpen ? (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>选择已发布模块</DialogTitle>
            <DialogDescription>用同一目标下已发布或已弃用的版本替换选中的连续步骤。</DialogDescription>
          </DialogHeader>
          <div className='space-y-2'>
            {modules.isLoading ? <p className='text-body text-muted-foreground'>加载模块…</p> : null}
            {selectable.map((item) => (
              <button
                key={item.id}
                type='button'
                aria-pressed={moduleId === item.id}
                className={`w-full rounded-md border p-3 text-left ${moduleId === item.id ? 'border-primary ring-1 ring-primary' : ''}`}
                onClick={() => setModuleId(item.id)}
              >
                <span className='text-body font-medium'>{item.name}</span>
                <p className='text-label text-muted-foreground'>{item.key}{item.latestVersionNo ? ` · v${item.latestVersionNo}` : ''}</p>
              </button>
            ))}
            {moduleId && versions.isLoading ? <p className='text-body text-muted-foreground'>正在加载版本…</p> : null}
            {selectable.length === 0 && !modules.isLoading ? (
              <p className='text-body text-muted-foreground'>没有可替换的已发布模块。</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => onOpenChange(false)}>取消</Button>
            <Button disabled={!latest} onClick={() => setPreviewOpen(true)}>预览替换</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      ) : null}
      {latest ? (
        <ModuleReplacePreviewDialog
          open={previewOpen}
          onOpenChange={(next) => {
            setPreviewOpen(next)
            if (!next) onOpenChange(false)
          }}
          scenarioId={scenarioId}
          stepIds={stepIds}
          moduleVersionId={latest.id}
          baseRevision={baseRevision}
          onReplaced={onReplaced}
        />
      ) : null}
    </>
  )
}
