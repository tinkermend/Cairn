import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { stepUsesBrowser, runInputSchema, type EvidenceCaptureMode, type VideoCaptureMode } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createRun } from '@/lib/runs-api'
import { fetchScenario, fetchScenarioCapabilities, fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { inheritCaptureLabel } from '@/features/platform-config/labels'
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
import { CAPTURE_MODE_LABELS } from './labels'
import { AccountSessionHint, accountCapabilityLabel } from './account-session-hint'
import { passwordAccounts, preferredPasswordAccountId } from './target-account'

type RunCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultScenarioId?: string
  defaultTargetId?: string
}

const INHERIT = '__inherit__'

export function RunCreateDialog({
  open,
  onOpenChange,
  defaultScenarioId,
  defaultTargetId,
}: RunCreateDialogProps) {
  const navigate = useNavigate()
  const [scenarioSearch, setScenarioSearch] = useState('')
  const scenarios = useQuery({
    queryKey: ['scenarios', { limit: 100, search: scenarioSearch.trim() || undefined }],
    queryFn: () => fetchScenarios({ limit: 100, search: scenarioSearch.trim() || undefined }),
    enabled: open,
  })
  const fallbackScenario = useQuery({
    queryKey: ['scenario', defaultScenarioId],
    queryFn: () => fetchScenario(defaultScenarioId!),
    enabled:
      open &&
      Boolean(defaultScenarioId) &&
      !scenarios.data?.items.some((s) => s.id === defaultScenarioId),
  })
  const scenarioItems = useMemo(() => {
    const list = [...(scenarios.data?.items ?? [])]
    if (fallbackScenario.data && !list.some((s) => s.id === fallbackScenario.data?.id)) {
      list.unshift(fallbackScenario.data)
    }
    return list
  }, [scenarios.data?.items, fallbackScenario.data])

  const capabilities = useQuery({
    queryKey: ['scenarios', 'capabilities'],
    queryFn: fetchScenarioCapabilities,
    enabled: open,
  })
  const [scenarioId, setScenarioId] = useState(defaultScenarioId ?? '')
  const selected = scenarioItems.find((item) => item.id === scenarioId)
  const executionScenario = useQuery({ queryKey: ['scenario', scenarioId], queryFn: () => fetchScenario(scenarioId), enabled: open && Boolean(scenarioId) })
  const needsAccount = executionScenario.data?.steps.some(step => stepUsesBrowser(step.type)) ?? false
  const targetId = selected?.targetId ?? fallbackScenario.data?.targetId ?? defaultTargetId
  const [accountSearch, setAccountSearch] = useState('')
  const accounts = useQuery({
    queryKey: ['target-accounts', targetId, { limit: 100, search: accountSearch.trim() || undefined }],
    queryFn: () =>
      fetchTargetAccounts(targetId!, {
        limit: 100,
        search: accountSearch.trim() || undefined,
      }),
    enabled: open && !!targetId,
  })
  const [targetAccountId, setTargetAccountId] = useState('')
  const usableAccounts = passwordAccounts(accounts.data?.items ?? [])
  const [inputJson, setInputJson] = useState('{}')
  const [screenshotOverride, setScreenshotOverride] = useState<EvidenceCaptureMode | null>(null)
  const [videoOverride, setVideoOverride] = useState<VideoCaptureMode | null>(null)
  const [traceOverride, setTraceOverride] = useState<EvidenceCaptureMode | null>(null)
  const [saving, setSaving] = useState(false)
    const inheritScreenshot = capabilities.data?.defaults?.evidence.screenshot ?? 'always'
  const inheritVideo = capabilities.data?.defaults?.evidence.video ?? 'always'
  const inheritTrace = capabilities.data?.defaults?.evidence.trace ?? 'off'

  useEffect(() => {
    setTargetAccountId(preferredPasswordAccountId(accounts.data?.items ?? []))
  }, [accounts.data, scenarioId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>创建运行</DialogTitle>
          <DialogDescription>
            对已绑定目标系统的场景发起一次执行。已保存口令的目标账号会作为登录凭据；不要和控制台用户混淆。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='run-scenario'>场景</Label>
            <Input
              aria-label='搜索场景'
              placeholder='搜索场景名称'
              value={scenarioSearch}
              onChange={(event) => setScenarioSearch(event.target.value)}
            />
            <Select value={scenarioId || undefined} onValueChange={setScenarioId}>
              <SelectTrigger id='run-scenario' className='w-full' aria-label='场景'>
                <SelectValue placeholder='选择场景' />
              </SelectTrigger>
              <SelectContent>
                {scenarioItems
                  .filter((item) => item.status === 'active')
                  .map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-2'>
            <Label>目标账号{needsAccount ? '（必选）' : '（可选）'}</Label>
            <Input
              aria-label='搜索目标账号'
              placeholder='搜索登录名或显示名'
              value={accountSearch}
              onChange={(event) => setAccountSearch(event.target.value)}
            />
            <Select
              value={targetAccountId || (usableAccounts.length > 0 ? undefined : '__none__')}
              onValueChange={(value) => setTargetAccountId(value === '__none__' ? '' : value)}
            >
              <SelectTrigger className='w-full'>
                <SelectValue placeholder={usableAccounts.length > 0 ? '选择目标账号' : '不指定目标账号'} />
              </SelectTrigger>
              <SelectContent>
                {usableAccounts.length === 0 ? <SelectItem value='__none__'>不指定</SelectItem> : null}
                {(accounts.data?.items ?? [])
                  .filter((item) => item.status === 'active')
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.displayName}（{item.username}
                      {item.hasPassword ? '' : ' · 未保存口令'}） · {accountCapabilityLabel(item)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {targetId ? <AccountSessionHint targetId={targetId} account={accounts.data?.items.find(item => item.id === targetAccountId)} /> : null}
            <p className='text-label text-muted-foreground'>
              {usableAccounts.length > 0
                ? '未保存口令或不满足身份核验时，运行可能等待人工登录。可先到浏览器会话页准备该账号。'
                : '这里选的是目标系统账号，不要求事先保存口令。'}
            </p>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='run-input'>运行 input（JSON）</Label>
            <Input id='run-input' value={inputJson} onChange={(event) => setInputJson(event.target.value)} />
          </div>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label>截图采集</Label>
              <Select
                value={screenshotOverride ?? INHERIT}
                onValueChange={(value) =>
                  setScreenshotOverride(value === INHERIT ? null : (value as EvidenceCaptureMode))
                }
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>
                    {inheritCaptureLabel(inheritScreenshot, '继承平台默认')}
                  </SelectItem>
                  {(['on_failure', 'always', 'off'] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {CAPTURE_MODE_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <Label>录像采集</Label>
              <Select
                value={videoOverride ?? INHERIT}
                onValueChange={(value) =>
                  setVideoOverride(value === INHERIT ? null : (value as VideoCaptureMode))
                }
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>{inheritCaptureLabel(inheritVideo, '继承平台默认')}</SelectItem>
                  {(['always', 'off'] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {CAPTURE_MODE_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <Label>Trace 采集</Label>
              <Select
                value={traceOverride ?? INHERIT}
                onValueChange={(value) =>
                  setTraceOverride(value === INHERIT ? null : (value as EvidenceCaptureMode))
                }
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>{inheritCaptureLabel(inheritTrace, '继承平台默认')}</SelectItem>
                  {(['off', 'on_failure', 'always'] as const).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {CAPTURE_MODE_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className='text-label text-muted-foreground'>
            未改采集方式时继承平台证据策略，出厂默认成功失败都留截图和整次录像。Trace 选「始终」用于当场调试，用
            Playwright Trace Viewer 打开。
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={!scenarioId || saving || executionScenario.isPending || accounts.isPending || (needsAccount && !targetAccountId) || Boolean(targetAccountId && !accounts.data?.items.some(item => item.id === targetAccountId && item.status === 'active'))}
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
              const evidencePolicy =
                screenshotOverride || videoOverride || traceOverride
                  ? {
                      ...(screenshotOverride ? { screenshot: screenshotOverride } : {}),
                      ...(videoOverride ? { video: videoOverride } : {}),
                      ...(traceOverride ? { trace: traceOverride } : {}),
                    }
                  : undefined
              setSaving(true)
              void createRun({
                scenarioId,
                targetAccountId: targetAccountId || undefined,
                input,
                ...(evidencePolicy ? { evidencePolicy } : {}),
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
