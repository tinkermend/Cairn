import { useQuery } from '@tanstack/react-query'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { fetchRoles } from '@/lib/rbac-api'
import { RolesDialogs } from './components/roles-dialogs'
import { RolesPrimaryButtons } from './components/roles-primary-buttons'
import { RolesProvider } from './components/roles-provider'
import { RolesTable } from './components/roles-table'

export function RolesPage() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: fetchRoles })

  return (
    <RolesProvider>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div className='flex flex-wrap items-end justify-between gap-2'>
          <div>
            <h2 className='text-2xl font-bold tracking-tight'>Roles</h2>
            <p className='text-muted-foreground'>
              System roles are fixed. Custom roles are named sets of catalog
              permissions.
            </p>
          </div>
          <RolesPrimaryButtons />
        </div>
        {roles.isError ? (
          <p className='text-destructive text-sm'>Failed to load roles.</p>
        ) : (
          <RolesTable data={roles.data?.items ?? []} />
        )}
      </Main>

      <RolesDialogs />
    </RolesProvider>
  )
}
