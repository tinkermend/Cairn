import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { entityIdSchema, hasPermission } from '@cairn/shared'
import { ScenarioDetailPage } from '@/features/scenarios/detail'
import { useAuthStore } from '@/stores/auth-store'

const searchSchema = z.object({
  editor: z.enum(['flowgram']).optional().catch(undefined),
  runId: entityIdSchema.optional().catch(undefined),
  import: entityIdSchema.optional().catch(undefined),
  action: z.enum(['inspect-step']).optional().catch(undefined),
  step_id: entityIdSchema.optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/scenarios/$scenarioId/')({
  validateSearch: searchSchema,
  staticData: {
    assistant: {
      routeKey: 'scenarios.$scenarioId',
      pageKind: 'studio',
      primaryObject: { kind: 'scenario', idParam: 'scenarioId' },
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'workflow:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: ScenarioDetailPage,
})
