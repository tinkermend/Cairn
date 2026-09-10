import z from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { ACCOUNT_STATUS, hasPermission } from '@cairn/shared'
import { Users } from '@/features/users'
import { useAuthStore } from '@/stores/auth-store'

const usersSearchSchema = z.object({
  page: z.number().optional().catch(1),
  pageSize: z.number().optional().catch(10),
  status: z.array(z.enum(ACCOUNT_STATUS)).optional().catch([]),
  role: z.array(z.string()).optional().catch([]),
  displayName: z.string().optional().catch(''),
})

export const Route = createFileRoute('/_authenticated/users/')({
  validateSearch: usersSearchSchema,
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !hasPermission(user.permissions, 'account:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: Users,
})
