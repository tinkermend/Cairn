import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { SuiteDetailPage } from '@/features/suites/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/suites/$suiteId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'suite:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SuiteDetailPage,
})
