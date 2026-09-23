import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasAllPermissions } from '@cairn/shared'
import { TargetMapPage } from '@/features/map/page'
import { useAuthStore } from '@/stores/auth-store'

const mapSearchSchema = z.object({
  view: z.enum(['atlas', 'list']).optional().catch('atlas'),
  pageId: z.string().optional().catch(undefined),
  objectId: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/_authenticated/targets/$targetId/map/')({
  validateSearch: mapSearchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasAllPermissions(user.permissions, ['target:read', 'map:read'])) {
      throw redirect({ to: '/403' })
    }
  },
  component: TargetMapPage,
})
