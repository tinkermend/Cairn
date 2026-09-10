import { type z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { changePasswordBodySchema } from '@cairn/shared'
import { changePassword } from '@/lib/auth-api'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { PasswordInput } from '@/components/password-input'

type PasswordForm = z.infer<typeof changePasswordBodySchema>

export function AccountForm() {
  const user = useAuthStore((s) => s.auth.user)
  const form = useForm<PasswordForm>({
    resolver: zodResolver(changePasswordBodySchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  })

  async function onSubmit(data: PasswordForm) {
    try {
      await changePassword(data)
      form.reset()
      toast.success('密码已更新')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '更新失败')
    }
  }

  return (
    <div className='space-y-8'>
      <div>
        <h3 className='text-body font-medium'>当前登录</h3>
        <p className='text-muted-foreground mt-1 text-body'>
          {user?.displayName}
          {user?.email ? ` · ${user.email}` : ''}
        </p>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-6'>
          <FormField
            control={form.control}
            name='currentPassword'
            render={({ field }) => (
              <FormItem>
                <FormLabel>当前密码</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete='current-password' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='newPassword'
            render={({ field }) => (
              <FormItem>
                <FormLabel>新密码</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete='new-password' {...field} />
                </FormControl>
                <FormDescription>至少 8 位。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type='submit'>修改密码</Button>
        </form>
      </Form>
    </div>
  )
}
