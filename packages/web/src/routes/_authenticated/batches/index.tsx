import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { BatchesPage } from '@/features/batches'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/batches/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'batch:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: BatchesPage,
})
