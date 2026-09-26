import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { SessionSystemPage } from '@/features/sessions/system'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/sessions/$targetId/')({
  staticData: {
    assistant: {
      routeKey: 'sessions.$targetId',
      pageKind: 'session',
      primaryObject: { kind: 'target', idParam: 'targetId' },
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'session:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SessionSystemPage,
})
