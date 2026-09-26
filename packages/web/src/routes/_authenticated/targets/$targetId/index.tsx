import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { TargetDetailPage } from '@/features/targets/detail'
import { useAuthStore } from '@/stores/auth-store'

const targetSearchSchema = z.object({
  action: z.enum(['create-account']).optional().catch(undefined),
  prefill_username: z.string().optional().catch(undefined),
  tab: z.enum(['accounts', 'scenarios', 'auth-profile', 'access-policy', 'ai-sources']).optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/targets/$targetId/')({
  validateSearch: targetSearchSchema,
  staticData: {
    assistant: {
      routeKey: 'targets.$targetId',
      pageKind: 'target',
      primaryObject: { kind: 'target', idParam: 'targetId' },
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'target:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: TargetDetailPage,
})
