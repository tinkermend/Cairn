import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import { toAuthUser } from '@/lib/auth'
import { login } from '@/lib/auth-api'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'

const formSchema = z.object({
  email: z.email('请输入账号。'),
  password: z.string().min(1, '请输入密码。'),
})

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({
  className,
  redirectTo,
  ...props
}: UserAuthFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { auth } = useAuthStore()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    setSubmitError(undefined)
    setIsLoading(true)
    try {
      const session = await login(data)
      auth.setUser(toAuthUser(session.account))
      auth.setAccessToken(session.accessToken)
      queryClient.setQueryData(['me'], { account: session.account })
      toast.success(`欢迎回来，${session.account.displayName}`)
      navigate({ to: redirectTo || '/', replace: true })
    } catch (error) {
      setSubmitError(
        error instanceof ApiRequestError
          ? error.message
          : '登录失败，请稍后重试。'
      )
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('grid gap-5', className)}
        noValidate
        {...props}
      >
        <FormField
          control={form.control}
          name='email'
          render={({ field }) => (
            <FormItem>
              <FormLabel>账号</FormLabel>
              <FormControl>
                <Input
                  type='email'
                  inputMode='email'
                  placeholder='请输入账号'
                  autoComplete='username'
                  className='h-12 rounded-lg px-4 text-section md:text-body'
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem>
              <FormLabel>密码</FormLabel>
              <FormControl>
                <PasswordInput
                  placeholder='请输入密码'
                  autoComplete='current-password'
                  inputClassName='h-12 rounded-lg px-4 pe-12 text-section md:text-body'
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {submitError ? (
          <Alert variant='destructive' className='py-2.5'>
            <CircleAlert aria-hidden='true' />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          type='submit'
          className='mt-1 h-12 w-full rounded-lg text-[15px] shadow-action'
          loading={isLoading}
        >
          {isLoading ? '正在登录…' : '登录'}
        </Button>
      </form>
    </Form>
  )
}
