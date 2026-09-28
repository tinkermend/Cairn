import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import type { ScenarioDto } from '@cairn/shared'
import {
  CalendarClock,
  History,
  ListOrdered,
  Loader2,
  Plus,
  Search,
  Trash2,
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
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
import { ScenarioCreateDialog } from './create-dialog'
import { SCENARIO_STATUS_LABELS, formatRelativeTime } from './labels'

const route = getRouteApi('/_authenticated/scenarios/')

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
  const routeSearch = route.useSearch()
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<ScenarioDto | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all')
  const targetId = routeSearch.targetId ?? 'all'
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
    void navigate({ to: '/scenarios', search: (prev) => ({ ...prev, targetId: val === 'all' ? undefined : val }) })
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
  const selectedTarget = targetId === 'all' || !canReadTargets
    ? undefined
    : targets.data?.items.find((item) => item.id === targetId)

  useAssistantContextBinding({
    page: 'scenario',
    routeKey: 'scenarios.index',
    ...(selectedTarget ? { targetId: selectedTarget.id } : {}),
    statusLabel: selectedTarget ? `场景列表 · ${selectedTarget.name}` : '场景列表',
    summaryText: selectedTarget
      ? `当前按目标系统「${selectedTarget.name}」筛选场景`
      : '当前场景列表没有绑定具体目标系统',
  })

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='场景编排'
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
          <section
            aria-label='场景列表'
            className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-[0_1px_3px_0_rgba(16,24,40,0.04),0_1px_2px_-1px_rgba(16,24,40,0.02)]'
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
                        handleTargetChange('all')
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
                  <TableRow className='hover:bg-transparent'>
                    <TableHead className='w-[30%] min-w-[200px]'>场景与目标系统</TableHead>
                    <TableHead className='w-[100px]'>状态</TableHead>
                    <TableHead className='w-[160px]'>最近运行</TableHead>
                    <TableHead className='w-[150px]'>调度状态</TableHead>
                    <TableHead className='w-[150px]'>创建人 / 时间</TableHead>
                    <TableHead className='w-[140px] text-right pr-6'>
                      操作
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow
                      key={item.id}
                      className='group transition-colors hover:bg-primary-50/40'
                    >
                      <TableCell className='py-3.5'>
                        <div className='flex items-center gap-3'>
                          <span
                            aria-hidden='true'
                            className='flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600'
                          >
                            <ListOrdered className='size-4' />
                          </span>
                          <div className='min-w-0 flex-1'>
                            <Link
                              to='/scenarios/$scenarioId'
                              params={{ scenarioId: item.id }}
                              className='block truncate text-body font-medium text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                              title={item.name}
                            >
                              {item.name}
                            </Link>
                            <p className='mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                              {canReadTargets && targetNames.get(item.targetId) ? (
                                <Link
                                  to='/targets/$targetId'
                                  params={{ targetId: item.targetId }}
                                  className='hover:text-link hover:underline'
                                  title={targetNames.get(item.targetId)}
                                >
                                  {targetNames.get(item.targetId)}
                                </Link>
                              ) : (
                                <span>{targetNames.get(item.targetId) ?? item.targetId}</span>
                              )}
                              <span aria-hidden='true'>·</span>
                              <span>{item.stepCount} 个步骤</span>
                              <span aria-hidden='true'>·</span>
                              <span>
                                {item.purpose === 'module_verification'
                                  ? '模块验证'
                                  : item.purpose === 'map_job'
                                    ? '地图任务'
                                    : '业务场景'}
                              </span>
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className='flex flex-wrap items-center gap-1.5'>
                          <StatusBadge
                            tone={item.status === 'active' ? 'success' : 'neutral'}
                          >
                            {SCENARIO_STATUS_LABELS[item.status]}
                          </StatusBadge>
                          {item.draftDirty ? (
                            <StatusBadge tone='warning'>草稿</StatusBadge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {item.latestRun ? (
                          <Link
                            to='/runs/$runId'
                            params={{ runId: item.latestRun.id }}
                            className='group inline-flex items-center gap-1.5 text-label hover:underline text-text-primary transition-colors'
                            title='查看本次运行详情'
                          >
                            {['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'].includes(
                              item.latestRun.status,
                            ) ? (
                              <StatusBadge tone='info' hideIcon className='gap-1'>
                                <Loader2 className='size-3 animate-spin' />
                                运行中
                              </StatusBadge>
                            ) : item.latestRun.outcomeStatus === 'FAIL' ||
                              item.latestRun.status === 'FAILED' ? (
                              <StatusBadge tone='error'>异常</StatusBadge>
                            ) : item.latestRun.status === 'CANCELLED' ? (
                              <StatusBadge tone='neutral'>已取消</StatusBadge>
                            ) : (
                              <StatusBadge tone='success'>正常</StatusBadge>
                            )}
                            <span className='text-muted-foreground'>
                              {formatRelativeTime(item.latestRun.createdAt)}
                            </span>
                          </Link>
                        ) : (
                          <span className='text-label text-muted-foreground'>— 未执行</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {item.schedule ? (
                          <span
                            className={`inline-flex items-center gap-1 text-label font-medium ${item.schedule.enabled ? 'text-text-primary' : 'text-muted-foreground'}`}
                            title={item.schedule.name || item.schedule.summary}
                          >
                            <CalendarClock className='size-3.5 shrink-0 text-primary' />
                            <span className='truncate'>
                              {item.schedule.enabled
                                ? item.schedule.summary
                                : `已暂停 (${item.schedule.summary})`}
                            </span>
                          </span>
                        ) : (
                          <span className='text-label text-muted-foreground'>— 手动触发</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className='min-w-0'>
                          <p className='text-label font-medium text-text-primary truncate'>
                            {item.createdByName || '管理员'}
                          </p>
                          <p
                            className='mt-0.5 text-label text-muted-foreground'
                            title={new Date(item.createdAt).toLocaleString('zh-CN', {
                              hour12: false,
                            })}
                          >
                            {formatRelativeTime(item.createdAt) ||
                              new Date(item.createdAt).toLocaleDateString('zh-CN')}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className='text-right pr-6'>
                        <div className='flex items-center justify-end gap-1'>
                          <Can permission='run:read'>
                            <Button
                              asChild
                              variant='ghost'
                              size='sm'
                              className='h-7 gap-1 px-2 text-label font-normal text-text-secondary hover:text-text-primary hover:bg-surface-subtle transition-colors'
                            >
                              <Link
                                to='/runs'
                                search={{
                                  search: item.name,
                                  scenarioId: item.id,
                                }}
                              >
                                <History className='size-3.5' />
                                运行记录
                              </Link>
                            </Button>
                          </Can>
                          <Can permission='workflow:delete'>
                            <Button
                              variant='ghost'
                              size='icon'
                              className='size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors'
                              onClick={() => setRemoving(item)}
                              aria-label={`删除场景：${item.name}`}
                            >
                              <Trash2 className='size-3.5' />
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
                当前页已加载 {items.length} 个场景
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

