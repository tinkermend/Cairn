import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { Settings } from '@/features/settings'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/settings')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'settings:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: Settings,
})
