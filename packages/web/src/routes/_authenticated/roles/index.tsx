import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { RolesPage } from '@/features/rbac'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/roles/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'role:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RolesPage,
})
