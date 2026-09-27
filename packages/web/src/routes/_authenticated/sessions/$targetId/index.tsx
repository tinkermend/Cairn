import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/sessions/$targetId/')({
  staticData: {
    assistant: {
      routeKey: 'sessions.$targetId',
      pageKind: 'session',
      primaryObject: { kind: 'target', idParam: 'targetId' },
    },
  },
  beforeLoad: ({ params }) => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'session:read')) {
      throw redirect({ to: '/403' })
    }
    throw redirect({
      to: '/sessions',
      search: { view: 'systems', targetId: params.targetId },
      replace: true,
    })
  },
  component: () => null,
})
