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
