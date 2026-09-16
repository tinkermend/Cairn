import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { ActionModulesPage } from '@/features/action-modules'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/action-modules/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'module:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: ActionModulesPage,
})
