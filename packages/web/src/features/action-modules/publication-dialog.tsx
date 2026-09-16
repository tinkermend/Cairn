import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ActionModuleVersionDto, ModulePublicationStatus } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  disableAffectedScenarios,
  fetchActionModuleReferences,
  updateActionModulePublication,
} from '@/lib/action-modules-api'
import { MODULE_PUBLICATION_STATUS_LABELS } from './labels'

const ACTION_LABEL: Record<ModulePublicationStatus, string> = {
  published: '恢复为已发布',
  deprecated: '弃用此版本',
  withdrawn: '撤回此版本',
}

export function ModulePublicationDialog({
  open,
  onOpenChange,
  moduleId,
  version,
  status,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  moduleId: string
  version: ActionModuleVersionDto
  status: ModulePublicationStatus
  onDone: () => void
}) {
  const refs = useQuery({
    queryKey: ['action-module-references', moduleId, version.id],
    queryFn: () => fetchActionModuleReferences(moduleId, { versionId: version.id, page: 1, pageSize: 100 }),
    enabled: open,
  })
  const [reason, setReason] = useState('')
  const [disable, setDisable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) {
      setReason('')
      setDisable(false)
      setError('')
    }
  }, [open, version.id, status])
  const userRefs = (refs.data?.items ?? []).filter((item) => item.purpose === 'user')
  const publishedUsers = userRefs.filter((item) => item.publishedUses.some((use) => use.moduleVersionId === version.id))
  const submit = async () => {
    if (!reason.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await updateActionModulePublication(moduleId, version.id, { status, reason: reason.trim() })
      if (status === 'withdrawn' && disable && publishedUsers.length > 0) {
        await disableAffectedScenarios(moduleId, {
          versionId: version.id,
          scenarioIds: publishedUsers.map((item) => item.scenarioId),
          confirm: true,
          reason: reason.trim(),
          idempotencyKey: crypto.randomUUID(),
        })
      }
      onOpenChange(false)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态变更失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{ACTION_LABEL[status]} · v{version.versionNo}</DialogTitle>
          <DialogDescription>
            当前状态：{MODULE_PUBLICATION_STATUS_LABELS[version.publicationStatus]}。状态变更不改版本内容。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-3 text-body'>
          <p>
            {refs.isLoading
              ? '正在统计引用…'
              : `草稿或已发布引用该版本的用户场景 ${userRefs.length} 个${publishedUsers.length ? `，其中已发布 ${publishedUsers.length} 个` : ''}。`}
          </p>
          <label className='block space-y-1'>
            <span>原因（必填）</span>
            <Textarea
              aria-label='发布状态变更原因'
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={512}
            />
          </label>
          {status === 'withdrawn' && publishedUsers.length > 0 ? (
            <label className='flex items-start gap-3 rounded-md border p-3'>
              <Checkbox
                aria-label='同时停用受影响的已发布场景'
                checked={disable}
                onCheckedChange={(value) => setDisable(value === true)}
              />
              <span>同时停用 {publishedUsers.length} 个已发布引用该版本的用户场景。在途运行不会被自动改写。</span>
            </label>
          ) : null}
          {error ? <p role='alert' className='text-destructive'>{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={busy || !reason.trim()} onClick={() => void submit()}>
            {busy ? '处理中…' : ACTION_LABEL[status]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
