import { useSearch } from '@tanstack/react-router'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })

  return (
    <AuthLayout>
      <Card className='relative w-full gap-0 overflow-hidden border-primary/15 bg-card py-0 shadow-tech-panel'>
        <div
          aria-hidden='true'
          className='absolute inset-x-16 top-0 h-px bg-primary/70'
        />
        <CardHeader className='px-7 pt-9 pb-7 text-center sm:px-10'>
          <h1 className='text-page font-semibold'>登录识途</h1>
        </CardHeader>
        <CardContent className='px-7 pb-10 sm:px-10'>
          <UserAuthForm redirectTo={redirect} />
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
