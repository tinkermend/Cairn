import { createFileRoute, redirect } from '@tanstack/react-router'
import { entityIdSchema, hasPermission } from '@cairn/shared'
import { z } from 'zod'
import { ScenariosPage } from '@/features/scenarios'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/scenarios/')({
  validateSearch: z.object({ targetId: entityIdSchema.optional().catch(undefined) }),
  staticData: {
    assistant: {
      routeKey: 'scenarios.index',
      pageKind: 'scenario',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'workflow:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: ScenariosPage,
})
