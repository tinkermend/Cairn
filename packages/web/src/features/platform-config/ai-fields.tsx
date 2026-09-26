import * as React from 'react'
import { useFormContext } from 'react-hook-form'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import {
  FACTORY_RESOLUTION_CEILING,
  FACTORY_RESOLUTION_DEFAULT,
  RESOLUTION_CEILING_LABELS,
  RESOLUTION_POLICIES,
  RESOLUTION_PREFERENCE_LABELS,
  LOCATOR_PRESETS,
  LOCATOR_PRESET_LABELS,
  legacyCeilingRoutes,
  legacyPolicyRoutes,
  mergeEffectiveResolution,
  locatorPresetFor,
  resolveLocatorPlan,
  locatorReadiness,
  modelServiceOrigin,
  type PlatformConfigDocument,
} from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Can } from '@/components/rbac/can'
import { locatorRouteListLabel, locatorSkippedLabel } from '@/lib/locator-labels'
import {
  FieldGrid,
  FieldHelp,
  NumberSetting,
  SettingLabel,
  SettingSection,
  SwitchGrid,
  SwitchRow,
} from './setting-layout'

export function AiFields({
  canWrite,
  apiKey,
  secretRef,
  boundBaseUrl,
  onApiKeyChange,
  onRegisterSecret,
  onUnbindSecret,
  onTestConnection,
  busy,
}: {
  canWrite: boolean
  apiKey: string
  secretRef?: { provider: string; secretId: string }
  boundBaseUrl?: string
  onApiKeyChange: (value: string) => void
  onRegisterSecret: () => void
  onUnbindSecret?: () => void
  onTestConnection: () => void
  busy: boolean
}) {
  const form = useFormContext<PlatformConfigDocument>()
  const currentUrl = form.watch('browserAi.baseUrl')
  const visual = form.watch('browserAi')
  const platformText = form.watch('platformAi')
  const textReady = Boolean(platformText?.enabled && platformText.baseUrl && platformText.model && platformText.secretRef)
  const visionReady = Boolean(visual.enabled && visual.baseUrl && visual.model && visual.modelFamily && visual.secretRef)
  const locator = form.watch('locator')
  let locatorPreview = ''
  if (locator) {
    try {
      const result = resolveLocatorPlan({
        platform: { plan: locator.defaultPlan, limits: locator.limits, defaultPolicy: visual.defaultResolution, ceiling: visual.resolutionCeiling },
        ...locatorReadiness(form.getValues()),
      })
      locatorPreview = `实际：${locatorRouteListLabel(result.actual)}${result.skipped.length ? `；跳过 ${locatorSkippedLabel(result.skipped)}` : ''}`
    } catch (error) { locatorPreview = error instanceof Error ? error.message : '定位路线不可用' }
  }
  const presetKeys = Object.keys(LOCATOR_PRESETS) as Array<keyof typeof LOCATOR_PRESETS>
  const allowedOptions = [
    { value: 'rule', label: '仅规则' },
    { value: 'rule,text_ai', label: '规则和文本模型' },
    { value: 'rule,vision_ai', label: '规则和视觉模型' },
    { value: 'rule,text_ai,vision_ai', label: '规则、文本模型和视觉模型' },
  ]
  const isOriginMismatched = React.useMemo(() => {
    if (!secretRef || !boundBaseUrl || !currentUrl) return false
    try {
      return modelServiceOrigin(currentUrl) !== modelServiceOrigin(boundBaseUrl)
    } catch {
      return false
    }
  }, [secretRef, boundBaseUrl, currentUrl])

  return (
    <div className='space-y-6'>
      <SettingSection
        title='视觉定位'
        hint='用于看屏幕、定位按钮和图标。文字理解和判断使用「平台 AI」。'
      >
        <div className='space-y-4'>
          <div className='flex flex-wrap items-center gap-2 text-label'>
            <Badge variant='secondary'>规则定位：可用</Badge>
            <Badge variant={textReady ? 'secondary' : 'outline'}>文本定位：{textReady ? '就绪' : '未就绪，请检查平台 AI'}</Badge>
            <Badge variant={visionReady ? 'secondary' : 'outline'}>视觉定位：{visionReady ? '就绪' : '未就绪'}</Badge>
          </div>
          <div className='space-y-3 rounded-lg border border-border-default p-3'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div>
                <p className='font-medium'>普通步骤的定位路线</p>
                <p className='text-label text-muted-foreground'>允许的能力与尝试顺序分别设置；只影响点击、填写等普通步骤。</p>
              </div>
              {!locator ? <Button type='button' variant='outline' size='sm' disabled={!canWrite} onClick={() => form.setValue('locator', {
                limits: { v: 2, allowed: legacyCeilingRoutes(visual.resolutionCeiling) },
                defaultPlan: { v: 2, order: legacyPolicyRoutes(mergeEffectiveResolution({ ceiling: visual.resolutionCeiling, defaultResolution: visual.defaultResolution, browserAiEnabled: visual.enabled }), textReady && visionReady) },
              }, { shouldDirty: true })}>升级为新版定位配置</Button> : null}
            </div>
            {!locator ? <p className='text-label text-muted-foreground'>旧版实际顺序：{locatorRouteListLabel(legacyPolicyRoutes(mergeEffectiveResolution({ ceiling: visual.resolutionCeiling, defaultResolution: visual.defaultResolution, browserAiEnabled: visual.enabled }), textReady && visionReady))}。升级后可独立设置路线和上限；旧版已发布场景仍按旧快照执行。</p> : (
              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label>平台允许的定位能力</Label>
                  <Select value={locator.limits.allowed.join(',')} disabled={!canWrite} onValueChange={(value) => form.setValue('locator', { ...locator, limits: { v: 2, allowed: value.split(',') as typeof locator.limits.allowed } }, { shouldDirty: true })}>
                    <SelectTrigger aria-label='平台允许的定位能力'><SelectValue /></SelectTrigger>
                    <SelectContent>{allowedOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className='space-y-1.5'>
                  <Label>平台默认定位顺序</Label>
                  <Select value={locatorPresetFor(locator.defaultPlan) ?? 'custom'} disabled={!canWrite} onValueChange={(value) => {
                    if (value === 'custom') return
                    form.setValue('locator', { ...locator, defaultPlan: { v: 2, order: [...LOCATOR_PRESETS[value as keyof typeof LOCATOR_PRESETS].order] } }, { shouldDirty: true })
                  }}>
                    <SelectTrigger aria-label='平台默认定位顺序'><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {!locatorPresetFor(locator.defaultPlan) ? <SelectItem value='custom'>当前顺序：{locatorRouteListLabel(locator.defaultPlan.order)}</SelectItem> : null}
                      {presetKeys.map((key) => <SelectItem key={key} value={key}>{LOCATOR_PRESET_LABELS[key]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <p className='text-label text-muted-foreground sm:col-span-2'>请求：{locatorRouteListLabel(locator.defaultPlan.order)}；{locatorPreview}</p>
              </div>
            )}
          </div>
          <SwitchGrid>
            <FormField
              name='browserAi.enabled'
              render={({ field }) => (
                <SwitchRow
                  label='启用视觉定位'
                  help='关闭后，不能再发布或新建包含 AI 步骤的运行。已经开始的运行不受影响。'
                  checked={field.value}
                  disabled={!canWrite}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <FormField
              name='aiPathLearning.actionTrace'
              render={({ field }) => (
                <SwitchRow
                  label='记录 AI 动作事实'
                  help='开启后，新运行中的 AI 步骤会在动作发出前记录目标候选与值来源，用于评估把 AI 路径固化为确定性步骤。目标系统可在其设置里单独关闭。'
                  checked={Boolean(field.value)}
                  disabled={!canWrite}
                  onCheckedChange={field.onChange}
                />
              )}
            />
          </SwitchGrid>
          <FieldGrid>
            <FormField
              name='browserAi.baseUrl'
              render={({ field }) => (
                <FormItem>
                  <SettingLabel
                    label='模型服务地址'
                    help='填写视觉模型的接口地址，不要把密钥写在地址里。更换地址后需要重新登记密钥。'
                  />
                  <FormControl>
                    <Input
                      disabled={!canWrite}
                      placeholder='https://api.example.com/v1'
                      value={field.value ?? ''}
                      onChange={(event) =>
                        field.onChange(event.target.value || undefined)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              name='browserAi.model'
              render={({ field }) => (
                <FormItem>
                  <SettingLabel label='模型名' />
                  <FormControl>
                    <Input
                      disabled={!canWrite}
                      value={field.value ?? ''}
                      onChange={(event) =>
                        field.onChange(event.target.value || undefined)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              name='browserAi.modelFamily'
              render={({ field }) => (
                <FormItem>
                  <SettingLabel
                    label='视觉模型系列'
                    help='填写与所选模型对应的系列名称，须是平台已支持的系列。'
                  />
                  <FormControl>
                    <Input
                      disabled={!canWrite}
                      placeholder='doubao-seed'
                      value={field.value ?? ''}
                      onChange={(event) =>
                        field.onChange(event.target.value || undefined)
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <NumberSetting
              name='browserAi.requestTimeoutMs'
              label='单次请求超时'
              unit='ms'
              canWrite={canWrite}
            />
            <NumberSetting
              name='browserAi.stepMaxCalls'
              label='每步骤调用上限'
              canWrite={canWrite}
            />
            {!locator ? <FormField
              name='browserAi.resolutionCeiling'
              render={({ field }) => (
                <FormItem>
                  <SettingLabel
                    label='AI 定位能力上限'
                    help='只限制点击、填写等步骤找页面元素的方式。视觉操作会调用视觉模型；AI 提取和 AI 判断也可能回退视觉模型。'
                  />
                  <Select
                    value={field.value || FACTORY_RESOLUTION_CEILING}
                    disabled={!canWrite}
                    onValueChange={(next) =>
                      field.onChange(next || FACTORY_RESOLUTION_CEILING)
                    }
                  >
                    <FormControl>
                      <SelectTrigger className='w-full' aria-label='AI 定位能力上限'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {RESOLUTION_POLICIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {RESOLUTION_CEILING_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            /> : null}
            {!locator ? <FormField
              name='browserAi.defaultResolution'
              render={({ field }) => (
                <FormItem>
                  <SettingLabel
                    label='平台默认优先顺序'
                    help='目标、场景和步骤都没有单独指定时使用。实际采用的方式不会超过上面的能力上限。'
                  />
                  <Select
                    value={field.value || FACTORY_RESOLUTION_DEFAULT}
                    disabled={!canWrite}
                    onValueChange={(next) =>
                      field.onChange(next || FACTORY_RESOLUTION_DEFAULT)
                    }
                  >
                    <FormControl>
                      <SelectTrigger className='w-full' aria-label='平台默认优先顺序'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {RESOLUTION_POLICIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {RESOLUTION_PREFERENCE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            /> : null}
            <NumberSetting
              name='browserAi.maxOutputTokens'
              label='单次输出 token 上限'
              canWrite={canWrite}
            />
          </FieldGrid>
        </div>
      </SettingSection>
      <div className='space-y-3 rounded-lg border border-border bg-card/50 p-4 shadow-xs'>
        <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
          <div className='space-y-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <Label htmlFor='platform-model-key' className='font-semibold'>
                模型密钥
              </Label>
              <FieldHelp label='模型密钥'>
                {isOriginMismatched
                  ? '当前服务地址和已登记密钥不是同一处。请重新登记后再保存，避免把原密钥发到新地址。'
                  : '密钥只写入、不回显。更换服务地址后需要重新登记，保存后生效。'}
              </FieldHelp>
              {secretRef ? (
                isOriginMismatched ? (
                  <Badge
                    variant='outline'
                    className='gap-1 border-status-warning-border bg-status-warning-surface text-status-warning-foreground'
                  >
                    <AlertTriangle className='size-3 text-status-warning-foreground' />
                    地址已变更，原密钥不适用
                  </Badge>
                ) : (
                  <Badge
                    variant='secondary'
                    className='gap-1 border-status-success-border bg-status-success-surface text-status-success-foreground'
                  >
                    <CheckCircle2 className='size-3 text-status-success-foreground' />
                    已绑定 Secret ({secretRef.secretId.slice(0, 8)}…)
                  </Badge>
                )
              ) : (
                <Badge variant='outline' className='text-muted-foreground'>
                  未绑定密钥
                </Badge>
              )}
            </div>
          </div>
          {secretRef && onUnbindSecret && canWrite ? (
            <Can permission='platform-config:write'>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='self-start text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:self-auto'
                disabled={busy}
                onClick={onUnbindSecret}
              >
                解除绑定
              </Button>
            </Can>
          ) : null}
        </div>

        <div className='flex flex-col gap-2.5 sm:flex-row sm:items-center'>
          <div className='w-full sm:max-w-md'>
            <PasswordInput
              id='platform-model-key'
              aria-label='模型密钥'
              autoComplete='new-password'
              disabled={!canWrite}
              placeholder={secretRef ? '粘贴新密钥以覆盖当前绑定' : '粘贴新密钥'}
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
            />
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Can permission='platform-config:write'>
              <Button
                type='button'
                variant='default'
                loading={busy}
                disabled={!canWrite || !apiKey.trim()}
                onClick={onRegisterSecret}
              >
                登记密钥
              </Button>
            </Can>
            {onTestConnection ? (
              <Can permission='platform-config:write'>
                <Button
                  type='button'
                  variant='outline'
                  loading={busy}
                  disabled={!canWrite || busy || (!secretRef && !apiKey.trim())}
                  onClick={onTestConnection}
                >
                  测试连接
                </Button>
              </Can>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
