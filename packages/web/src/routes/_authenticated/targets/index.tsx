import { createFileRoute, redirect } from '@tanstack/react-router'
import z from 'zod'
import { hasPermission } from '@cairn/shared'
import { TargetsPage } from '@/features/targets'
import { useAuthStore } from '@/stores/auth-store'

const targetOverviewSearchSchema = z.object({
  q: z.string().trim().max(128).optional().catch(undefined),
  filter: z.enum(['all', 'ready', 'need_login', 'running']).optional().catch(undefined),
  sort: z.enum([
    'created', 'name',
    'system-asc', 'system-desc',
    'readiness-asc', 'readiness-desc',
    'accounts-asc', 'accounts-desc',
    'scenarios-asc', 'scenarios-desc',
    'activity-asc', 'activity-desc',
  ]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  pageSize: z.coerce.number().int().refine((size) => [10, 20, 50].includes(size)).optional().catch(undefined),
  selected: z.string().min(1).max(128).optional().catch(undefined),
  action: z.enum(['create']).optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/targets/')({
  validateSearch: targetOverviewSearchSchema,
  staticData: {
    assistant: {
      routeKey: 'targets.index',
      pageKind: 'target',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'target:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: TargetsPage,
})
