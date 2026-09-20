import { createFileRoute, redirect } from '@tanstack/react-router'
import { CredentialsPage } from '@/features/credentials'
import { useAuthStore } from '@/stores/auth-store'
import { can } from '@/lib/rbac'

export const Route = createFileRoute('/_authenticated/credentials/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!can(user, 'credential:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: CredentialsPage,
})
