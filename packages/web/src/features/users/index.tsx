import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
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
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-wrap items-end justify-between gap-2'>
          <div>
            <h2 className='text-2xl font-bold tracking-tight'>User List</h2>
            <p className='text-muted-foreground'>
              Manage console accounts and the roles assigned to them.
            </p>
          </div>
          <UsersPrimaryButtons />
        </div>
        {accounts.isError ? (
          <p className='text-destructive text-sm'>Failed to load accounts.</p>
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
