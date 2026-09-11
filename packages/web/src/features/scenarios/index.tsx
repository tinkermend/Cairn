import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { fetchScenarios } from '@/lib/scenarios-api'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
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
import { ScenarioCreateDialog } from './create-dialog'

export function ScenariosPage() {
  const query = useQuery({ queryKey: ['scenarios'], queryFn: fetchScenarios })
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const items = query.data?.items ?? []

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='场景'
          description='绑定目标系统的最小可运行定义。这里只编排 echo / delay / fail，不是画布。'
          actions={
            <Can permission='workflow:write'>
              <Button onClick={() => setCreateOpen(true)}>
                新建场景 <Plus size={18} />
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载场景' onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有场景'
            description='先选一个目标系统，再写下最小可运行定义。'
            action={
              <Can permission='workflow:write'>
                <Button onClick={() => setCreateOpen(true)}>
                  新建场景 <Plus size={18} />
                </Button>
              </Can>
            }
          />
        ) : (
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>目标系统</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最新版本</TableHead>
                  <TableHead>步数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        to='/scenarios/$scenarioId'
                        params={{ scenarioId: item.id }}
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
                        查看目标系统
                      </Link>
                    </TableCell>
                    <TableCell>{item.status}</TableCell>
                    <TableCell>v{item.latestVersionNo}</TableCell>
                    <TableCell>{item.stepCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Main>
      <ScenarioCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: id } })
        }}
      />
    </>
  )
}
