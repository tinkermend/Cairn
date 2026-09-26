import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  LOCATOR_PRESETS,
  LOCATOR_PRESET_LABELS,
  legacyCeilingRoutes,
  legacyPolicyRoutes,
  locatorPresetFor,
  locatorReadiness,
  resolveLocatorPlan,
  RESOLUTION_CEILING_LABELS,
  RESOLUTION_PREFERENCE_LABELS,
  RESOLUTION_POLICIES,
  type ResolutionPolicy,
  type TargetDto,
  type TargetResolutionPolicyPatch,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateTargetResolutionPolicy } from '@/lib/targets-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { locatorRouteListLabel, locatorSkippedLabel } from '@/lib/locator-labels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const INHERIT = 'inherit'

function inheritLabel(overridden: boolean) {
  return overridden ? '本目标覆盖' : '继承自平台'
}

export function ResolutionPolicyCard({ target }: { target: TargetDto }) {
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const override = target.resolutionPolicy ?? null
  const effective = target.effectiveResolution
  const platform = useQuery({ queryKey: ['platform-config'], queryFn: fetchPlatformConfig }).data?.document
  const textReady = platform ? locatorReadiness(platform).textReady : false
  const presetKeys = Object.keys(LOCATOR_PRESETS) as Array<keyof typeof LOCATOR_PRESETS>
  const plan = override?.plan
  const limits = override?.limits
  const oldPlan = override?.preference ? legacyPolicyRoutes(override.preference, textReady && Boolean(platform && locatorReadiness(platform).visionReady)) : undefined
  const oldLimits = override?.ceiling ? legacyCeilingRoutes(override.ceiling) : undefined
  const allowedOptions = [
    { value: 'inherit', label: '继承平台允许集合' },
    { value: 'rule', label: '仅规则' },
    { value: 'rule,text_ai', label: '规则和文本模型' },
    { value: 'rule,vision_ai', label: '规则和视觉模型' },
    { value: 'rule,text_ai,vision_ai', label: '全部定位能力' },
  ]
  let planPreview = ''
  if (platform) {
    try {
      const result = resolveLocatorPlan({
        platform: { plan: platform.locator?.defaultPlan, limits: platform.locator?.limits, defaultPolicy: platform.browserAi.defaultResolution, ceiling: platform.browserAi.resolutionCeiling },
        target: override ? { plan: override.plan, limits: override.limits, policy: override.preference, ceiling: override.ceiling } : undefined,
        ...locatorReadiness(platform),
      })
      planPreview = `请求：${locatorRouteListLabel(result.requested)}；实际：${locatorRouteListLabel(result.actual)}${result.skipped.length ? `；跳过 ${locatorSkippedLabel(result.skipped)}` : ''}`
    } catch (error) { planPreview = error instanceof Error ? error.message : '定位路线不可用' }
  }
  const mutation = useMutation({
    mutationFn: (body: TargetResolutionPolicyPatch) => updateTargetResolutionPolicy(target.id, body),
    onSuccess: async () => {
      toast.success('已更新目标解析策略')
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新目标解析策略失败')
    },
  })

  return (
    <Card className='min-w-0'>
      <CardHeader>
        <CardTitle className='text-section font-semibold'>目标定位</CardTitle>
        <p className='mt-1 text-label text-muted-foreground'>
          本目标系统可收紧允许能力，也可覆盖默认尝试顺序。未设置时继承平台，只影响之后新建的运行。
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {(override?.preference || override?.ceiling) ? (
          <div className='space-y-2 rounded-md border border-border-default p-3 text-label'>
            <p className='font-medium'>旧版定位策略</p>
            <p>原实际顺序：{locatorRouteListLabel(oldPlan ?? legacyPolicyRoutes(effective?.preference ?? 'deterministic_only', textReady && Boolean(platform && locatorReadiness(platform).visionReady)))}；原允许路线：{(oldLimits ?? legacyCeilingRoutes(effective?.ceiling ?? 'deterministic_only')).join('、')}。</p>
            <p className='text-muted-foreground'>升级后写步骤的模型结果均需核对业务名称；规则兜底会尝试地图修复；模型调用出错会停止并显示原因。</p>
            <Button type='button' size='sm' variant='outline' disabled={!canWrite || mutation.isPending} onClick={() => mutation.mutate({
              ...(oldPlan ? { plan: { v: 2, order: oldPlan } } : { preference: null }),
              ...(oldLimits ? { limits: { v: 2, allowed: oldLimits } } : { ceiling: null }),
            })}>升级目标定位设置</Button>
          </div>
        ) : null}
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label>目标默认定位顺序</Label>
            <Select disabled={!canWrite || mutation.isPending} value={plan ? locatorPresetFor(plan) ?? 'custom' : INHERIT} onValueChange={(value) => {
              if (value === 'custom') return
              mutation.mutate({
                plan: value === INHERIT ? null : { v: 2, order: [...LOCATOR_PRESETS[value as keyof typeof LOCATOR_PRESETS].order] },
                ...(override?.ceiling ? { limits: { v: 2, allowed: legacyCeilingRoutes(override.ceiling) } } : {}),
              })
            }}>
              <SelectTrigger aria-label='目标默认定位顺序'><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>继承平台默认</SelectItem>
                {plan && !locatorPresetFor(plan) ? <SelectItem value='custom'>当前顺序：{locatorRouteListLabel(plan.order)}</SelectItem> : null}
                {presetKeys.map((key) => <SelectItem key={key} value={key}>{LOCATOR_PRESET_LABELS[key]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-2'>
            <Label>本目标允许的定位能力</Label>
            <Select disabled={!canWrite || mutation.isPending} value={limits?.allowed.join(',') ?? INHERIT} onValueChange={(value) => mutation.mutate({
              limits: value === INHERIT ? null : { v: 2, allowed: value.split(',') as NonNullable<TargetResolutionPolicyPatch['limits']>['allowed'] },
              ...(override?.preference ? { plan: { v: 2, order: oldPlan ?? ['rule'] } } : {}),
            })}>
              <SelectTrigger aria-label='本目标允许的定位能力'><SelectValue /></SelectTrigger>
              <SelectContent>{allowedOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <p className='text-label text-muted-foreground'>{planPreview || `请求：${locatorRouteListLabel(plan?.order ?? oldPlan ?? platform?.locator?.defaultPlan.order ?? legacyPolicyRoutes(effective?.preference ?? 'deterministic_only', textReady))}`}</p>
        {(override?.preference || override?.ceiling || (!plan && !limits)) ? <details className='text-label text-muted-foreground'>
          <summary className='cursor-pointer'>旧版设置与兼容说明</summary>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='target-resolution-preference'>解析优先顺序</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.preference != null)}
              </span>
            </div>
            <Select
              disabled={!canWrite || mutation.isPending}
              value={override?.preference ?? INHERIT}
              onValueChange={(value) => {
                mutation.mutate({
                  preference: value === INHERIT ? null : (value as ResolutionPolicy),
                })
              }}
            >
              <SelectTrigger id='target-resolution-preference' className='w-full' aria-label='解析优先顺序'>
                <SelectValue placeholder={effective ? RESOLUTION_PREFERENCE_LABELS[effective.preference] : '继承自平台'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  继承自平台{effective ? `（${RESOLUTION_PREFERENCE_LABELS[effective.preference]}）` : ''}
                </SelectItem>
                {RESOLUTION_POLICIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RESOLUTION_PREFERENCE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {override?.preference != null ? (
              <Button
                variant='ghost'
                size='sm'
                disabled={!canWrite}
                onClick={() => mutation.mutate({ preference: null })}
              >
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='target-resolution-ceiling'>该系统解析上限</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.ceiling != null)}
              </span>
            </div>
            <Select
              disabled={!canWrite || mutation.isPending}
              value={override?.ceiling ?? INHERIT}
              onValueChange={(value) => {
                mutation.mutate({
                  ceiling: value === INHERIT ? null : (value as ResolutionPolicy),
                })
              }}
            >
              <SelectTrigger id='target-resolution-ceiling' className='w-full' aria-label='该系统解析上限'>
                <SelectValue placeholder={effective ? RESOLUTION_CEILING_LABELS[effective.ceiling] : '不超过平台上限'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  不超过平台上限{effective ? `（${RESOLUTION_CEILING_LABELS[effective.ceiling]}）` : ''}
                </SelectItem>
                {RESOLUTION_POLICIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RESOLUTION_CEILING_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-label text-muted-foreground'>
              比平台更宽的选项会被压回平台上限。合规敏感系统可锁为仅规则。
            </p>
            {override?.ceiling != null ? (
              <Button
                variant='ghost'
                size='sm'
                disabled={!canWrite}
                onClick={() => mutation.mutate({ ceiling: null })}
              >
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
        </div>
        </details> : null}
      </CardContent>
    </Card>
  )
}
