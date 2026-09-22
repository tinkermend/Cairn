import * as React from 'react'
import { useFormContext } from 'react-hook-form'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import {
  FACTORY_RESOLUTION_CEILING,
  FACTORY_RESOLUTION_DEFAULT,
  RESOLUTION_CEILING_LABELS,
  RESOLUTION_POLICIES,
  RESOLUTION_PREFERENCE_LABELS,
  modelServiceOrigin,
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
  const isOriginMismatched = React.useMemo(() => {
    if (!secretRef || !boundBaseUrl || !currentUrl) return false
    try {
      return modelServiceOrigin(currentUrl) !== modelServiceOrigin(boundBaseUrl)
    } catch {
      return false
    }
  }, [secretRef, boundBaseUrl, currentUrl])

  return (
    <div className='grid gap-5'>
      <FormField
        name='browserAi.enabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2'>
            <div>
              <FormLabel>启用浏览器仿真 AI</FormLabel>
              <FormDescription>
                关闭后不能新发布或创建含 AI 步骤的运行；已有运行继续按快照执行。
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <div className='grid gap-4 md:grid-cols-2'>
        <FormField
          name='browserAi.baseUrl'
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型服务地址</FormLabel>
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
              <FormDescription>
                不得在 URL 内嵌凭据。更换服务主机或端口后必须重新登记密钥。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.model'
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型名</FormLabel>
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
              <FormLabel>模型族</FormLabel>
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
              <FormDescription>
                须是 Worker 适配层支持的视觉模型族。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.requestTimeoutMs'
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
          name='browserAi.stepMaxCalls'
          render={({ field }) => (
            <FormItem>
              <FormLabel>每步骤调用上限</FormLabel>
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
          name='browserAi.resolutionCeiling'
          render={({ field }) => (
            <FormItem>
              <FormLabel>AI 定位能力上限</FormLabel>
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
              <FormDescription>
                这台平台最多允许走到哪一档。出厂为仅规则。目标系统只能再收紧，不能突破这里。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.defaultResolution'
          render={({ field }) => (
            <FormItem>
              <FormLabel>平台默认优先顺序</FormLabel>
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
              <FormDescription>
                目标系统、场景和步骤都未指定时使用。实际有效档位不会超过能力上限。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.maxOutputTokens'
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
      </div>
      <div className='space-y-3 rounded-lg border border-border bg-card/50 p-4 shadow-xs'>
        <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
          <div className='space-y-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <Label htmlFor='platform-model-key' className='font-semibold'>
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
                  ? '当前服务地址与已登记密钥绑定的地址不一致。变更地址后必须重新登记密钥，避免把原凭据发往新地址。'
                  : '密钥只写不回显。再次登记新密钥将直接覆盖当前绑定；保存配置后正式生效。'
                : '密钥只写不回显。启用前须先登记有效密钥；保存配置后正式生效。'}
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
