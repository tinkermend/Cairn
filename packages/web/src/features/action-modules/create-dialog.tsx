import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateModuleBody } from '@cairn/shared'
import { toast } from 'sonner'
import { createActionModule } from '@/lib/action-modules-api'
import { ApiRequestError } from '@/lib/api-client'
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
import { Textarea } from '@/components/ui/textarea'

type ActionModuleCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  defaultTargetId?: string
}

export function ActionModuleCreateDialog({
  open,
  onOpenChange,
  onCreated,
  defaultTargetId,
}: ActionModuleCreateDialogProps) {
  const queryClient = useQueryClient()
  const [targetSearch, setTargetSearch] = useState('')
  const targets = useQuery({
    queryKey: [
      'targets',
      { limit: 100, search: targetSearch.trim() || undefined },
    ],
    queryFn: () =>
      fetchTargets({ limit: 100, search: targetSearch.trim() || undefined }),
    enabled: open,
  })
  const fallbackTarget = useQuery({
    queryKey: ['target', defaultTargetId],
    queryFn: () => fetchTarget(defaultTargetId!),
    enabled:
      open &&
      Boolean(defaultTargetId) &&
      !targets.data?.items.some((t) => t.id === defaultTargetId),
  })
  const items = useMemo(() => {
    const list = [...(targets.data?.items ?? [])]
    if (
      fallbackTarget.data &&
      !list.some((t) => t.id === fallbackTarget.data?.id)
    ) {
      list.unshift(fallbackTarget.data)
    }
    return list
  }, [targets.data?.items, fallbackTarget.data])

  const [targetId, setTargetId] = useState('')
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [capabilityKey, setCapabilityKey] = useState('')
  const request = useRef({ signature: '', key: '' })
  const [submitting, setSubmitting] = useState(false)

  const selectedTargetId = targetId || defaultTargetId || items[0]?.id || ''

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedTargetId) {
      toast.error('请选择目标系统')
      return
    }
    if (!key.trim()) {
      toast.error('请输入模块 key')
      return
    }
    if (!name.trim()) {
      toast.error('请输入模块名称')
      return
    }

    setSubmitting(true)
    try {
      const body: CreateModuleBody = {
        idempotencyKey: request.current.key || crypto.randomUUID(),
        targetId: selectedTargetId,
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        capabilityKey: capabilityKey.trim() || undefined,
      }
      const signature = JSON.stringify({ ...body, idempotencyKey: undefined })
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() }
      body.idempotencyKey = request.current.key
      const res = await createActionModule(body)
      toast.success('动作模块创建成功')
      request.current = { signature: '', key: '' }
      await queryClient.invalidateQueries({ queryKey: ['action-modules'] })
      onOpenChange(false)
      onCreated(res.id)
    } catch (error) {
      if (error instanceof ApiRequestError) {
        toast.error(error.message)
      } else {
        toast.error('创建失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[500px]'>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>新建动作模块</DialogTitle>
            <DialogDescription>
              动作模块是目标系统下可复用、可参数化的业务动作封装。创建后 key
              不可变更。
            </DialogDescription>
          </DialogHeader>

          <div className='grid gap-4 py-4'>
            <div className='grid gap-2'>
              <Input
                aria-label='搜索目标系统'
                placeholder='搜索目标系统'
                value={targetSearch}
                onChange={(e) => setTargetSearch(e.target.value)}
              />
              <Label htmlFor='target'>目标系统</Label>
              <Select
                value={selectedTargetId}
                onValueChange={setTargetId}
                disabled={items.length === 0}
              >
                <SelectTrigger id='target'>
                  <SelectValue placeholder='选择目标系统' />
                </SelectTrigger>
                <SelectContent>
                  {items.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className='grid gap-2'>
              <Label htmlFor='module-key'>模块 Key</Label>
              <Input
                id='module-key'
                placeholder='如 order.query、auth.login'
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <p className='text-bodyall text-muted-foreground'>
                小写点分标识符，最长 64 字符，在目标系统内唯一。
              </p>
            </div>

            <div className='grid gap-2'>
              <Label htmlFor='module-name'>模块名称</Label>
              <Input
                id='module-name'
                placeholder='如 查询订单详情'
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className='grid gap-2'>
              <Label htmlFor='module-cap'>能力分类（可选）</Label>
              <Input
                id='module-cap'
                placeholder='如 order_management、inventory'
                value={capabilityKey}
                onChange={(e) => setCapabilityKey(e.target.value)}
              />
            </div>

            <div className='grid gap-2'>
              <Label htmlFor='module-desc'>描述（可选）</Label>
              <Textarea
                id='module-desc'
                placeholder='简述该模块的业务意图和用途'
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type='submit' disabled={submitting}>
              {submitting ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
