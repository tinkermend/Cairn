import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { fetchRecordings } from '@/lib/recordings-api'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function RecordingsPage() {
  const query = useQuery({ queryKey: ['recordings'], queryFn: fetchRecordings })
  const items = query.data?.items ?? []

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='录制草稿'
          description='插件上传的操作序列。这里是 Authoring 草稿，还不是可运行场景。'
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载录制草稿' onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有录制草稿'
            description='在识途录制器里登录控制台账号、选择目标系统后上传。'
          />
        ) : (
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>目标系统</TableHead>
                  <TableHead>步骤</TableHead>
                  <TableHead>待处理</TableHead>
                  <TableHead>上传人</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        to='/recordings/$recordingId'
                        params={{ recordingId: item.id }}
                        className='font-medium text-primary hover:underline'
                      >
                        {item.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        to='/targets/$targetId'
                        params={{ targetId: item.targetId }}
                        className='text-primary hover:underline'
                      >
                        {item.targetName}
                      </Link>
                    </TableCell>
                    <TableCell>{item.itemCount}</TableCell>
                    <TableCell>{item.unresolvedCount}</TableCell>
                    <TableCell>{item.createdBy.displayName}</TableCell>
                    <TableCell className='text-muted-foreground'>
                      {new Date(item.createdAt).toLocaleString('zh-CN')}
                    </TableCell>
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
