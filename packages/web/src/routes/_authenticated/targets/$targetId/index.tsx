import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { TargetDetailPage } from '@/features/targets/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/targets/$targetId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'target:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: TargetDetailPage,
})
