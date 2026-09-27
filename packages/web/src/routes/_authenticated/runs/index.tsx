import { createFileRoute, redirect } from '@tanstack/react-router'
import { entityIdSchema, evidenceSearchViewSchema, hasPermission, runStatusSchema } from '@cairn/shared'
import { z } from 'zod'
import { RunsPage } from '@/features/runs'
import { evidencePageSearchSchema } from '@/features/evidence'
import { useAuthStore } from '@/stores/auth-store'

export const runsPageSearchSchema = evidencePageSearchSchema.extend({
  view: z.enum(['runs', 'suites', 'reports', 'materials', 'retention']).optional().catch('runs'),
  evidenceView: evidenceSearchViewSchema.optional().catch(undefined),
  targetId: entityIdSchema.optional().catch(undefined),
  search: z.string().optional().catch(undefined),
  status: runStatusSchema.optional().catch(undefined),
  hasReport: z.coerce.boolean().optional().catch(undefined),
})

export type RunsPageSearch = z.infer<typeof runsPageSearchSchema>

export const Route = createFileRoute('/_authenticated/runs/')({
  validateSearch: runsPageSearchSchema,
  staticData: {
    assistant: {
      routeKey: 'runs.index',
      pageKind: 'run',
    },
  },
  beforeLoad: ({ search }) => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
    if (search.view === 'reports' && !hasPermission(user.permissions, 'report:read')) {
      throw redirect({ to: '/403' })
    }
    if (search.view === 'retention' && !hasPermission(user.permissions, 'run:delete')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RunsPage,
})
