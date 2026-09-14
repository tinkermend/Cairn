import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { ServicesPage } from '@/features/services'

export const Route = createFileRoute('/_authenticated/services/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'service:read'))
      throw redirect({ to: '/403' })
  },
  component: ServicesPage,
})
