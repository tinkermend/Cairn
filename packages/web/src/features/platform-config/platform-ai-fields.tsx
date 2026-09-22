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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
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
import { Switch } from '@/components/ui/switch'
import { Can } from '@/components/rbac/can'
import { AnalysisAiFields } from './analysis-ai-fields'

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
    <div className='grid gap-6'>
      <div className='space-y-4 rounded-lg border border-border p-4'>
        <div>
          <h3 className='text-section font-semibold'>平台通用模型</h3>
          <p className='text-label text-muted-foreground'>
            供识途助手与知识分析共用。下拉选择的是提供商方言，不是主机名；地址仍可改成代理或中转。
          </p>
        </div>
        <div className='grid gap-4 md:grid-cols-2'>
          <FormField
            name='platformAi.provider'
            render={({ field }) => (
              <FormItem>
                <FormLabel>模型提供商</FormLabel>
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
                <FormDescription>
                  中转站上跑哪一家，就选哪一家，这样思考字段才会按该方言发送。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.baseUrl'
            render={({ field }) => (
              <FormItem>
                <FormLabel>模型服务地址</FormLabel>
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
                <FormDescription>
                  不得在 URL 内嵌凭据。更换地址后必须重新登记密钥。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.model'
            render={({ field }) => (
              <FormItem>
                <FormLabel>模型名</FormLabel>
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
                      placeholder={provider ? '填写中转站或灰度模型名' : '请先选择模型提供商'}
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(event.target.value || undefined)}
                    />
                  </FormControl>
                ) : null}
                <FormDescription>
                  {modelHint && !customModel
                    ? `${modelHint}。候选按各提供商官方文档整理，模型更新快，以官方为准。`
                    : '候选之外的模型（中转站别名等）选「自定义…」手填。'}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.thinkingMode'
            render={({ field }) => (
              <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2'>
                <div>
                  <FormLabel>思考模式</FormLabel>
                  <FormDescription>
                    {thinkingLocked
                      ? PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE
                      : '助手与知识分析要结构化 JSON，默认关闭更稳。'}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    aria-label='思考模式'
                    checked={field.value === 'on'}
                    disabled={!canWrite || thinkingLocked}
                    onCheckedChange={(checked) => field.onChange(checked ? 'on' : 'off')}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
        <div className='space-y-3 rounded-lg border border-border bg-card/50 p-4 shadow-xs'>
          <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
            <div className='space-y-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <Label htmlFor='platform-ai-model-key' className='font-semibold'>
                  模型密钥
                </Label>
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
              <p className='text-label text-muted-foreground'>
                {secretRef
                  ? isOriginMismatched
                    ? '当前服务地址与已登记密钥绑定的地址不一致。变更提供商或服务地址后必须重新登记密钥，避免把原凭据发往新地址。'
                    : '密钥只写不回显。与浏览器 AI 分开绑定；再次登记新密钥将直接覆盖当前绑定，保存配置后正式生效。'
                  : '密钥只写不回显。与浏览器 AI 分开绑定；启用前须先登记有效密钥，保存配置后正式生效。'}
              </p>
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
      </div>

      <div className='space-y-4 rounded-lg border border-border p-4'>
        <div>
          <h3 className='text-section font-semibold'>识途助手</h3>
          <p className='text-label text-muted-foreground'>
            为控制台提供自然语言问答、功能导览与运行/场景诊断能力。
          </p>
        </div>
        <FormField
          name='platformAi.enabled'
          render={({ field }) => (
            <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2'>
              <div>
                <FormLabel>启用识途助手</FormLabel>
                <FormDescription>
                  开启后可在页面右下角唤起助手。关闭后不影响知识分析，也不会启动浏览器。
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  aria-label='启用识途助手'
                  checked={field.value}
                  disabled={!canWrite}
                  onCheckedChange={(checked) => requireProvider(checked, field.onChange)}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <div className='grid gap-4 md:grid-cols-2'>
          <FormField
            name='platformAi.requestTimeoutMs'
            render={({ field }) => (
              <FormItem>
                <FormLabel>单次请求超时（ms）</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    disabled={!canWrite}
                    value={field.value}
                    onChange={(event) =>
                      field.onChange(Number(event.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.turnTimeoutMs'
            render={({ field }) => (
              <FormItem>
                <FormLabel>整轮超时（ms）</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    disabled={!canWrite}
                    value={field.value}
                    onChange={(event) =>
                      field.onChange(Number(event.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.maxCallsPerTurn'
            render={({ field }) => (
              <FormItem>
                <FormLabel>每轮调用上限</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    disabled={!canWrite}
                    value={field.value}
                    onChange={(event) =>
                      field.onChange(Number(event.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.maxOutputTokens'
            render={({ field }) => (
              <FormItem>
                <FormLabel>单次输出 token 上限</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    disabled={!canWrite}
                    value={field.value}
                    onChange={(event) =>
                      field.onChange(Number(event.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.userInflightLimit'
            render={({ field }) => (
              <FormItem>
                <FormLabel>用户在途上限</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    disabled={!canWrite}
                    value={field.value}
                    onChange={(event) =>
                      field.onChange(Number(event.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='platformAi.platformInflightLimit'
            render={({ field }) => (
              <FormItem>
                <FormLabel>平台在途上限</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    disabled={!canWrite}
                    value={field.value}
                    onChange={(event) =>
                      field.onChange(Number(event.target.value))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>

      <div className='space-y-4 rounded-lg border border-border p-4'>
        <div>
          <h3 className='text-section font-semibold'>知识分析</h3>
          <p className='text-label text-muted-foreground'>
            供 Worker 分析运行事实与地图，生成候选知识。调度工厂开关仍独立控制是否接收作业。
          </p>
        </div>
        <AnalysisAiFields canWrite={canWrite} />
      </div>
    </div>
  )
}
