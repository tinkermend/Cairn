import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { SuiteSummaryDto } from '@cairn/shared'
import { CheckCircle2, Layers, Plus, Search, Trash2 } from 'lucide-react'
import { deleteSuite, fetchSuites, previewDeleteSuite } from '@/lib/suites-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { SuiteCreateDialog } from './create-dialog'
import { SUITE_STATUS_LABELS, suiteStatusTone } from './labels'

export function SuitesPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const canReadTargets = useCan('target:read')
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<SuiteSummaryDto | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all')
  const [targetId, setTargetId] = useState('all')

  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })

  const filters = useMemo(
    () => ({
      q: search.trim() || undefined,
      targetId: targetId === 'all' ? undefined : targetId,
      status: status === 'all' ? undefined : status,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, targetId, status, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['suites', filters],
    queryFn: () => fetchSuites(filters),
    placeholderData: keepPreviousData,
  })

  const items = query.data?.items ?? []
  const targetNames = new Map((canReadTargets ? (targets.data?.items ?? []) : []).map((item) => [item.id, item.name]))

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='场景集'
          description='把同一目标系统下已发布的场景编成可重复执行的集合，顺序启动并汇总报告。'
          actions={
            <Can permission='suite:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                新建场景集
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载场景集' onRetry={() => void query.refetch()} />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '本页场景集',
                  value: items.length,
                  description: '当前页已加载，不是全部总量',
                  icon: <Layers className='size-4' />,
                },
                {
                  label: '本页已启用',
                  value: items.filter((item) => item.status === 'active').length,
                  description: '当前页中可以启动的集合',
                  icon: <CheckCircle2 className='size-4 text-status-success-foreground' />,
                },
              ]}
            />
            <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
              <div className='flex flex-wrap items-center gap-2 border-b border-border-divider p-4'>
                <div className='relative min-w-48 flex-1'>
                  <Search className='pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
                  <Input
                    className='ps-9'
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value)
                      page.reset()
                    }}
                    placeholder='按名称查找'
                    aria-label='按名称查找场景集'
                  />
                </div>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    setStatus(value as typeof status)
                    page.reset()
                  }}
                >
                  <SelectTrigger className='w-32' aria-label='启用状态'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>全部状态</SelectItem>
                    <SelectItem value='active'>已启用</SelectItem>
                    <SelectItem value='disabled'>已停用</SelectItem>
                  </SelectContent>
                </Select>
                {canReadTargets ? (
                  <Select
                    value={targetId}
                    onValueChange={(value) => {
                      setTargetId(value)
                      page.reset()
                    }}
                  >
                    <SelectTrigger className='w-48' aria-label='目标系统'>
                      <SelectValue placeholder='全部目标' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部目标</SelectItem>
                      {(targets.data?.items ?? []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              {items.length === 0 ? (
                <EmptyState title='还没有场景集' description='新建一个集合，把多个已发布场景按顺序执行。' />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>目标系统</TableHead>
                      <TableHead>成员</TableHead>
                      <TableHead>发布</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className='w-20' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow
                        key={item.id}
                        className='cursor-pointer'
                        onClick={() => void navigate({ to: '/suites/$suiteId', params: { suiteId: item.id } })}
                      >
                        <TableCell>
                          <Link
                            to='/suites/$suiteId'
                            params={{ suiteId: item.id }}
                            className='font-medium text-link'
                            onClick={(event) => event.stopPropagation()}
                          >
                            {item.name}
                          </Link>
                        </TableCell>
                        <TableCell>{targetNames.get(item.targetId) ?? item.targetId.slice(0, 8)}</TableCell>
                        <TableCell>{item.memberCount}</TableCell>
                        <TableCell>{item.publishedVersionNo ? `v${item.publishedVersionNo}` : '未发布'}</TableCell>
                        <TableCell>
                          <StatusBadge tone={suiteStatusTone(item.status)}>
                            {SUITE_STATUS_LABELS[item.status]}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>
                          <Can permission='suite:delete'>
                            <Button
                              variant='ghost'
                              size='icon'
                              aria-label={`删除 ${item.name}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                setRemoving(item)
                              }}
                            >
                              <Trash2 className='size-4' />
                            </Button>
                          </Can>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
                <p role='status' className='text-label text-muted-foreground'>
                  本页 {items.length} 条
                </p>
                <CursorPagination
                  pageIndex={page.pageIndex}
                  pageSize={page.pageSize}
                  hasPreviousPage={page.pageIndex > 0}
                  hasNextPage={Boolean(query.data?.nextCursor)}
                  updating={query.isFetching && query.isPlaceholderData}
                  onPageSizeChange={page.setPageSize}
                  onPreviousPage={page.goPrev}
                  onNextPage={() => {
                    if (query.data?.nextCursor) page.goNext(query.data.nextCursor)
                  }}
                />
              </div>
            </div>
          </>
        )}
      </Main>
      <SuiteCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          void queryClient.invalidateQueries({ queryKey: ['suites'] })
          void navigate({ to: '/suites/$suiteId', params: { suiteId: id } })
        }}
      />
      <ResourceDeleteDialog
        open={Boolean(removing)}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        resourceId={removing?.id ?? ''}
        resourceName={removing?.name ?? ''}
        resourceType='suite'
        previewFn={removing ? () => previewDeleteSuite(removing.id) : undefined}
        deleteFn={(body) => (removing ? deleteSuite(removing.id, body) : Promise.resolve())}
        onSuccess={async () => {
          setRemoving(null)
          if (items.length <= 1 && page.pageIndex > 0) page.goPrev()
          await queryClient.invalidateQueries({ queryKey: ['suites'] })
        }}
      />
    </>
  )
}
