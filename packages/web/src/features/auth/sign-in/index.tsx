import { useSearch } from '@tanstack/react-router'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })

  return (
    <AuthLayout>
      <div className='mb-9 space-y-3'>
        <h1 className='text-page font-semibold'>登录识途</h1>
        <p className='text-body text-muted-foreground'>
          欢迎回来，请使用控制台账号登录。
        </p>
      </div>
      <UserAuthForm redirectTo={redirect} />
    </AuthLayout>
  )
}
