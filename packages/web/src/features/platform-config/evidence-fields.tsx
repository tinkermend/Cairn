import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CAPTURE_MODE_LABELS } from './labels'
import {
  FieldGrid,
  NumberSetting,
  SettingLabel,
  SettingSection,
} from './setting-layout'

export function EvidenceFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='space-y-6'>
      <SettingSection title='采集'>
        <FieldGrid>
          <CaptureField
            name='evidence.screenshot'
            label='截图采集'
            canWrite={canWrite}
          />
          <VideoCaptureField canWrite={canWrite} />
          <CaptureField
            name='evidence.trace'
            label='Trace 采集'
            canWrite={canWrite}
            help='调试轨迹，用于当场排错，不是业务结果。'
          />
        </FieldGrid>
      </SettingSection>
      <SettingSection
        title='保留'
        hint='平台要求必须留下的证据，不能在这里关掉。'
      >
        <FieldGrid>
          <NumberSetting
            name='evidence.retainDays.video'
            label='录像保留'
            unit='天'
            canWrite={canWrite}
            help='录像占用比截图大。到期后，步骤截图仍然保留。'
          />
          <NumberSetting
            name='evidence.retainDays.screenshot'
            label='截图保留'
            unit='天'
            canWrite={canWrite}
          />
          <NumberSetting
            name='evidence.retainDays.trace'
            label='一般 Trace 保留'
            unit='天'
            canWrite={canWrite}
          />
          <NumberSetting
            name='evidence.retainDays.debugTrace'
            label='调试 Trace 保留'
            unit='天'
            canWrite={canWrite}
            help='调试轨迹。采集方式选「始终」时使用这段时间，方便当场排错。始终保留也不等于永不删除。'
          />
        </FieldGrid>
      </SettingSection>
    </div>
  )
}

function VideoCaptureField({ canWrite }: { canWrite: boolean }) {
  return (
    <FormField
      name='evidence.video'
      render={({ field }) => (
        <FormItem>
          <SettingLabel
            label='录像采集'
            help='一次运行保留一条录像，成功和失败都留。'
          />
          <Select
            disabled={!canWrite}
            value={field.value ?? ''}
            onValueChange={field.onChange}
          >
            <FormControl>
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {(['off', 'always'] as const).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {CAPTURE_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function CaptureField({
  name,
  label,
  canWrite,
  help,
}: {
  name: 'evidence.screenshot' | 'evidence.trace'
  label: string
  canWrite: boolean
  help?: string
}) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <SettingLabel label={label} help={help} />
          <Select
            disabled={!canWrite}
            value={field.value ?? ''}
            onValueChange={field.onChange}
          >
            <FormControl>
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {(['off', 'on_failure', 'always'] as const).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {CAPTURE_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
