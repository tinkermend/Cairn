import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { DatasetsPage } from '@/features/datasets'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/datasets/')({
  staticData: {
    assistant: {
      routeKey: 'datasets.index',
      pageKind: 'dataset',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'dataset:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: DatasetsPage,
})
