import { createFileRoute, redirect } from '@tanstack/react-router'
import { CredentialDetailPage } from '@/features/credentials'
import { useAuthStore } from '@/stores/auth-store'
import { can } from '@/lib/rbac'

export const Route = createFileRoute('/_authenticated/credentials/$credentialId/')({
  beforeLoad: () => {
    const user = useAuthStore.getState().auth.user
    if (!user || !can(user, 'credential:read')) {
      throw redirect({ to: '/403' })
    }
  },
  component: CredentialDetailRoute,
})

function CredentialDetailRoute() {
  const { credentialId } = Route.useParams()
  return <CredentialDetailPage credentialId={credentialId} />
}
