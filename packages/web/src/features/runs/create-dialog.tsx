import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  requiredRunInputKeys,
  runInputSchema,
  stepUsesBrowser,
  type EvidenceCaptureMode,
  type VideoCaptureMode,
} from '@cairn/shared'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createRun } from '@/lib/runs-api'
import { fetchScenario, fetchScenarioCapabilities, fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { inheritCaptureLabel } from '@/features/platform-config/labels'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
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
import { AccountSessionHint } from './account-session-hint'
import { RunInputFields, missingRunInput, runInputValues } from './run-input-fields'
import {
  passwordAccounts,
  preferredPasswordAccountId,
  unusableAccountCopy,
  unusableAccountReason,
} from './target-account'

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
  const published = executionScenario.data?.published
  /** 正式运行绑已发布版本：字段只能来自 published.definition，草稿输入属于试跑。 */
  const inputDecls = useMemo(
    () => (published ? requiredRunInputKeys(published.definition) : []),
    [published],
  )
  /** 输入值按场景存放：换场景即作废旧值，不靠 effect 清空。 */
  const [inputDraft, setInputDraft] = useState<{ scenarioId: string; values: Record<string, string> }>({
    scenarioId: '',
    values: {},
  })
  const inputValues = inputDraft.scenarioId === scenarioId ? inputDraft.values : {}
  const missing = missingRunInput(inputDecls, inputValues)
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
  const accountItems = accounts.data?.items ?? []
  const usableAccounts = passwordAccounts(accountItems)
  const emptyAccountReason = accounts.isPending ? undefined : unusableAccountReason(accountItems)
  const [screenshotOverride, setScreenshotOverride] = useState<EvidenceCaptureMode | null>(null)
  const [videoOverride, setVideoOverride] = useState<VideoCaptureMode | null>(null)
  const [traceOverride, setTraceOverride] = useState<EvidenceCaptureMode | null>(null)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [saving, setSaving] = useState(false)
    const inheritScreenshot = capabilities.data?.defaults?.evidence.screenshot ?? 'always'
  const inheritVideo = capabilities.data?.defaults?.evidence.video ?? 'always'
  const inheritTrace = capabilities.data?.defaults?.evidence.trace ?? 'off'

  useEffect(() => {
    setTargetAccountId(preferredPasswordAccountId(accounts.data?.items ?? []))
  }, [accounts.data, scenarioId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>运行已发布版本</DialogTitle>
          <DialogDescription>
            对已绑定目标系统的场景发起一次正式执行，跑的是它最新的已发布版本。已保存口令的目标账号会作为登录凭据；不要和控制台用户混淆。
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
            {scenarioId && executionScenario.data ? (
              published ? (
                <div className='space-y-1'>
                  <p className='text-label text-muted-foreground'>
                    将运行已发布版本 v{published.versionNo}
                  </p>
                  {executionScenario.data.draftDirty ? (
                    <p className='text-label text-status-warning-foreground'>
                      场景里还有未发布的修改，这次不会带上。
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className='text-label text-destructive'>
                  这个场景还没有发布过版本，先到场景里发布再创建运行。
                </p>
              )
            ) : null}
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
                {usableAccounts.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.displayName}（{item.username}
                      {item.hasPassword ? '' : ' · 未保存口令'}）
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {targetId ? <AccountSessionHint targetId={targetId} account={accounts.data?.items.find(item => item.id === targetAccountId)} /> : null}
            {usableAccounts.length > 0 ? (
              <p className='text-label text-muted-foreground'>
                未保存口令、仅手工登录或验证码不能自动处理时，运行可能等待人工登录。可先到浏览器页准备该账号。
              </p>
            ) : emptyAccountReason ? (
              <p className='text-label text-muted-foreground'>
                {unusableAccountCopy(emptyAccountReason)}
                {targetId ? (
                  <>
                    {' '}
                    <button
                      type='button'
                      className='text-link underline'
                      onClick={() => {
                        onOpenChange(false)
                        void navigate({ to: '/targets/$targetId', params: { targetId } })
                      }}
                    >
                      打开目标系统
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {inputDecls.length > 0 ? (
            <RunInputFields
              idPrefix='run-input'
              decls={inputDecls}
              values={inputValues}
              onChange={(key, value) =>
                setInputDraft((current) => ({
                  scenarioId,
                  values: {
                    ...(current.scenarioId === scenarioId ? current.values : {}),
                    [key]: value,
                  },
                }))
              }
            />
          ) : null}
          <Collapsible open={evidenceOpen} onOpenChange={setEvidenceOpen}>
            <CollapsibleTrigger asChild>
              <Button variant='ghost' size='sm' className='w-full justify-between px-0'>
                <span>高级：证据采集</span>
                <span className='flex items-center gap-1 text-label text-muted-foreground'>
                  {evidenceOpen ? '收起' : '继承平台默认'}
                  <ChevronDown className={evidenceOpen ? 'size-4 rotate-180' : 'size-4'} />
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className='space-y-3 pt-3'>
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
                未改采集方式时继承平台证据策略，出厂默认成功失败都留截图和整次录像。Trace
                是调试轨迹，选「始终」用于当场排错，用 Playwright Trace Viewer 打开。
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <DialogFooter>
          <Button
            disabled={
              !scenarioId ||
              saving ||
              executionScenario.isPending ||
              !published ||
              Boolean(missing) ||
              accounts.isPending ||
              (needsAccount && !targetAccountId) ||
              Boolean(targetAccountId && !accounts.data?.items.some(item => item.id === targetAccountId && item.status === 'active'))
            }
            onClick={() => {
              if (missing) {
                toast.error(`请填写「${missing.label}」`)
                return
              }
              const parsed = runInputSchema.safeParse(runInputValues(inputDecls, inputValues))
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
