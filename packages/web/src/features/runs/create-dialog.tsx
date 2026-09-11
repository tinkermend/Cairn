import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { runInputSchema } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createRun } from '@/lib/runs-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'

type RunCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultScenarioId?: string
  defaultTargetId?: string
}

export function RunCreateDialog({
  open,
  onOpenChange,
  defaultScenarioId,
  defaultTargetId,
}: RunCreateDialogProps) {
  const navigate = useNavigate()
  const scenarios = useQuery({ queryKey: ['scenarios'], queryFn: fetchScenarios, enabled: open })
  const [scenarioId, setScenarioId] = useState(defaultScenarioId ?? '')
  const selected = scenarios.data?.items.find((item) => item.id === scenarioId)
  const targetId = selected?.targetId ?? defaultTargetId
  const accounts = useQuery({
    queryKey: ['target-accounts', targetId],
    queryFn: () => fetchTargetAccounts(targetId!),
    enabled: open && !!targetId,
  })
  const [targetAccountId, setTargetAccountId] = useState('')
  const [inputJson, setInputJson] = useState('{}')
  const [saving, setSaving] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>创建运行</DialogTitle>
          <DialogDescription>
            对已绑定目标系统的场景发起一次执行。可选的目标账号是该外部系统的登录身份，不是控制台用户。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <Label>场景</Label>
            <Select value={scenarioId || undefined} onValueChange={setScenarioId}>
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='选择场景' />
              </SelectTrigger>
              <SelectContent>
                {(scenarios.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-2'>
            <Label>目标账号（可选）</Label>
            <Select
              value={targetAccountId || '__none__'}
              onValueChange={(value) => setTargetAccountId(value === '__none__' ? '' : value)}
            >
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='不指定目标账号' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__none__'>不指定</SelectItem>
                {(accounts.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName}（{item.username}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-label text-muted-foreground'>
              这里选的是目标系统账号。浏览器会话由执行面按目标系统 + 目标账号纳管，本期不提供会话菜单。
            </p>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='run-input'>运行 input（JSON）</Label>
            <Input id='run-input' value={inputJson} onChange={(event) => setInputJson(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!scenarioId || saving}
            onClick={() => {
              let parsedJson: unknown
              try {
                parsedJson = JSON.parse(inputJson)
              } catch {
                toast.error('input 不是合法 JSON')
                return
              }
              const parsed = runInputSchema.safeParse(parsedJson)
              if (!parsed.success) {
                toast.error(parsed.error.issues[0]?.message ?? 'input 必须是 JSON 对象')
                return
              }
              const input = parsed.data
              setSaving(true)
              void createRun({
                scenarioId,
                targetAccountId: targetAccountId || undefined,
                input,
              })
                .then((detail) => {
                  toast.success('运行已创建')
                  onOpenChange(false)
                  void navigate({ to: '/runs/$runId', params: { runId: detail.id } })
                })
                .catch((error) => {
                  toast.error(error instanceof ApiRequestError ? error.message : '创建失败')
                })
                .finally(() => setSaving(false))
            }}
          >
            创建运行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
