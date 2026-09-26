import {
  LOCATOR_PRESETS,
  LOCATOR_PRESET_LABELS,
  legacyPolicyRoutes,
  locatorPresetFor,
  locatorReadiness,
  mergeEffectiveResolution,
  resolveLocatorPlan,
  upgradeAuthoringLocatorDocument,
  type PlatformConfigDocument,
  type ScenarioAuthoringDocumentV2,
  type TargetResolutionPolicy,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { FieldHelp } from '@/components/ui/field-help'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { locatorRouteListLabel, locatorSkippedLabel } from '@/lib/locator-labels'

export function ScenarioLocatorSettings({ document, platform, target, disabled, onChange }: {
  document: ScenarioAuthoringDocumentV2
  platform?: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  disabled?: boolean
  onChange: (document: ScenarioAuthoringDocumentV2) => void
}) {
  const presetKeys = Object.keys(LOCATOR_PRESETS) as Array<keyof typeof LOCATOR_PRESETS>
  const textReady = platform ? locatorReadiness(platform).textReady : false
  const legacyEffective = platform ? mergeEffectiveResolution({
    ceiling: platform.browserAi.resolutionCeiling,
    defaultResolution: platform.browserAi.defaultResolution,
    targetCeiling: target?.ceiling,
    targetPreference: target?.preference,
    document: document.resolution,
    browserAiEnabled: platform.browserAi.enabled,
  }) : 'deterministic_only'
  const legacyRoutes = legacyPolicyRoutes(legacyEffective, textReady && Boolean(platform && locatorReadiness(platform).visionReady))
  const upgrade = () => platform ? upgradeAuthoringLocatorDocument({ document, platform, target }) : document
  let preview = '正在读取平台定位配置…'
  if (platform) {
    try {
      const result = resolveLocatorPlan({
        platform: { plan: platform.locator?.defaultPlan, limits: platform.locator?.limits, defaultPolicy: platform.browserAi.defaultResolution, ceiling: platform.browserAi.resolutionCeiling },
        target: target ? { plan: target.plan, limits: target.limits, policy: target.preference, ceiling: target.ceiling } : undefined,
        scenario: { plan: document.locatorPlan, policy: document.resolution },
        ...locatorReadiness(platform),
      })
      preview = `请求：${locatorRouteListLabel(result.requested)}；预计实际：${locatorRouteListLabel(result.actual)}${result.skipped.length ? `；跳过：${locatorSkippedLabel(result.skipped)}` : ''}`
    } catch (error) { preview = error instanceof Error ? error.message : '定位路线不可用' }
  }
  return (
    <section className='space-y-3 rounded-lg border border-border-default p-3'>
      <div className='flex items-center gap-1.5'>
        <Label>场景默认定位顺序</Label>
        <FieldHelp label='场景默认定位顺序'>
          步骤未单独设置时使用；选择只影响普通步骤找页面元素。
        </FieldHelp>
      </div>
      {document.locatorProtocol !== 2 && !document.locatorPlan ? (
        <div className='space-y-2 text-label'>
          <p>旧版实际顺序：{locatorRouteListLabel(legacyRoutes)}</p>
          <p className='text-muted-foreground'>升级后：所有模型写操作均需核对业务名称；规则兜底会尝试地图修复；模型调用错误会停止并显示原因。</p>
          <Button type='button' size='sm' variant='outline' disabled={disabled || !platform} onClick={() => onChange(upgrade())}>升级草稿到新版定位</Button>
        </div>
      ) : null}
      <Select
        disabled={disabled || !platform}
        value={document.locatorPlan ? locatorPresetFor(document.locatorPlan) ?? 'custom' : document.resolution ? 'legacy' : 'inherit'}
        onValueChange={(value) => {
          if (value === 'legacy' || value === 'custom') return
          const upgraded = upgrade()
          const { locatorPlan: _plan, resolution: _old, ...rest } = upgraded
          onChange(value === 'inherit' ? { ...rest, locatorProtocol: 2 }
            : { ...rest, locatorProtocol: 2, locatorPlan: { v: 2, order: [...LOCATOR_PRESETS[value as keyof typeof LOCATOR_PRESETS].order] } })
        }}
      >
        <SelectTrigger aria-label='场景默认定位顺序'><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value='inherit'>继承目标／平台</SelectItem>
          {document.resolution ? <SelectItem value='legacy'>旧版：{locatorRouteListLabel(legacyRoutes)}</SelectItem> : null}
          {document.locatorPlan && !locatorPresetFor(document.locatorPlan) ? <SelectItem value='custom'>当前顺序：{locatorRouteListLabel(document.locatorPlan.order)}</SelectItem> : null}
          {presetKeys.map((key) => <SelectItem key={key} value={key}>{LOCATOR_PRESET_LABELS[key]}</SelectItem>)}
        </SelectContent>
      </Select>
      <p className='text-label text-muted-foreground'>{preview}</p>
    </section>
  )
}
