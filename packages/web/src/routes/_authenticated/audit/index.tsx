import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/audit/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (user && hasPermission(user.permissions, 'audit:read')) {
      throw redirect({ to: '/audit/operations' })
    }
    if (user && hasPermission(user.permissions, 'audit:login')) {
      throw redirect({ to: '/audit/logins' })
    }
    throw redirect({ to: '/403' })
  },
  component: () => null,
})
