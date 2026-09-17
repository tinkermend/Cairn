import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { renameRecording } from '@/lib/recordings-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type RenameDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  recording: { id: string; name: string } | null
  onRenamed: () => void
}

export function RecordingRenameDialog({
  open,
  onOpenChange,
  recording,
  onRenamed,
}: RenameDialogProps) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (recording) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(recording.name)
    }
  }, [recording])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!recording) return
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('名称不能为空')
      return
    }
    setSaving(true)
    try {
      await renameRecording(recording.id, trimmed)
      toast.success('已重命名')
      onOpenChange(false)
      onRenamed()
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '重命名失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>重命名录制草稿</DialogTitle>
            <DialogDescription>修改该草稿在控制台中的展示名称。</DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 py-4'>
            <div className='grid gap-2'>
              <Label htmlFor='recording-name'>草稿名称</Label>
              <Input
                id='recording-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='输入录制草稿名称'
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type='submit' loading={saving} disabled={saving || !name.trim()}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
