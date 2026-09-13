import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { PlatformConfigPage } from '@/features/platform-config'

export const Route = createFileRoute('/_authenticated/platform-config/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'platform-config:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: PlatformConfigPage,
})
