import { createFileRoute, redirect } from '@tanstack/react-router'
import { entityIdSchema, hasPermission, runStatusSchema } from '@cairn/shared'
import { z } from 'zod'
import { RunsPage } from '@/features/runs'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/runs/')({
  validateSearch: z.object({
    targetId: entityIdSchema.optional().catch(undefined),
    search: z.string().optional().catch(undefined),
    status: runStatusSchema.optional().catch(undefined),
  }),
  staticData: {
    assistant: {
      routeKey: 'runs.index',
      pageKind: 'run',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RunsPage,
})
