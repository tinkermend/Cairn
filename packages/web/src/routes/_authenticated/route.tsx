import { createFileRoute, redirect } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import { toAuthUser } from '@/lib/auth'
import { fetchMe } from '@/lib/rbac-api'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

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
    } catch (error) {
      // 重启、断网和服务异常交给错误页，只有明确的 401 才退出登录。
      if (
        !(error instanceof ApiRequestError) ||
        error.status !== 401 ||
        useAuthStore.getState().auth.accessToken
      )
        throw error
      throw redirect({
        to: '/sign-in',
        search: { redirect: location.href },
      })
    }
  },
  component: AuthenticatedLayout,
})
