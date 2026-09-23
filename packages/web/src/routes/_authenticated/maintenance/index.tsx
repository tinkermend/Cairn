import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { hasPermission } from '@cairn/shared'
import { MaintenancePage } from '@/features/maintenance'
import { useAuthStore } from '@/stores/auth-store'

const searchSchema = z.object({
  view: z.enum(['incidents', 'assets']).optional().catch('incidents'),
  targetId: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  severity: z.string().optional().catch(undefined),
  search: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/maintenance/')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'reliability:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: MaintenancePage,
})
