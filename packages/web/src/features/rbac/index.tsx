import { useQuery } from '@tanstack/react-query'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { fetchRoles } from '@/lib/rbac-api'
import { RolesDialogs } from './components/roles-dialogs'
import { RolesPrimaryButtons } from './components/roles-primary-buttons'
import { RolesProvider } from './components/roles-provider'
import { RolesTable } from './components/roles-table'

export function RolesPage() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: fetchRoles })

  return (
    <RolesProvider>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='角色'
          description='系统角色由代码固定。自定义角色是权限目录中的命名组合。'
          actions={<RolesPrimaryButtons />}
        />
        {roles.isPending ? (
          <PageSkeleton />
        ) : roles.isError ? (
          <QueryErrorState
            title='无法加载角色列表'
            onRetry={() => {
              void roles.refetch()
            }}
          />
        ) : (roles.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            title='还没有角色'
            description='系统角色会在初始化后出现。自定义角色可按权限目录创建。'
          />
        ) : (
          <RolesTable data={roles.data?.items ?? []} />
        )}
      </Main>

      <RolesDialogs />
    </RolesProvider>
  )
}
