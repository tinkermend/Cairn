import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { RecordingDetailPage } from '@/features/recordings/detail'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/recordings/$recordingId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'workflow:write')) {
      throw redirect({ to: '/403' })
    }
  },
  component: RecordingDetailPage,
})
