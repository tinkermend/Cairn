import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { PlatformConfigPage } from '@/features/platform-config'

export const Route = createFileRoute('/_authenticated/platform-config/')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'alerting') throw redirect({ to: '/notifications', search: { tab: 'alerts' } })
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'platform-config:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: PlatformConfigPage,
})
