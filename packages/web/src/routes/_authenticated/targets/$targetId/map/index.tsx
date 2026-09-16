import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasAllPermissions } from '@cairn/shared'
import { TargetMapPage } from '@/features/map/page'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/targets/$targetId/map/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasAllPermissions(user.permissions, ['target:read', 'map:read'])) {
      throw redirect({ to: '/403' })
    }
  },
  component: TargetMapPage,
})
