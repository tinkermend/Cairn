import { useFormContext } from 'react-hook-form'
import {
  PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE,
  type PlatformConfigDocument,
} from '@cairn/shared'
import { FormField } from '@/components/ui/form'
import {
  FieldGrid,
  NumberSetting,
  SwitchGrid,
  SwitchRow,
} from './setting-layout'

export function AnalysisAiFields({ canWrite }: { canWrite: boolean }) {
  const form = useFormContext<PlatformConfigDocument>()
  const provider = form.watch('platformAi.provider')

  return (
    <div className='space-y-4'>
      <SwitchGrid>
        <FormField
          name='analysisAi.enabled'
          render={({ field }) => (
            <SwitchRow
              label='启用知识分析模型'
              help='使用上方配置的平台模型，从运行记录和知识地图整理待确认的知识，并保留来源。'
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
          )}
        />
      </SwitchGrid>
      <FieldGrid columns={3}>
        <NumberSetting
          name='analysisAi.requestTimeoutMs'
          label='请求超时'
          unit='ms'
          canWrite={canWrite}
        />
        <NumberSetting
          name='analysisAi.maxOutputTokens'
          label='单次输出 Token 上限'
          canWrite={canWrite}
        />
        <NumberSetting
          name='analysisAi.maxConcurrentJobs'
          label='分析作业并发上限'
          canWrite={canWrite}
        />
      </FieldGrid>
    </div>
  )
}
