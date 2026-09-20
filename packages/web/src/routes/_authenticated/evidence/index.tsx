import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { EvidencePage } from '@/features/evidence'
import { evidencePageSearchSchema } from '@/features/evidence/search-state'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/evidence/')({
  validateSearch: evidencePageSearchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'run:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: EvidencePage,
})
