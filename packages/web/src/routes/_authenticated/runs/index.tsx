import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { RunsPage } from '@/features/runs'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/runs/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RunsPage,
})
