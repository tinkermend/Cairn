import { useQuery } from '@tanstack/react-query'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fetchAuditLog } from '@/lib/rbac-api'

export function AuditPage() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: fetchAuditLog })

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>
      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Audit</h2>
          <p className='text-muted-foreground'>
            Identity and permission changes. The API is the source of truth.
          </p>
        </div>
        {audit.isError ? (
          <p className='text-destructive text-sm'>Failed to load audit events.</p>
        ) : (
          <div className='overflow-hidden rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(audit.data?.items ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className='h-24 text-center'>
                      No audit events yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  audit.data?.items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className='whitespace-nowrap text-sm'>
                        {new Date(event.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className='text-sm'>{event.actor?.displayName ?? 'System'}</div>
                        {event.actor?.email && (
                          <div className='text-muted-foreground text-xs'>{event.actor.email}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <code className='text-xs'>{event.action}</code>
                      </TableCell>
                      <TableCell className='text-sm'>{event.summary}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </Main>
    </>
  )
}
