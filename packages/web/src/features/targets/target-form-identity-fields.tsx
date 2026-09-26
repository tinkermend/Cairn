import type { UseFormReturn } from 'react-hook-form'
import {
  DEFAULT_TARGET_ACCENT_KEY,
  DEFAULT_TARGET_ICON_KEY,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  TargetIdentityIcon,
  TARGET_ACCENT_OPTIONS,
  TARGET_ICON_OPTIONS,
} from './target-identity-icon'
import type { TargetFormValues } from './target-form-schema'

export function TargetFormIdentityFields({ form }: { form: UseFormReturn<TargetFormValues> }) {
  const iconKey = form.watch('iconKey')
  const accentKey = form.watch('accentKey')
  const reset = () => {
    form.setValue('iconKey', DEFAULT_TARGET_ICON_KEY, { shouldDirty: true })
    form.setValue('accentKey', DEFAULT_TARGET_ACCENT_KEY, { shouldDirty: true })
  }

  return (
    <section className='space-y-3 rounded-lg border border-border-divider bg-surface-subtle/30 p-3' aria-label='系统外观'>
      <div className='flex items-center justify-between gap-3'>
        <div>
          <h5 className='text-label font-semibold text-text-primary'>系统外观</h5>
          <p className='text-label text-muted-foreground'>图标和颜色用于辨认系统，不代表运行状态。</p>
        </div>
        <TargetIdentityIcon iconKey={iconKey} accentKey={accentKey} size='lg' />
      </div>

      <fieldset className='space-y-1.5'>
        <legend className='text-label font-medium text-text-primary'>图标</legend>
        <div className='flex flex-wrap gap-2' role='group' aria-label='选择系统图标'>
          {TARGET_ICON_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              type='button'
              aria-label={`${label}图标`}
              aria-pressed={iconKey === key}
              title={label}
              onClick={() => form.setValue('iconKey', key, { shouldDirty: true })}
              className='rounded-xl border border-border-divider p-0.5 transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-ring'
            >
              <TargetIdentityIcon iconKey={key} accentKey={accentKey} size='sm' />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className='space-y-1.5'>
        <legend className='text-label font-medium text-text-primary'>身份色</legend>
        <div className='flex flex-wrap gap-2' role='group' aria-label='选择系统身份色'>
          {TARGET_ACCENT_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              type='button'
              aria-label={`${label}身份色`}
              aria-pressed={accentKey === key}
              title={label}
              onClick={() => form.setValue('accentKey', key, { shouldDirty: true })}
              className='rounded-xl border border-border-divider p-0.5 transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-ring'
            >
              <TargetIdentityIcon iconKey={iconKey} accentKey={key} size='sm' />
            </button>
          ))}
        </div>
      </fieldset>

      <Button type='button' variant='ghost' size='sm' onClick={reset} disabled={iconKey === DEFAULT_TARGET_ICON_KEY && accentKey === DEFAULT_TARGET_ACCENT_KEY}>
        恢复默认外观
      </Button>
    </section>
  )
}
