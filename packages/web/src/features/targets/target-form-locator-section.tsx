import { useWatch, type UseFormReturn } from 'react-hook-form'
import {
  LOGIN_LOCATOR_BY,
} from '@cairn/shared'
import { ChevronDown, Crosshair, Info } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CAPTCHA_MODE_LABELS,
  LOGIN_FIELD_ROLE_LABELS,
  LOGIN_LOCATOR_BY_LABELS,
} from './labels'
import {
  countConfiguredLocators,
  type TargetFormValues,
} from './target-form-schema'

type TargetFormLocatorSectionProps = {
  form: UseFormReturn<TargetFormValues>
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TargetFormLocatorSection({
  form,
  open,
  onOpenChange,
}: TargetFormLocatorSectionProps) {
  const authMethod = useWatch({ control: form.control, name: 'authMethod' })
  const captchaMode = useWatch({ control: form.control, name: 'captchaMode' })
  const values = form.getValues()
  const configuredCount = countConfiguredLocators(values)

  return (
    <section className='rounded-lg border border-border-divider bg-surface-subtle/30'>
      <button
        type='button'
        className='flex w-full items-center justify-between p-4 text-left transition-[background-color] hover:bg-surface-subtle/60'
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <div className='flex items-center gap-2.5'>
          <Crosshair className='size-4 text-primary' />
          <span className='text-body font-medium text-text-primary'>
            登录框定位（可选）
          </span>
        </div>

        <div className='flex items-center gap-2'>
          {configuredCount > 0 ? (
            <span className='inline-flex items-center rounded-sm bg-primary-100 px-1.5 py-0.5 text-label font-medium text-primary-700'>
              已配 {configuredCount} 项
            </span>
          ) : (
            <span className='inline-flex items-center rounded-sm bg-surface-subtle px-1.5 py-0.5 text-label text-muted-foreground'>
              自动探测
            </span>
          )}
          <span className='flex items-center gap-1 text-label text-muted-foreground'>
            {open ? '收起' : '展开'}
            <ChevronDown
              className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
            />
          </span>
        </div>
      </button>

      {open && (
        <div className='space-y-4 border-t border-border-divider p-4 pt-3'>
          {captchaMode === 'image' || captchaMode === 'slider' ? (
            <Alert>
              <AlertDescription>
                开跑前与会话维护会由 Worker 进程内自动识别
                {CAPTCHA_MODE_LABELS[captchaMode]}
                ；预算耗尽后降级到远程画板人工接管。未填定位时按内置指纹库探测。
              </AlertDescription>
            </Alert>
          ) : captchaMode !== 'none' ? (
            <Alert variant='warning'>
              <AlertDescription>
                已声明{CAPTCHA_MODE_LABELS[captchaMode]}
                ，自动续登不能作为默认承诺。
              </AlertDescription>
            </Alert>
          ) : null}

          {authMethod === 'manual' ? (
            <p className='text-body text-muted-foreground'>
              仅手工登录时定位仅作备用。
            </p>
          ) : null}

          <div className='flex items-start gap-2 rounded-md bg-surface-card p-2.5 border border-border-divider text-label text-muted-foreground'>
            <Info className='size-4 shrink-0 text-primary mt-0.5' />
            <span>
              知道输入框的 id 或 name 就填；留空则以后试填时按常见字段猜测。保存不会打开目标页面。
            </span>
          </div>

          <div className='space-y-3 pt-1'>
            <LocatorRow
              form={form}
              role='username'
              placeholder='username'
            />
            <LocatorRow
              form={form}
              role='password'
              placeholder='password'
            />
            <LocatorRow
              form={form}
              role='submit'
              placeholder='login'
            />

            {captchaMode === 'image' && (
              <>
                <LocatorRow
                  form={form}
                  role='captchaImage'
                  placeholder='img.captcha'
                />
                <LocatorRow
                  form={form}
                  role='captchaInput'
                  placeholder='input[name="captcha"]'
                />
              </>
            )}

            {captchaMode === 'slider' && (
              <>
                <LocatorRow
                  form={form}
                  role='captchaKnob'
                  placeholder='.slider-knob'
                />
                <LocatorRow
                  form={form}
                  role='captchaBg'
                  placeholder='.slider-bg'
                />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function LocatorRow({
  form,
  role,
  placeholder,
}: {
  form: UseFormReturn<TargetFormValues>
  role: keyof typeof LOGIN_FIELD_ROLE_LABELS
  placeholder: string
}) {
  const byName = `${role}By` as const
  const valueName = `${role}Value` as const

  return (
    <div className='space-y-1.5'>
      <FormLabel className='text-label text-text-secondary'>
        {LOGIN_FIELD_ROLE_LABELS[role]}
      </FormLabel>
      <div className='grid grid-cols-[7.5rem_1fr] gap-2'>
        <FormField
          control={form.control}
          name={byName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className='sr-only'>
                {LOGIN_FIELD_ROLE_LABELS[role]}定位方式
              </FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {LOGIN_LOCATOR_BY.map((value) => (
                    <SelectItem key={value} value={value}>
                      {LOGIN_LOCATOR_BY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={valueName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className='sr-only'>
                {LOGIN_FIELD_ROLE_LABELS[role]}定位值
              </FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder={placeholder}
                  className='font-mono text-small'
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
