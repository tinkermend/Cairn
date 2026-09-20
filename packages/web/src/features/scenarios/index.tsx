import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ScenarioDto } from '@cairn/shared'
import {
  ArrowUpRight,
  CheckCircle2,
  Globe2,
  ListOrdered,
  Plus,
  Search,
  Trash2,
  Workflow,
} from 'lucide-react'
import { fetchScenarios, previewDeleteScenario, deleteScenario } from '@/lib/scenarios-api'
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
import { ScenarioCreateDialog } from './create-dialog'
import { SCENARIO_STATUS_LABELS } from './labels'

export function ScenariosPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const canReadTargets = useCan('target:read')
  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<ScenarioDto | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all')
  const [targetId, setTargetId] = useState<string>('all')
  const [hasDraft, setHasDraft] = useState<'all' | 'true'>('all')

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      targetId: targetId === 'all' ? undefined : targetId,
      status: status === 'all' ? undefined : status,
      hasDraft: hasDraft === 'all' ? undefined : true,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, targetId, status, hasDraft, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['scenarios', filters],
    queryFn: () => fetchScenarios(filters),
    placeholderData: keepPreviousData,
  })

  const handleSearchChange = (val: string) => {
    setSearch(val)
    page.reset()
  }

  const handleStatusChange = (val: 'all' | 'active' | 'disabled') => {
    setStatus(val)
    page.reset()
  }

  const handleTargetChange = (val: string) => {
    setTargetId(val)
    page.reset()
  }

  const handleHasDraftChange = (val: 'all' | 'true') => {
    setHasDraft(val)
    page.reset()
  }

  const items = query.data?.items ?? []
  const targetNames = new Map(
    (canReadTargets ? (targets.data?.items ?? []) : []).map((item) => [
      item.id,
      item.name,
    ])
  )

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='自动化场景'
          description='把业务任务组织成有序步骤，在同一场景中管理定义、版本与执行入口。'
          actions={
            <Can permission='workflow:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                新建场景
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState
            title='无法加载场景'
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '本页场景',
                  value: items.length,
                  description: '当前页已加载，不是全部总量',
                  icon: <Workflow className='size-4' />,
                },
                {
                  label: '本页已启用',
                  value: items.filter((item) => item.status === 'active')
                    .length,
                  description: '当前页中处于启用状态的场景',
                  icon: (
                    <CheckCircle2 className='size-4 text-status-success-foreground' />
                  ),
                },
                {
                  label: '本页目标系统',
                  value: new Set(items.map((item) => item.targetId)).size,
                  description: '当前页场景绑定的目标系统数',
                  icon: <Globe2 className='size-4' />,
                },
                {
                  label: '本页步骤',
                  value: items.reduce((sum, item) => sum + item.stepCount, 0),
                  description: '按当前页各场景最新版本统计',
                  icon: <ListOrdered className='size-4' />,
                },
              ]}
            />
            <section
              aria-label='场景列表'
              className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
            >
              <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                <div className='flex flex-wrap items-center gap-2' aria-label='场景筛选'>
                  <div className='flex flex-wrap gap-1'>
                    {(
                      [
                        ['all', '全部状态'],
                        ['active', '已启用'],
                        ['disabled', '已停用'],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        variant={status === value ? 'secondary' : 'ghost'}
                        size='sm'
                        aria-pressed={status === value}
                        onClick={() => handleStatusChange(value)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <Button
                    variant={hasDraft === 'true' ? 'secondary' : 'ghost'}
                    size='sm'
                    aria-pressed={hasDraft === 'true'}
                    onClick={() => handleHasDraftChange(hasDraft === 'true' ? 'all' : 'true')}
                  >
                    未发布草稿
                  </Button>
                  {canReadTargets && targets.data?.items && targets.data.items.length > 0 ? (
                    <Select value={targetId} onValueChange={handleTargetChange}>
                      <SelectTrigger className='h-8 w-44' aria-label='目标系统筛选'>
                        <SelectValue placeholder='全部目标系统' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='all'>全部目标系统</SelectItem>
                        {targets.data.items.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
                <div className='relative w-full sm:w-72'>
                  <Search
                    aria-hidden='true'
                    className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                  />
                  <Input
                    aria-label='搜索场景'
                    placeholder='搜索场景或目标系统'
                    value={search}
                    onChange={(event) => handleSearchChange(event.target.value)}
                    className='pl-9'
                  />
                </div>
              </div>
              {canReadTargets && targets.isError ? (
                <p className='px-4 pt-3 text-small text-muted-foreground'>
                  目标系统名称暂不可用，以下显示系统 ID。
                  <Button
                    variant='link'
                    size='sm'
                    onClick={() => void targets.refetch()}
                  >
                    重新加载名称
                  </Button>
                </p>
              ) : null}
              {items.length === 0 ? (
                <EmptyState
                  title={
                    search || status !== 'all' || targetId !== 'all' || hasDraft !== 'all'
                      ? '没有匹配的场景'
                      : '还没有场景'
                  }
                  description={
                    search || status !== 'all' || targetId !== 'all' || hasDraft !== 'all'
                      ? '试试其他关键词，或清除筛选条件。'
                      : '从一个目标系统开始，创建第一组有序步骤。'
                  }
                  action={
                    search || status !== 'all' || targetId !== 'all' || hasDraft !== 'all' ? (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setSearch('')
                        setStatus('all')
                        setTargetId('all')
                        setHasDraft('all')
                        page.reset()
                      }}
                    >
                      清除筛选
                    </Button>
                    ) : undefined
                  }
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>场景</TableHead>
                      <TableHead>目标系统</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>最新版本</TableHead>
                      <TableHead>步骤</TableHead>
                      <TableHead>最近更新</TableHead>
                      <TableHead>
                        <span className='sr-only'>操作</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className='py-4'>
                          <div className='flex items-center gap-3'>
                            <span
                              aria-hidden='true'
                              className='flex size-10 shrink-0 items-center justify-center rounded-md bg-selection-background text-primary'
                            >
                              <ListOrdered className='size-5' />
                            </span>
                            <div className='min-w-0'>
                              <Link
                                to='/scenarios/$scenarioId'
                                params={{ scenarioId: item.id }}
                                className='block max-w-72 truncate rounded-sm text-body font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                                title={item.name}
                              >
                                {item.name}
                              </Link>
                              <p className='mt-1 text-label text-muted-foreground'>
                                顺序执行 · {item.stepCount} 个步骤
                                {item.draftDirty ? ' · 有未发布草稿' : ''}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {canReadTargets ? (
                            <Link
                              to='/targets/$targetId'
                              params={{ targetId: item.targetId }}
                              title={
                                targetNames.get(item.targetId) ?? item.targetId
                              }
                              className='block max-w-48 truncate text-link hover:underline'
                            >
                              {targetNames.get(item.targetId) ?? item.targetId}
                            </Link>
                          ) : (
                            <span
                              title={item.targetId}
                              className='block max-w-48 truncate font-mono text-label'
                            >
                              {item.targetId}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className='flex flex-wrap gap-2'>
                            <StatusBadge
                              tone={
                                item.status === 'active' ? 'success' : 'neutral'
                              }
                            >
                              {SCENARIO_STATUS_LABELS[item.status]}
                            </StatusBadge>
                            {item.draftDirty ? (
                              <StatusBadge tone='warning'>未发布草稿</StatusBadge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone='neutral'>
                            v{item.latestVersionNo}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {item.stepCount}
                        </TableCell>
                        <TableCell className='text-label text-muted-foreground'>
                          {new Date(item.updatedAt).toLocaleString('zh-CN', {
                            hour12: false,
                          })}
                        </TableCell>
                        <TableCell>
                          <div className='flex items-center justify-end gap-1'>
                            <Button asChild variant='ghost' size='icon'>
                              <Link
                                to='/scenarios/$scenarioId'
                                params={{ scenarioId: item.id }}
                                aria-label={`打开${item.name}`}
                              >
                                <ArrowUpRight className='size-4' />
                              </Link>
                            </Button>
                            <Can permission='workflow:delete'>
                              <Button
                                variant='ghost'
                                size='icon'
                                className='text-destructive'
                                aria-label={`删除${item.name}`}
                                onClick={() => setRemoving(item)}
                              >
                                <Trash2 className='size-4' />
                              </Button>
                            </Can>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
                <p
                  role='status'
                  className='text-label text-muted-foreground'
                >
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
            </section>
          </>
        )}
      </Main>
      <ScenarioCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          void navigate({
            to: '/scenarios/$scenarioId',
            params: { scenarioId: id },
          })
        }}
      />
      <ResourceDeleteDialog
        open={Boolean(removing)}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        resourceId={removing?.id ?? ''}
        resourceName={removing?.name ?? ''}
        resourceType='scenario'
        previewFn={removing ? () => previewDeleteScenario(removing.id) : undefined}
        deleteFn={(body) => (removing ? deleteScenario(removing.id, body) : Promise.resolve())}
        onSuccess={async () => {
          setRemoving(null)
          if (items.length <= 1 && page.pageIndex > 0) page.goPrev()
          await queryClient.invalidateQueries({ queryKey: ['scenarios'] })
        }}
      />
    </>
  )
}
