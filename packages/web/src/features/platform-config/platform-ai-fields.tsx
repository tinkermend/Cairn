import { useMemo, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import {
  isPlatformAiPresetModel,
  modelServiceOrigin,
  nextPlatformAiBaseUrl,
  nextPlatformAiModel,
  PLATFORM_AI_PROVIDER_PRESETS,
  PLATFORM_AI_PROVIDERS,
  PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE,
  PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE,
  platformAiThinkingUnsupported,
  type PlatformAiProvider,
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
import { AnalysisAiFields } from './analysis-ai-fields'
import {
  FieldGrid,
  FieldHelp,
  NumberSetting,
  SettingLabel,
  SettingSection,
  SwitchGrid,
  SwitchRow,
} from './setting-layout'

const CUSTOM_MODEL = '__custom__'

export function PlatformAiFields({
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
  onTestConnection?: () => void
  busy: boolean
}) {
  const form = useFormContext<PlatformConfigDocument>()
  const provider = form.watch('platformAi.provider')
  const thinkingLocked = platformAiThinkingUnsupported(provider)
  const model = form.watch('platformAi.model')
  const currentUrl = form.watch('platformAi.baseUrl')
  const isOriginMismatched = useMemo(() => {
    if (!secretRef || !boundBaseUrl || !currentUrl) return false
    try {
      return modelServiceOrigin(currentUrl) !== modelServiceOrigin(boundBaseUrl)
    } catch {
      return false
    }
  }, [secretRef, boundBaseUrl, currentUrl])

  const catalog = provider ? PLATFORM_AI_PROVIDER_PRESETS[provider].models : []
  // 「自定义…」是显式选择；库里已有的非候选模型名（中转站别名、旧配置）也按自定义呈现，不会被下拉吞掉。
  const [pickedCustom, setPickedCustom] = useState(false)
  const customModel = !provider || pickedCustom || Boolean(model && !isPlatformAiPresetModel(provider, model))
  const modelHint = catalog.find((item) => item.id === model)?.hint

  function requireProvider(checked: boolean, onChange: (value: boolean) => void) {
    if (checked && !provider) {
      form.setError('platformAi.provider', { message: PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE })
      return
    }
    onChange(checked)
  }

  return (
    <div className='space-y-6'>
      <SettingSection
        title='平台通用模型'
        hint='选择本企业实际调用的模型厂商。服务地址可以改成企业网关或代理。'
      >
        <div className='space-y-4'>
        <FieldGrid>
          <FormField
            name='platformAi.provider'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='模型提供商'
                  help='按实际调用的厂商选择。平台会使用该厂商的接口；思考模式能否打开，也由这里决定。'
                />
                <FormControl>
                  <Select
                    value={field.value || undefined}
                    disabled={!canWrite}
                    onValueChange={(next) => {
                      if (!(PLATFORM_AI_PROVIDERS as readonly string[]).includes(next)) return
                      const nextProvider = next as PlatformAiProvider
                      const currentUrl = form.getValues('platformAi.baseUrl')
                      field.onChange(nextProvider)
                      const nextModel = nextPlatformAiModel({
                        previousProvider: field.value,
                        currentModel: form.getValues('platformAi.model'),
                        nextProvider,
                      })
                      form.setValue('platformAi.model', nextModel || undefined, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                      if (isPlatformAiPresetModel(nextProvider, nextModel)) setPickedCustom(false)
                      form.setValue(
                        'platformAi.baseUrl',
                        nextPlatformAiBaseUrl({
                          previousProvider: field.value,
                          currentUrl,
                          nextProvider,
                        }) || undefined,
                        { shouldDirty: true, shouldValidate: true },
                      )
                      if (platformAiThinkingUnsupported(nextProvider)) {
                        form.setValue('platformAi.thinkingMode', 'off', { shouldDirty: true })
                      }
                      form.clearErrors('platformAi.provider')
                    }}
                  >
                    <SelectTrigger className='w-full' aria-label='模型提供商'>
                      <SelectValue placeholder='请选择模型提供商' />
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORM_AI_PROVIDERS.map((item) => (
                        <SelectItem key={item} value={item}>
                          {PLATFORM_AI_PROVIDER_PRESETS[item].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.baseUrl'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='模型服务地址'
                  help='填写厂商或企业网关的接口地址，不要把密钥写在地址里。更换地址后需要重新登记密钥。'
                />
                <FormControl>
                  <Input
                    disabled={!canWrite}
                    placeholder={
                      provider
                        ? PLATFORM_AI_PROVIDER_PRESETS[provider].defaultBaseUrl
                        : 'https://api.example.com/v1'
                    }
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
            name='platformAi.model'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='模型名'
                  help={
                    modelHint && !customModel
                      ? `${modelHint}。列表会随厂商更新，以当前可调用的型号为准。`
                      : '列表中没有的型号，选「自定义…」填写名称。'
                  }
                />
                {provider ? (
                  <FormControl>
                    <Select
                      value={customModel ? CUSTOM_MODEL : field.value}
                      disabled={!canWrite}
                      onValueChange={(next) => {
                        // Radix 受控值变化（含切换提供商换掉整份候选）时，内部原生 select 会用尚未挂载的选项
                        // 同步出一次空串回调；真实选择不会是空值，收下它会把模型名清掉。
                        if (!next) return
                        if (next === CUSTOM_MODEL) {
                          setPickedCustom(true)
                          return
                        }
                        setPickedCustom(false)
                        field.onChange(next)
                      }}
                    >
                      <SelectTrigger className='w-full' aria-label='模型名'>
                        <SelectValue placeholder='请选择模型' />
                      </SelectTrigger>
                      <SelectContent>
                        {catalog.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.id}
                          </SelectItem>
                        ))}
                        <SelectItem value={CUSTOM_MODEL}>自定义…</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                ) : null}
                {customModel ? (
                  <FormControl>
                    <Input
                      aria-label={provider ? '自定义模型名' : '模型名'}
                      disabled={!canWrite}
                      placeholder={provider ? '填写网关或未列出的模型名称' : '请先选择模型提供商'}
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(event.target.value || undefined)}
                    />
                  </FormControl>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        </FieldGrid>
        <SwitchGrid>
          <FormField
            name='platformAi.thinkingMode'
            render={({ field }) => (
              <SwitchRow
                label='思考模式'
                help='建议关闭。开启后模型会先做额外推理，更慢也更贵，助手和知识分析的结果也可能不稳定。'
                note={thinkingLocked ? PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE : undefined}
                checked={field.value === 'on'}
                disabled={!canWrite || thinkingLocked}
                onCheckedChange={(checked) => field.onChange(checked ? 'on' : 'off')}
              />
            )}
          />
        </SwitchGrid>
        </div>
        <div className='space-y-3 rounded-lg border border-border bg-card/50 p-4 shadow-xs'>
          <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
            <div className='space-y-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <Label htmlFor='platform-ai-model-key' className='font-semibold'>
                  模型密钥
                </Label>
                <FieldHelp label='平台模型密钥'>
                  {isOriginMismatched
                    ? '当前服务地址和已登记密钥不是同一处。请重新登记后再保存，避免把原密钥发到新地址。'
                    : '与浏览器视觉模型分开登记。密钥只写入、不回显。更换地址后需要重新登记，保存后生效。'}
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
                id='platform-ai-model-key'
                aria-label='平台模型密钥'
                autoComplete='new-password'
                disabled={!canWrite}
                placeholder={
                  secretRef
                    ? '粘贴新密钥以覆盖当前绑定'
                    : provider
                      ? `粘贴 ${PLATFORM_AI_PROVIDER_PRESETS[provider].label} 密钥`
                      : '粘贴新密钥'
                }
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
                    disabled={!canWrite || busy || !provider || (!secretRef && !apiKey.trim())}
                    onClick={onTestConnection}
                  >
                    测试连接
                  </Button>
                </Can>
              ) : null}
            </div>
          </div>
        </div>
      </SettingSection>

      <SettingSection title='识途助手' hint='控制台里的问答、导览和诊断。'>
        <div className='space-y-4'>
          <SwitchGrid>
            <FormField
              name='platformAi.enabled'
              render={({ field }) => (
                <SwitchRow
                  label='启用识途助手'
                  help='开启后可在页面右下角提问。关闭后，知识分析和浏览器操作不受影响。'
                  checked={field.value}
                  disabled={!canWrite}
                  onCheckedChange={(checked) => requireProvider(checked, field.onChange)}
                />
              )}
            />
          </SwitchGrid>
          <FieldGrid>
            <NumberSetting
              name='platformAi.requestTimeoutMs'
              label='单次请求超时'
              unit='ms'
              canWrite={canWrite}
            />
            <NumberSetting
              name='platformAi.turnTimeoutMs'
              label='一轮问答超时'
              unit='ms'
              canWrite={canWrite}
              help='一次提问从发出到结束的最长时间，须不短于单次请求超时。'
            />
            <NumberSetting
              name='platformAi.maxCallsPerTurn'
              label='一轮最多调用次数'
              canWrite={canWrite}
              help='一次提问里，助手最多向模型请求这么多次。'
            />
            <NumberSetting
              name='platformAi.maxOutputTokens'
              label='单次输出 token 上限'
              canWrite={canWrite}
            />
            <NumberSetting
              name='platformAi.userInflightLimit'
              label='每人同时提问上限'
              canWrite={canWrite}
              help='同一人同时进行的提问不能超过这个数，也不能超过全平台同时提问上限。'
            />
            <NumberSetting
              name='platformAi.platformInflightLimit'
              label='全平台同时提问上限'
              canWrite={canWrite}
              help='所有人加起来，同时进行的提问不能超过这个数。超出后，新的提问会排队。'
            />
          </FieldGrid>
        </div>
      </SettingSection>

      <SettingSection
        title='知识分析'
        hint='从运行记录和知识地图整理待确认的知识。要不要按计划执行，在「执行默认值」里单独开关。'
      >
        <AnalysisAiFields canWrite={canWrite} />
      </SettingSection>
    </div>
  )
}
