import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { hasPermission } from '@cairn/shared'
import { IncidentDetailPage } from '@/features/maintenance/detail'
import { useAuthStore } from '@/stores/auth-store'

const searchSchema = z.object({
  tab: z.enum(['overview', 'impact', 'evidence', 'repairs']).optional().catch('overview'),
})

export const Route = createFileRoute('/_authenticated/maintenance/incidents/$incidentId/')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'reliability:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: IncidentDetailPage,
})
