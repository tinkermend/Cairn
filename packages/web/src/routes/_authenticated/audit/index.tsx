import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { AuditPage } from '@/features/audit'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/audit/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (
      !user ||
      !(
        hasPermission(user.permissions, 'audit:read') ||
        hasPermission(user.permissions, 'audit:login')
      )
    ) {
      throw redirect({ to: '/403' })
    }
  },
  component: AuditPage,
})
