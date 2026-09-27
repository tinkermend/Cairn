import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import { z } from 'zod'
import { SessionsPage } from '@/features/sessions'
import { useAuthStore } from '@/stores/auth-store'

const sessionsSearchSchema = z.object({
  view: z.enum(['stream', 'systems']).optional(),
  targetId: z.string().optional(),
})

export type SessionsSearch = z.infer<typeof sessionsSearchSchema>

export const Route = createFileRoute('/_authenticated/sessions/')({
  validateSearch: (search) => sessionsSearchSchema.parse(search),
  staticData: {
    assistant: {
      routeKey: 'sessions.index',
      pageKind: 'session',
    },
  },
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'session:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: SessionsPage,
})
