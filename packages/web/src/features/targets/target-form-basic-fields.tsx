import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import {
  AUTH_METHODS,
  CAPTCHA_MODES,
  TARGET_STATUSES,
} from '@cairn/shared'
import { ChevronDown, ShieldAlert } from 'lucide-react'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AUTH_METHOD_LABELS,
  CAPTCHA_MODE_LABELS,
  TARGET_STATUS_LABELS,
} from './labels'
import type { TargetFormValues } from './target-form-schema'
import { TargetFormIdentityFields } from './target-form-identity-fields'

type TargetFormBasicFieldsProps = {
  form: UseFormReturn<TargetFormValues>
  isEdit: boolean
  onAuthMethodChange?: (method: string) => void
}

export function TargetFormBasicFields({
  form,
  isEdit,
  onAuthMethodChange,
}: TargetFormBasicFieldsProps) {
  const [securityOpen, setSecurityOpen] = useState(
    Boolean(form.getValues('sensitiveSelectors')?.trim())
  )

  return (
    <div className='space-y-3.5'>
      <FormField
        control={form.control}
        name='name'
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              名称 <span className='text-destructive font-bold' aria-hidden='true'>*</span>
            </FormLabel>
            <FormControl>
              <Input {...field} placeholder='例如：铁塔视联' />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name='code'
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              编码 <span className='text-label font-normal text-muted-foreground'>（创建后不可改）</span>
            </FormLabel>
            <FormControl>
              <Input
                {...field}
                disabled={isEdit}
                placeholder='tower-preprod'
              />
            </FormControl>
            <FormDescription>
              {isEdit
                ? '创建后不可改。'
                : '小写字母开头的 slug，2–63 字符，创建后不可改。'}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <TargetFormIdentityFields form={form} />

      <FormField
        control={form.control}
        name='entryUrl'
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              入口 URL <span className='text-destructive font-bold' aria-hidden='true'>*</span>
            </FormLabel>
            <FormControl>
              <Input {...field} placeholder='https://example.com/#/home' />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name='loginUrl'
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              登录 URL <span className='text-label font-normal text-muted-foreground'>（可选）</span>
            </FormLabel>
            <FormControl>
              <Input {...field} placeholder='留空则与入口相同' />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name='loginLeaveTimeoutSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              提交后等待离开登录页
              <span className='text-label font-normal text-muted-foreground'>（秒，可选）</span>
            </FormLabel>
            <FormControl>
              <Input {...field} type='number' min={1} step={1} placeholder='留空则用平台默认' />
            </FormControl>
            <FormDescription>
              自动填写提交后，等多久仍停在登录页才判未完成。跳转慢的系统加大；不填用平台配置。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className='grid gap-3 sm:grid-cols-2'>
        <FormField
          control={form.control}
          name='landingSettleMode'
          render={({ field }) => (
            <FormItem>
              <FormLabel>登录后整理</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value='default'>按平台整理</SelectItem>
                  <SelectItem value='off'>不自动整理</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                关掉后，换节点自动登录也不会关欢迎层。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='landingSettleTimeoutSeconds'
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                整理预算
                <span className='text-label font-normal text-muted-foreground'>（秒，可选）</span>
              </FormLabel>
              <FormControl>
                <Input {...field} type='number' min={1} step={1} placeholder='留空则用平台默认' />
              </FormControl>
              <FormDescription>
                覆盖平台整理预算。不填用平台配置。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <div className='grid gap-3 sm:grid-cols-2'>
        <FormField
          control={form.control}
          name='authMethod'
          render={({ field }) => (
            <FormItem>
              <FormLabel>认证方式</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value)
                  onAuthMethodChange?.(value)
                }}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {AUTH_METHODS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {AUTH_METHOD_LABELS[value]}
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
          name='captchaMode'
          render={({ field }) => (
            <FormItem>
              <FormLabel>验证码</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {CAPTCHA_MODES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CAPTCHA_MODE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name='status'
        render={({ field }) => (
          <FormItem>
            <FormLabel>状态</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {TARGET_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {TARGET_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className='rounded-lg border border-border-divider bg-surface-subtle/30'>
        <button
          type='button'
          className='flex w-full items-center justify-between px-3.5 py-2.5 text-left text-label font-medium transition-[background-color] hover:bg-surface-subtle/60'
          onClick={() => setSecurityOpen(!securityOpen)}
          aria-expanded={securityOpen}
        >
          <span className='flex items-center gap-1.5 text-text-secondary'>
            <ShieldAlert className='size-3.5 text-muted-foreground' />
            高级防护设置：敏感区域选择器
          </span>
          <span className='flex items-center gap-1 text-muted-foreground text-label'>
            {securityOpen ? '收起' : '展开'}
            <ChevronDown
              className={`size-3.5 transition-transform ${securityOpen ? 'rotate-180' : ''}`}
            />
          </span>
        </button>

        {securityOpen && (
          <div className='border-t border-border-divider p-3.5 pt-3'>
            <FormField
              control={form.control}
              name='sensitiveSelectors'
              render={({ field }) => (
                <FormItem>
                  <FormLabel className='sr-only'>敏感区域选择器</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder='每行一个 CSS 选择器，例如 input[name=idCard]'
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    截图与录像在这些元素可见时遮罩像素，不改页面值。用于“显示密码”后的明文框、证件号等。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}
      </div>
    </div>
  )
}
