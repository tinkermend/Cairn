import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { MonitoringPage } from '@/features/monitoring'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/monitoring/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'monitor:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: MonitoringPage,
})
