import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateScenarioBody } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createScenario } from '@/lib/scenarios-api'
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
import { createBlankStep } from './blank-step'

type ScenarioCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  defaultTargetId?: string
}

export function ScenarioCreateDialog({
  open,
  onOpenChange,
  onCreated,
  defaultTargetId,
}: ScenarioCreateDialogProps) {
  const queryClient = useQueryClient()
  const [targetSearch, setTargetSearch] = useState('')
  const targets = useQuery({
    queryKey: ['targets', { limit: 100, search: targetSearch.trim() || undefined }],
    queryFn: () => fetchTargets({ limit: 100, search: targetSearch.trim() || undefined }),
    enabled: open,
  })
  const fallbackTarget = useQuery({
    queryKey: ['target', defaultTargetId],
    queryFn: () => fetchTarget(defaultTargetId!),
    enabled: open && Boolean(defaultTargetId) && !targets.data?.items.some((t) => t.id === defaultTargetId),
  })
  const items = useMemo(() => {
    const list = [...(targets.data?.items ?? [])]
    if (fallbackTarget.data && !list.some((t) => t.id === fallbackTarget.data?.id)) {
      list.unshift(fallbackTarget.data)
    }
    return list
  }, [targets.data?.items, fallbackTarget.data])

  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState(defaultTargetId ?? '')
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const canSubmit =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    targets.isSuccess &&
    items.some((item) => item.id === targetId && item.status === 'active')

  function reset() {
    setName('')
    setTargetId('')
    setUrl('')
    setError('')
  }

  async function submit() {
    if (!canSubmit || saving) return
    const first = createBlankStep('navigate')
    const body: CreateScenarioBody = {
      targetId,
      name: name.trim(),
      steps: [
        first.type === 'navigate'
          ? { ...first, name: '打开页面', input: { url: url.trim() } }
          : first,
      ],
    }
    setSaving(true)
    setError('')
    try {
      const created = await createScenario(body)
      await queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      toast.success('场景已创建')
      reset()
      onOpenChange(false)
      onCreated(created.id)
    } catch (error) {
      setError(
        error instanceof ApiRequestError
          ? error.message
          : '创建失败，请检查名称、目标系统和页面地址后重试。'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>新建场景</DialogTitle>
          <DialogDescription>
            选择目标系统并填写首步要打开的地址。创建后进入顺序编辑，再补充填写、点击、提取和断言。
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={saving} className='min-w-0 space-y-5'>
          <div className='space-y-2'>
            <Label htmlFor='scenario-name'>名称</Label>
            <Input
              id='scenario-name'
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='scenario-target'>目标系统</Label>
            <Input
              aria-label='搜索目标系统'
              placeholder='搜索名称或编码'
              value={targetSearch}
              onChange={(event) => setTargetSearch(event.target.value)}
            />
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger
                id='scenario-target'
                className='w-full'
                disabled={saving || !targets.isSuccess}
              >
                <SelectValue placeholder='选择要仿真的目标系统' />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    disabled={item.status === 'disabled'}
                  >
                    {item.name}
                    {item.status === 'disabled' ? '（已停用）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targets.isPending ? (
              <p role='status' className='text-small text-muted-foreground'>
                正在加载目标系统…
              </p>
            ) : targets.isError ? (
              <p role='alert' className='text-small text-destructive'>
                无法加载目标系统。
                <Button
                  type='button'
                  variant='link'
                  size='sm'
                  onClick={() => void targets.refetch()}
                >
                  重试
                </Button>
              </p>
            ) : !items.some((item) => item.status === 'active') ? (
              <p className='text-small text-muted-foreground'>
                没有已启用的目标系统，请先登记或启用一个系统。
              </p>
            ) : null}
          </div>
          <div className='space-y-2'>
            <Label htmlFor='scenario-url'>首步页面地址</Label>
            <Input
              id='scenario-url'
              value={url}
              placeholder='https://'
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
        </fieldset>
        {error ? (
          <p
            role='alert'
            className='rounded-md bg-status-error-background p-3 text-small text-status-error-foreground'
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            disabled={saving}
            onClick={() => {
              reset()
              onOpenChange(false)
            }}
          >
            取消
          </Button>
          <Button disabled={!canSubmit} loading={saving} onClick={() => void submit()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
