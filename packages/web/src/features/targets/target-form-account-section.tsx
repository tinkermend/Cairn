import { useWatch, type UseFormReturn } from 'react-hook-form'
import { ChevronDown, UserPlus } from 'lucide-react'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'
import { ValidityFields } from '@/features/credentials/validity-fields'
import type { TargetFormValues } from './target-form-schema'

type TargetFormAccountSectionProps = {
  form: UseFormReturn<TargetFormValues>
  open: boolean
  onOpenChange: (open: boolean) => void
  allowCredential: boolean
}

export function TargetFormAccountSection({
  form,
  open,
  onOpenChange,
  allowCredential,
}: TargetFormAccountSectionProps) {
  const authMethod = useWatch({ control: form.control, name: 'authMethod' })
  const accountUsername = useWatch({ control: form.control, name: 'accountUsername' })
  const accountDisplayName = useWatch({ control: form.control, name: 'accountDisplayName' })
  const accountPassword = useWatch({ control: form.control, name: 'accountPassword' })

  const isConfigured = Boolean(
    accountUsername?.trim() || accountDisplayName?.trim() || accountPassword?.trim()
  )

  return (
    <section className='rounded-lg border border-border-divider bg-surface-subtle/30'>
      <button
        type='button'
        className='flex w-full items-center justify-between p-4 text-left transition-[background-color] hover:bg-surface-subtle/60'
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <div className='flex items-center gap-2.5'>
          <UserPlus className='size-4 text-primary' />
          <span className='text-body font-medium text-text-primary'>
            第一个目标账号
          </span>
          <span className='text-label text-muted-foreground'>
            （可选）
          </span>
        </div>

        <div className='flex items-center gap-2'>
          {isConfigured ? (
            <span className='inline-flex items-center rounded-sm bg-primary-100 px-1.5 py-0.5 text-label font-medium text-primary-700'>
              已填：{accountUsername?.trim() || accountDisplayName?.trim() || '凭据'}
            </span>
          ) : (
            <span className='inline-flex items-center rounded-sm bg-surface-subtle px-1.5 py-0.5 text-label text-muted-foreground'>
              未设置
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
          {authMethod === 'manual' ? (
            <p className='text-body text-muted-foreground'>
              仅手工登录时仍可登记备用号，不会自动使用。
            </p>
          ) : null}

          <div className='grid gap-4 sm:grid-cols-2'>
            <FormField
              control={form.control}
              name='accountDisplayName'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    显示名 <span className='text-destructive font-bold' aria-hidden='true'>*</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='演示账号' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='accountUsername'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    登录名 <span className='text-destructive font-bold' aria-hidden='true'>*</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} placeholder='demo' />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {allowCredential ? <FormField
            control={form.control}
            name='accountPassword'
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  密码 <span className='text-label font-normal text-muted-foreground'>（建议填写，亦可稍后补齐）</span>
                </FormLabel>
                <FormControl>
                  <PasswordInput
                    {...field}
                    placeholder='建议填写，也可稍后补齐'
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          /> : <p className='text-label text-muted-foreground'>可先登记账号。密码由具备全范围凭据权限的成员补齐。</p>}

          {allowCredential && accountPassword?.trim() !== '' ? (
            <div className='pt-1'>
              <ValidityFields control={form.control} required />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
