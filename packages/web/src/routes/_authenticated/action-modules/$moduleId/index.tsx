import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { ActionModuleDetailPage } from '@/features/action-modules/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/action-modules/$moduleId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'module:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: function ActionModuleDetailRoute() {
    const { moduleId } = Route.useParams()
    return <ActionModuleDetailPage moduleId={moduleId} />
  },
})
