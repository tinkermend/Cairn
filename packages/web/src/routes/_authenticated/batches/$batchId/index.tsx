import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { BatchDetailPage } from '@/features/batches/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/batches/$batchId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'batch:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: function RouteComponent() {
    const { batchId } = Route.useParams()
    return <BatchDetailPage batchId={batchId} />
  },
})
