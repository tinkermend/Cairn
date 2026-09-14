import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { entityIdSchema, hasPermission } from '@cairn/shared'
import { ScenarioDetailPage } from '@/features/scenarios/detail'
import { useAuthStore } from '@/stores/auth-store'

const searchSchema = z.object({
  runId: entityIdSchema.optional().catch(undefined),
  import: entityIdSchema.optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/scenarios/$scenarioId/')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'workflow:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: ScenarioDetailPage,
})
