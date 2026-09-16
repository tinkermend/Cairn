import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { SessionDetailPage } from '@/features/sessions/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/sessions/$targetId/$accountId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'session:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SessionDetailPage,
})
