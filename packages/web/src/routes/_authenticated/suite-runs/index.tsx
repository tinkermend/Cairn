import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { SuiteRunsPage } from '@/features/suite-runs'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/suite-runs/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'suite:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SuiteRunsPage,
})
