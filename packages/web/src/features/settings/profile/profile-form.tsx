import { useEffect } from 'react'
import { z } from 'zod'
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
    defaultValues: { displayName: user?.displayName ?? '' },
  })

  useEffect(() => {
    form.reset({ displayName: user?.displayName ?? '' })
  }, [form, user?.displayName])

  async function onSubmit(data: ProfileFormValues) {
    try {
      const me = await updateMe(data)
      setUser(toAuthUser(me.account))
      queryClient.setQueryData(['me'], me)
      toast.success('Profile updated')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'Update failed')
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-8'>
        <FormField
          control={form.control}
          name='displayName'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Display name</FormLabel>
              <FormControl>
                <Input autoComplete='name' {...field} />
              </FormControl>
              <FormDescription>
                Shown on the audit log and to other console users.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div>
          <h3 className='text-sm font-medium'>Email</h3>
          <p className='text-muted-foreground mt-1 text-sm'>{user?.email ?? '—'}</p>
          <p className='text-muted-foreground mt-1 text-xs'>
            Email is the local identity subject. An administrator can change it
            from Users.
          </p>
        </div>
        <Button type='submit'>Update profile</Button>
      </form>
    </Form>
  )
}
