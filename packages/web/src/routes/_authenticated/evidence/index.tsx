import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { evidencePageSearchSchema } from '@/features/evidence/search-state'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/evidence/')({
  validateSearch: evidencePageSearchSchema,
  beforeLoad: ({ search }) => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
    const { tab, view: evidenceView, ...rest } = search
    const viewMap: Record<string, 'runs' | 'reports' | 'materials' | 'retention'> = {
      runs: 'runs',
      reports: 'reports',
      search: 'materials',
      retention: 'retention',
    }
    const view = tab ? viewMap[tab] ?? 'runs' : evidenceView ? 'materials' : 'runs'
    throw redirect({
      to: '/runs',
      search: {
        ...rest,
        view,
        evidenceView,
      },
      replace: true,
    })
  },
  component: () => null,
})
