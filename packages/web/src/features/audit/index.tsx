import { useQuery } from '@tanstack/react-query'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { fetchAuditLog } from '@/lib/rbac-api'

export function AuditPage() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: fetchAuditLog })
  const items = audit.data?.items ?? []

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='审计'
          description='身份与权限变更记录。持久化状态以 API 返回为准。'
        />
        {audit.isPending ? (
          <PageSkeleton />
        ) : audit.isError ? (
          <QueryErrorState
            title='无法加载审计事件'
            onRetry={() => {
              void audit.refetch()
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有审计事件'
            description='身份和权限变更会显示在这里。'
          />
        ) : (
          <div className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>摘要</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className='whitespace-nowrap text-body'>
                      {new Date(event.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className='text-body'>
                        {event.actor?.displayName ?? '系统'}
                      </div>
                      {event.actor?.email && (
                        <div className='text-label text-muted-foreground'>
                          {event.actor.email}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className='text-label'>{event.action}</code>
                    </TableCell>
                    <TableCell className='text-body'>{event.summary}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Main>
    </>
  )
}
