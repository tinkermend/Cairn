import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { OutboundPage } from '@/features/outbound'

export const Route = createFileRoute('/_authenticated/outbound/')({
  validateSearch: (
    search: Record<string, unknown>
  ): {
    tab?: string
    scenarioId?: string
    runId?: string
    alertId?: string
  } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    scenarioId:
      typeof search.scenarioId === 'string' ? search.scenarioId : undefined,
    runId: typeof search.runId === 'string' ? search.runId : undefined,
    alertId: typeof search.alertId === 'string' ? search.alertId : undefined,
  }),
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (
      !user ||
      !['outbound:read', 'notification:read', 'platform-config:read', 'workflow:write'].some(
        (p) => hasPermission(user.permissions, p)
      )
    )
      throw redirect({ to: '/403' })
  },
  component: OutboundPage,
})
