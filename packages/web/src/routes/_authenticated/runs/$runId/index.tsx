import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { hasPermission } from '@cairn/shared'
import { RunDetailPage } from '@/features/runs/detail'
import { useAuthStore } from '@/stores/auth-store'

const searchSchema = z.object({
  invocation: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/runs/$runId/')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RunDetailPage,
})
