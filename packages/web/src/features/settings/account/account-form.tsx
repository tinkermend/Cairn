import { z } from 'zod'
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
      toast.success('Password updated')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'Update failed')
    }
  }

  return (
    <div className='space-y-8'>
      <div>
        <h3 className='text-sm font-medium'>Signed in as</h3>
        <p className='text-muted-foreground mt-1 text-sm'>
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
                <FormLabel>Current password</FormLabel>
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
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete='new-password' {...field} />
                </FormControl>
                <FormDescription>At least 8 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type='submit'>Change password</Button>
        </form>
      </Form>
    </div>
  )
}
