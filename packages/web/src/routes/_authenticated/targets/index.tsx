import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { TargetsPage } from '@/features/targets'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/targets/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'target:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: TargetsPage,
})
