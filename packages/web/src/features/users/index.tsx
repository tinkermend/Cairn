import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { fetchAccounts, fetchRoles } from '@/lib/rbac-api'
import { UsersDialogs } from './components/users-dialogs'
import { UsersPrimaryButtons } from './components/users-primary-buttons'
import { UsersProvider } from './components/users-provider'
import { UsersTable } from './components/users-table'

const route = getRouteApi('/_authenticated/users/')

export function Users() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  const roles = useQuery({ queryKey: ['roles'], queryFn: fetchRoles })

  return (
    <UsersProvider>
      <AppHeader fixed />

      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='用户'
          description='管理控制台账号，并分配角色。'
          actions={<UsersPrimaryButtons />}
        />
        {accounts.isPending ? (
          <PageSkeleton />
        ) : accounts.isError ? (
          <QueryErrorState
            title='无法加载账号列表'
            onRetry={() => {
              void accounts.refetch()
            }}
          />
        ) : (
          <UsersTable
            data={accounts.data?.items ?? []}
            roles={roles.data?.items ?? []}
            search={search}
            navigate={navigate}
          />
        )}
      </Main>

      <UsersDialogs roles={roles.data?.items ?? []} />
    </UsersProvider>
  )
}
