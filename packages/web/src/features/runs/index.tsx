import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { isFinishedRunStatus } from '@cairn/shared'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { cancelRun, fetchRuns } from '@/lib/runs-api'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RunCreateDialog } from './create-dialog'
import { RUN_STATUS_LABELS, runStatusTone } from './labels'

export function RunsPage() {
  const query = useQuery({ queryKey: ['runs'], queryFn: fetchRuns })
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const items = query.data?.items ?? []

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='运行'
          description='对目标系统执行场景的一次记录。进度以手动刷新的 GET 为准。'
          actions={
            <Can permission='run:execute'>
              <Button onClick={() => setCreateOpen(true)}>
                创建运行 <Plus size={18} />
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载运行' onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有运行'
            description='从已绑定目标系统的场景发起一次执行。'
            action={
              <Can permission='run:execute'>
                <Button onClick={() => setCreateOpen(true)}>
                  创建运行 <Plus size={18} />
                </Button>
              </Can>
            }
          />
        ) : (
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>场景</TableHead>
                  <TableHead>目标系统</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className='w-32' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <StatusBadge tone={runStatusTone(item.status)}>
                        {RUN_STATUS_LABELS[item.status]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <Link
                        to='/scenarios/$scenarioId'
                        params={{ scenarioId: item.scenarioId }}
                        className='text-primary hover:underline'
                      >
                        {item.scenarioName}
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
                    <TableCell className='whitespace-nowrap text-label'>
                      {new Date(item.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className='space-x-2'>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => void navigate({ to: '/runs/$runId', params: { runId: item.id } })}
                      >
                        查看
                      </Button>
                      {!isFinishedRunStatus(item.status) && item.status !== 'NEEDS_REVIEW' ? (
                        <Can permission='run:cancel'>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='text-destructive'
                            onClick={() => {
                              void cancelRun(item.id)
                                .then(() => {
                                  toast.success('已取消')
                                  void query.refetch()
                                })
                                .catch((error) => {
                                  toast.error(error instanceof ApiRequestError ? error.message : '取消失败')
                                })
                            }}
                          >
                            取消
                          </Button>
                        </Can>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Main>
      <RunCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}
