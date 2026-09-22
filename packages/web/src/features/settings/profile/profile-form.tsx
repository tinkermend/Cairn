import { useEffect } from 'react'
import { type z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { updateMeBodySchema } from '@cairn/shared'
import { updateMe } from '@/lib/auth-api'
import { toAuthUser } from '@/lib/auth'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { AvatarPicker } from '@/components/avatar-picker'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'

type ProfileFormValues = z.infer<typeof updateMeBodySchema>

export function ProfileForm() {
  const user = useAuthStore((s) => s.auth.user)
  const setUser = useAuthStore((s) => s.auth.setUser)
  const queryClient = useQueryClient()
  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(updateMeBodySchema),
    defaultValues: {
      displayName: user?.displayName ?? '',
      avatar: user?.avatar ?? '',
    },
  })

  useEffect(() => {
    form.reset({
      displayName: user?.displayName ?? '',
      avatar: user?.avatar ?? '',
    })
  }, [form, user?.displayName, user?.avatar])

  async function onSubmit(data: ProfileFormValues) {
    try {
      const me = await updateMe({
        displayName: data.displayName,
        avatar: data.avatar || null,
      })
      setUser(toAuthUser(me.account))
      queryClient.setQueryData(['me'], me)
      toast.success('个人资料已更新')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '更新失败')
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-8'>
        <FormField
          control={form.control}
          name='avatar'
          render={({ field }) => (
            <FormItem>
              <FormLabel>用户头像</FormLabel>
              <FormControl>
                <AvatarPicker
                  value={field.value}
                  onChange={field.onChange}
                  displayName={form.watch('displayName')}
                />
              </FormControl>
              <FormDescription>
                个性化机器人头像，将显示在侧边栏、用户列表及操作记录中。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='displayName'
          render={({ field }) => (
            <FormItem>
              <FormLabel>显示名称</FormLabel>
              <FormControl>
                <Input autoComplete='name' {...field} />
              </FormControl>
              <FormDescription>
                会显示在审计记录和其他控制台用户面前。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div>
          <h3 className='text-body font-medium'>账号</h3>
          <p className='text-muted-foreground mt-1 text-body'>{user?.email ?? '—'}</p>
          <p className='text-muted-foreground mt-1 text-label'>
            账号是本地登录名。管理员可在用户页修改。
          </p>
        </div>
        <Button type='submit'>保存个人资料</Button>
      </form>
    </Form>
  )
}
