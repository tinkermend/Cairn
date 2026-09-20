import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createSuite } from '@/lib/suites-api'
import { fetchTarget, fetchTargets } from '@/lib/targets-api'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type SuiteCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  defaultTargetId?: string
}

export function SuiteCreateDialog({
  open,
  onOpenChange,
  onCreated,
  defaultTargetId,
}: SuiteCreateDialogProps) {
  const [targetSearch, setTargetSearch] = useState('')
  const targets = useQuery({
    queryKey: ['targets', { limit: 100, search: targetSearch.trim() || undefined }],
    queryFn: () => fetchTargets({ limit: 100, search: targetSearch.trim() || undefined }),
    enabled: open,
  })
  const fallbackTarget = useQuery({
    queryKey: ['target', defaultTargetId],
    queryFn: () => fetchTarget(defaultTargetId!),
    enabled: open && Boolean(defaultTargetId) && !targets.data?.items.some((item) => item.id === defaultTargetId),
  })
  const items = useMemo(() => {
    const list = [...(targets.data?.items ?? [])]
    if (fallbackTarget.data && !list.some((item) => item.id === fallbackTarget.data?.id)) {
      list.unshift(fallbackTarget.data)
    }
    return list
  }, [targets.data?.items, fallbackTarget.data])

  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState(defaultTargetId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const canSubmit =
    name.trim().length > 0 &&
    targets.isSuccess &&
    items.some((item) => item.id === targetId && item.status === 'active')

  function reset() {
    setName('')
    setTargetId(defaultTargetId ?? '')
    setError('')
  }

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    setError('')
    try {
      const created = await createSuite({ targetId, name: name.trim() })
      toast.success('已创建场景集草稿')
      reset()
      onOpenChange(false)
      onCreated(created.id)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建场景集</DialogTitle>
          <DialogDescription>先绑定一个目标系统，再添加已发布场景作为成员。</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4'>
          <div className='grid gap-2'>
            <Label htmlFor='suite-name'>名称</Label>
            <Input
              id='suite-name'
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder='例如：系统日常巡检'
            />
          </div>
          <div className='grid gap-2'>
            <Label>目标系统</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger aria-label='目标系统'>
                <SelectValue placeholder='选择目标系统' />
              </SelectTrigger>
              <SelectContent>
                <div className='p-2'>
                  <Input
                    value={targetSearch}
                    onChange={(event) => setTargetSearch(event.target.value)}
                    placeholder='搜索目标'
                  />
                </div>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id} disabled={item.status !== 'active'}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? <p className='text-small text-destructive'>{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canSubmit || saving} onClick={() => void submit()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
