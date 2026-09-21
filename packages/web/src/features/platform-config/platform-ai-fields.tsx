import { useFormContext } from 'react-hook-form'
import {
  nextPlatformAiBaseUrl,
  PLATFORM_AI_PROVIDER_PRESETS,
  PLATFORM_AI_PROVIDERS,
  PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE,
  PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE,
  platformAiThinkingUnsupported,
  type PlatformAiProvider,
  type PlatformConfigDocument,
} from '@cairn/shared'
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

export function PlatformAiFields({
  canWrite,
  apiKey,
  secretRef,
  onApiKeyChange,
  onRegisterSecret,
  onTestConnection,
  busy,
}: {
  canWrite: boolean
  apiKey: string
  secretRef?: { provider: string; secretId: string }
  onApiKeyChange: (value: string) => void
  onRegisterSecret: () => void
  onTestConnection?: () => void
  busy: boolean
}) {
  const form = useFormContext<PlatformConfigDocument>()
  const provider = form.watch('platformAi.provider')
  const thinkingLocked = platformAiThinkingUnsupported(provider)
  const suggested = provider ? PLATFORM_AI_PROVIDER_PRESETS[provider].suggestedModels.join('、') : undefined

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
                <FormControl>
                  <Input
                    disabled={!canWrite}
                    placeholder={suggested ? `例如 ${suggested}` : '例如 deepseek-chat'}
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
        <div className='space-y-2 rounded-md border border-border px-3 py-3'>
          <Label htmlFor='platform-ai-model-key'>模型密钥</Label>
          <p className='text-label text-muted-foreground'>
            密钥只写不回显。与浏览器 AI 的 Secret 分开绑定。
            {secretRef
              ? ` 已绑定 Secret ${secretRef.secretId.slice(0, 8)}…`
              : ' 尚未绑定 Secret。'}
          </p>
          <div className='flex flex-col gap-2 sm:flex-row'>
            <Input
              id='platform-ai-model-key'
              type='password'
              autoComplete='new-password'
              disabled={!canWrite}
              placeholder='粘贴新密钥'
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
            />
            <Can permission='platform-config:write'>
              <Button
                type='button'
                variant='outline'
                loading={busy}
                onClick={onRegisterSecret}
              >
                登记密钥
              </Button>
            </Can>
            {onTestConnection ? (
              <Button
                type='button'
                variant='outline'
                disabled={!canWrite || busy || !provider}
                onClick={onTestConnection}
              >
                测试连接
              </Button>
            ) : null}
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
