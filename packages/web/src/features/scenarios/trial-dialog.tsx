import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { runInputSchema, type RunDetailDto, type ScenarioInputDecl } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchScenarioCapabilities, trialScenario } from '@/lib/scenarios-api'
import { CAPTURE_MODE_LABELS } from '@/features/platform-config/labels'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { AccountSessionHint } from '@/features/runs/account-session-hint'
import {
  passwordAccounts,
  preferredPasswordAccountId,
  unusableAccountCopy,
  unusableAccountReason,
} from '@/features/runs/target-account'
import { Badge } from '@/components/ui/badge'
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
  needsAccount?: boolean
  pauseBeforeStepId?: string
  onCreated: (run: RunDetailDto) => void
  onConflict: () => void
}

function trialFailure(error: unknown): { message: string; diagnostics: string[] } {
  if (!(error instanceof ApiRequestError)) return { message: '试跑失败', diagnostics: [] }
  const details = error.payload.details
  const diagnostics = details && typeof details === 'object' && 'diagnostics' in details
    ? (details as { diagnostics?: unknown }).diagnostics
    : undefined
  return {
    message: error.message,
    diagnostics: Array.isArray(diagnostics)
      ? diagnostics.flatMap((item) => item && typeof item === 'object' && 'message' in item && typeof item.message === 'string'
        ? [item.message]
        : [])
      : [],
  }
}

function newIdempotencyKey(): string {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`
  return `trial-${id}`
}

function captureModeLabel(mode: string | undefined): string {
  if (mode && mode in CAPTURE_MODE_LABELS) {
    return CAPTURE_MODE_LABELS[mode as keyof typeof CAPTURE_MODE_LABELS]
  }
  return mode || '默认'
}

export function TrialDialog({
  open,
  onOpenChange,
  scenarioId,
  targetId,
  revision,
  inputs,
  needsAccount = false,
  pauseBeforeStepId,
  onCreated,
  onConflict,
}: TrialDialogProps) {
  const accounts = useQuery({
    queryKey: ['target-accounts', targetId],
    queryFn: () => fetchTargetAccounts(targetId),
    enabled: open,
  })
  const capabilities = useQuery({
    queryKey: ['scenarios', 'capabilities'],
    queryFn: fetchScenarioCapabilities,
    enabled: open,
  })
    const inheritScreenshot = capabilities.data?.defaults?.evidence.screenshot
    const inheritVideo = capabilities.data?.defaults?.evidence.video
    const inheritTrace = capabilities.data?.defaults?.evidence.trace
  const [targetAccountId, setTargetAccountId] = useState('')
  const accountItems = accounts.data?.items ?? []
  const usableAccounts = passwordAccounts(accountItems)
  const emptyAccountReason = accounts.isPending ? undefined : unusableAccountReason(accountItems)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{ message: string; diagnostics: string[] } | null>(null)
  const fingerprint = JSON.stringify({ revision, targetAccountId, values, pauseBeforeStepId })
  const keyRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    keyRef.current = undefined
    setFailure(null)
  }, [fingerprint])

  useEffect(() => {
    setTargetAccountId(preferredPasswordAccountId(accounts.data?.items ?? []))
  }, [accounts.data, targetId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{pauseBeforeStepId ? '运行到此步前置' : '试跑当前草稿'}</DialogTitle>
          <DialogDescription>
            {pauseBeforeStepId
              ? '从第一步执行已保存的草稿，并在指定步骤前暂停。结果留在本页并自动跟随进度。'
              : '从第一步执行已保存的草稿。结果留在本页并自动跟随进度。本次试跑不会改草稿。'}
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <Label>目标账号{needsAccount ? '（必选）' : '（可选）'}</Label>
            <Select
              value={targetAccountId || (usableAccounts.length > 0 ? undefined : '__none__')}
              onValueChange={(value) => setTargetAccountId(value === '__none__' ? '' : value)}
            >
              <SelectTrigger className='w-full'>
                <SelectValue placeholder={usableAccounts.length > 0 ? '选择目标账号' : '不指定目标账号'} />
              </SelectTrigger>
              <SelectContent>
                {usableAccounts.length === 0 ? <SelectItem value='__none__'>不指定</SelectItem> : null}
                {usableAccounts.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.displayName}（{item.username}
                      {item.hasPassword ? '' : ' · 未保存口令'}）
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <AccountSessionHint targetId={targetId} account={accounts.data?.items.find(item => item.id === targetAccountId)} />
            {usableAccounts.length === 0 && emptyAccountReason ? (
              <p className='text-label text-muted-foreground'>{unusableAccountCopy(emptyAccountReason)}</p>
            ) : null}
          </div>
          <div className='flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
            <span>默认证据：</span>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              截图（{captureModeLabel(inheritScreenshot)}）
            </Badge>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              录像（{captureModeLabel(inheritVideo)}）
            </Badge>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              Trace（{captureModeLabel(inheritTrace)}）
            </Badge>
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
          {failure ? (
            <div role='alert' className='space-y-2 rounded-md border border-status-error-accent/30 bg-status-error-background p-3 text-small text-status-error-foreground'>
              <p className='font-medium'>{failure.message}</p>
              {failure.diagnostics.length > 0 ? (
                <ul className='list-disc space-y-1 pl-5'>
                  {failure.diagnostics.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
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
          <Button
            loading={saving}
            disabled={accounts.isPending || (needsAccount && !targetAccountId) || Boolean(targetAccountId && !accounts.data?.items.some(item => item.id === targetAccountId && item.status === 'active'))}
            onClick={() => {
              const parsed = runInputSchema.safeParse(values)
              if (!parsed.success) {
                toast.error(parsed.error.issues[0]?.message ?? '试跑输入不合法')
                return
              }
              keyRef.current ??= newIdempotencyKey()
              setFailure(null)
              setSaving(true)
              void trialScenario(scenarioId, {
                revision,
                targetAccountId: targetAccountId || undefined,
                input: parsed.data,
                pauseBeforeStepId,
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
                  const failure = trialFailure(error)
                  setFailure(failure)
                  toast.error(failure.message)
                })
                .finally(() => setSaving(false))
            }}
          >
            {pauseBeforeStepId ? '开始断点试跑' : '开始试跑'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
