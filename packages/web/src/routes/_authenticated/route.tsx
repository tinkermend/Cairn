import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { toAuthUser } from '@/lib/auth'
import { fetchMe } from '@/lib/rbac-api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
    const token = useAuthStore.getState().auth.accessToken
    if (!token) {
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      })
    }
    try {
      const me = await context.queryClient.ensureQueryData({
        queryKey: ['me'],
        queryFn: fetchMe,
      })
      useAuthStore.getState().auth.setUser(toAuthUser(me.account))
    } catch {
      useAuthStore.getState().auth.reset()
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      })
    }
  },
  component: AuthenticatedLayout,
})
