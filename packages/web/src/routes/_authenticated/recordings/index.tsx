import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { RecordingsPage } from '@/features/recordings'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/recordings/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'workflow:write')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RecordingsPage,
})
