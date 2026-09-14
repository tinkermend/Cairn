import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { AuditPage } from '@/features/audit'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/audit/operations')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'audit:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: () => <AuditPage pane='operations' />,
})
