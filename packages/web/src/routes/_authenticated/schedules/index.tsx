import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { SchedulesPage } from '@/features/schedules/page'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/schedules/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'schedule:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SchedulesPage,
})
