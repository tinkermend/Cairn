import { useFormContext } from 'react-hook-form'
import {
  PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE,
  type PlatformConfigDocument,
} from '@cairn/shared'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export function AnalysisAiFields({ canWrite }: { canWrite: boolean }) {
  const form = useFormContext<PlatformConfigDocument>()
  const provider = form.watch('platformAi.provider')

  return (
    <div className='grid gap-4'>
      <FormField
        name='analysisAi.enabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2'>
            <div>
              <FormLabel>启用知识分析模型</FormLabel>
              <FormDescription>
                供 Worker 分析运行数据与地图，生成带来源的候选知识。共用上方配置的平台模型服务。
              </FormDescription>
            </div>
            <FormControl>
                <Switch
                  aria-label='启用知识分析模型'
                  checked={field.value}
                  disabled={!canWrite}
                  onCheckedChange={(checked) => {
                    if (checked && !provider) {
                      form.setError('platformAi.provider', {
                        message: PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE,
                      })
                      return
                    }
                    field.onChange(checked)
                  }}
                />
            </FormControl>
          </FormItem>
        )}
      />
      <div className='grid gap-4 md:grid-cols-3'>
        <FormField
          name='analysisAi.requestTimeoutMs'
          render={({ field }) => (
            <FormItem>
              <FormLabel>请求超时（ms）</FormLabel>
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
          name='analysisAi.maxOutputTokens'
          render={({ field }) => (
            <FormItem>
              <FormLabel>单次输出 Token 上限</FormLabel>
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
          name='analysisAi.maxConcurrentJobs'
          render={({ field }) => (
            <FormItem>
              <FormLabel>分析作业并发上限</FormLabel>
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
  )
}
