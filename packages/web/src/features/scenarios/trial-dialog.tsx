import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { runInputSchema, type RunDetailDto, type ScenarioInputDecl } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { trialScenario } from '@/lib/scenarios-api'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type TrialDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  targetId: string
  revision: number
  inputs: ScenarioInputDecl[]
  onCreated: (run: RunDetailDto) => void
  onConflict: () => void
}

function newIdempotencyKey(): string {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`
  return `trial-${id}`
}

export function TrialDialog({
  open,
  onOpenChange,
  scenarioId,
  targetId,
  revision,
  inputs,
  onCreated,
  onConflict,
}: TrialDialogProps) {
  const accounts = useQuery({
    queryKey: ['target-accounts', targetId],
    queryFn: () => fetchTargetAccounts(targetId),
    enabled: open,
  })
  const [targetAccountId, setTargetAccountId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const fingerprint = JSON.stringify({ revision, targetAccountId, values })
  const keyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    keyRef.current = undefined
  }, [fingerprint])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>试跑当前草稿</DialogTitle>
          <DialogDescription>
            从第一步执行已保存的草稿。结果留在本页，进度需手动刷新。本次试跑不会改草稿。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
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
          </div>
          {inputs.map((input) => (
            <div key={input.key} className='space-y-2'>
              <Label htmlFor={`trial-${input.key}`}>{input.label}</Label>
              <Input
                id={`trial-${input.key}`}
                value={values[input.key] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [input.key]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            loading={saving}
            onClick={() => {
              const parsed = runInputSchema.safeParse(values)
              if (!parsed.success) {
                toast.error(parsed.error.issues[0]?.message ?? '试跑输入不合法')
                return
              }
              keyRef.current ??= newIdempotencyKey()
              setSaving(true)
              void trialScenario(scenarioId, {
                revision,
                targetAccountId: targetAccountId || undefined,
                input: parsed.data,
                idempotencyKey: keyRef.current,
              })
                .then((detail) => {
                  toast.success('试跑已创建')
                  onOpenChange(false)
                  onCreated(detail)
                })
                .catch((error) => {
                  if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
                    onConflict()
                    return
                  }
                  toast.error(error instanceof ApiRequestError ? error.message : '试跑失败')
                })
                .finally(() => setSaving(false))
            }}
          >
            开始试跑
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
