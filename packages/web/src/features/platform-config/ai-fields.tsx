import {
  FACTORY_RESOLUTION_CEILING,
  FACTORY_RESOLUTION_DEFAULT,
  RESOLUTION_CEILING_LABELS,
  RESOLUTION_POLICIES,
  RESOLUTION_PREFERENCE_LABELS,
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

export function AiFields({
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
  onTestConnection: () => void
  busy: boolean
}) {
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
      <div className='space-y-2 rounded-md border border-border px-3 py-3'>
        <Label htmlFor='platform-model-key'>模型密钥</Label>
        <p className='text-label text-muted-foreground'>
          密钥只写不回显。
          {secretRef
            ? ` 已绑定 Secret ${secretRef.secretId.slice(0, 8)}…`
            : ' 尚未绑定 Secret。'}
        </p>
        <div className='flex flex-col gap-2 sm:flex-row'>
          <Input
            id='platform-model-key'
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
          <Can permission='platform-config:write'>
            <Button
              type='button'
              variant='outline'
              loading={busy}
              onClick={onTestConnection}
            >
              测试连接
            </Button>
          </Can>
        </div>
      </div>
    </div>
  )
}
