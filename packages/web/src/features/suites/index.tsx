import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { canExecuteRun, hasPermission, type SuiteSummaryDto } from '@cairn/shared'
import {
  CheckCircle2,
  ExternalLink,
  History,
  Layers,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  PowerOff,
  Search,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createSuiteRun,
  deleteSuite,
  fetchSuites,
  previewDeleteSuite,
  previewSuiteRun,
  updateSuiteEnabled,
} from '@/lib/suites-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { useCan } from '@/hooks/use-permissions'
import { useAuthStore } from '@/stores/auth-store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { SuiteCreateDialog } from './create-dialog'
import {
  SUITE_RUN_STATUS_LABELS,
  SUITE_STATUS_LABELS,
  SUITE_VERDICT_LABELS,
  formatDurationMs,
  formatRelativeTime,
  suiteIssueMessage,
  suiteRunStatusTone,
  suiteStatusTone,
  suiteVerdictTone,
} from './labels'

const EMPTY_PERMISSIONS: string[] = []

export function SuitesPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const canReadTargets = useCan('target:read')
  const permissions = useAuthStore((state) => state.auth.user?.permissions ?? EMPTY_PERMISSIONS)
  const canExecute = canExecuteRun(permissions) && hasPermission(permissions, 'suite:read')
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<SuiteSummaryDto | null>(null)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
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
  const targetNames = new Map(
    (canReadTargets ? (targets.data?.items ?? []) : []).map((item) => [item.id, item.name]),
  )

  async function handleQuickRun(item: SuiteSummaryDto, event?: React.MouseEvent) {
    event?.stopPropagation()
    if (!item.publishedVersionNo || item.status !== 'active') return
    setLaunchingId(item.id)
    try {
      const idempotencyKey = `suite-${crypto.randomUUID()}`
      const preview = await previewSuiteRun({
        suiteId: item.id,
        idempotencyKey,
      })
      const blocking = preview.issues.filter((issue) => issue.severity === 'error')
      if (blocking.length > 0) {
        toast.error(suiteIssueMessage(blocking[0]!))
        return
      }
      const created = await createSuiteRun({
        suiteId: item.id,
        idempotencyKey,
      })
      toast.success(`场景集「${item.name}」已启动运行`, {
        action: {
          label: '查看运行',
          onClick: () =>
            void navigate({
              to: '/suite-runs/$suiteRunId',
              params: { suiteRunId: created.observation.id },
            }),
        },
      })
      await queryClient.invalidateQueries({ queryKey: ['suites'] })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '启动失败')
    } finally {
      setLaunchingId(null)
    }
  }

  async function handleToggleEnabled(item: SuiteSummaryDto) {
    const nextStatus = item.status === 'active' ? 'disabled' : 'active'
    try {
      await updateSuiteEnabled(item.id, { status: nextStatus })
      toast.success(nextStatus === 'active' ? '场景集已启用' : '场景集已停用')
      await queryClient.invalidateQueries({ queryKey: ['suites'] })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '更新状态失败')
    }
  }

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
                  description: '可在下方查看与管理',
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
                      <TableHead>编排与规模</TableHead>
                      <TableHead>最近运行</TableHead>
                      <TableHead>发布</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className='w-28 text-right'>操作</TableHead>
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
                          <div className='min-w-0'>
                            <Link
                              to='/suites/$suiteId'
                              params={{ suiteId: item.id }}
                              className='font-medium text-link hover:underline'
                              onClick={(event) => event.stopPropagation()}
                            >
                              {item.name}
                            </Link>
                            {item.description ? (
                              <p className='mt-0.5 max-w-xs truncate text-label text-muted-foreground' title={item.description}>
                                {item.description}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className='text-body font-medium text-foreground'>
                            {targetNames.get(item.targetId) ?? item.targetId.slice(0, 8)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className='flex flex-col gap-1 items-start'>
                            {item.isStageMode || (item.stageCount && item.stageCount > 0) ? (
                              <Badge variant='outline' className='gap-1 text-label font-normal border-primary/30 text-primary'>
                                <Layers className='size-3' />
                                {item.stageCount ?? 1} 阶段 · {item.memberCount} 场景
                              </Badge>
                            ) : (
                              <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
                                平铺 · {item.memberCount} 场景
                              </Badge>
                            )}
                            {item.publishedVersionNo && item.draftRevision > item.publishedVersionNo ? (
                              <span className='text-label text-status-warning-foreground'>
                                有未发布草稿 (r{item.draftRevision})
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          {item.latestRun ? (
                            <div className='flex flex-col gap-0.5 items-start'>
                              <Link
                                to='/suite-runs/$suiteRunId'
                                params={{ suiteRunId: item.latestRun.id }}
                                className='inline-flex items-center gap-1.5 hover:opacity-80'
                                onClick={(e) => e.stopPropagation()}
                              >
                                <StatusBadge tone={suiteRunStatusTone(item.latestRun.status)}>
                                  {SUITE_RUN_STATUS_LABELS[item.latestRun.status]}
                                </StatusBadge>
                                {item.latestRun.verdict ? (
                                  <StatusBadge tone={suiteVerdictTone(item.latestRun.verdict)}>
                                    {SUITE_VERDICT_LABELS[item.latestRun.verdict]}
                                  </StatusBadge>
                                ) : null}
                              </Link>
                              <span className='text-3xs text-muted-foreground'>
                                {item.latestRun.durationMs != null
                                  ? `${formatDurationMs(item.latestRun.durationMs)} · `
                                  : ''}
                                {formatRelativeTime(item.latestRun.startedAt)}
                              </span>
                            </div>
                          ) : (
                            <span className='text-label text-muted-foreground'>从未运行</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {item.publishedVersionNo ? (
                            <Badge variant='secondary' className='font-mono text-label'>
                              v{item.publishedVersionNo}
                            </Badge>
                          ) : (
                            <span className='text-label text-muted-foreground'>未发布</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={suiteStatusTone(item.status)}>
                            {SUITE_STATUS_LABELS[item.status]}
                          </StatusBadge>
                        </TableCell>
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <div className='flex items-center justify-end gap-1.5'>
                            <Can permission='run:execute'>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      className='h-7 gap-1 px-2.5 text-label font-medium text-primary hover:text-primary hover:bg-primary/10'
                                      disabled={
                                        !canExecute ||
                                        item.status !== 'active' ||
                                        !item.publishedVersionNo ||
                                        launchingId === item.id
                                      }
                                      loading={launchingId === item.id}
                                      aria-label={`启动 ${item.name}`}
                                      onClick={(e) => void handleQuickRun(item, e)}
                                    >
                                      <Play className='size-3.5 fill-current' />
                                      启动
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                {!item.publishedVersionNo ? (
                                  <TooltipContent>请先在详情中发布版本后方可启动</TooltipContent>
                                ) : item.status !== 'active' ? (
                                  <TooltipContent>场景集已停用，需先启用</TooltipContent>
                                ) : (
                                  <TooltipContent>立即启动最新发布版本 (v{item.publishedVersionNo})</TooltipContent>
                                )}
                              </Tooltip>
                            </Can>

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='size-7 text-muted-foreground'
                                  aria-label={`更多操作 ${item.name}`}
                                >
                                  <MoreHorizontal className='size-4' />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align='end' className='w-40'>
                                <DropdownMenuItem
                                  onClick={() => void navigate({ to: '/suites/$suiteId', params: { suiteId: item.id } })}
                                >
                                  <ExternalLink className='mr-2 size-3.5' />
                                  编排详情
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => void navigate({ to: '/suite-runs', search: { suiteId: item.id } as never })}
                                >
                                  <History className='mr-2 size-3.5' />
                                  运行历史
                                </DropdownMenuItem>
                                <Can permission='suite:write'>
                                  <DropdownMenuItem
                                    onClick={() => void handleToggleEnabled(item)}
                                  >
                                    {item.status === 'active' ? (
                                      <>
                                        <PowerOff className='mr-2 size-3.5 text-muted-foreground' />
                                        停用场景集
                                      </>
                                    ) : (
                                      <>
                                        <Power className='mr-2 size-3.5 text-primary' />
                                        启用场景集
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                </Can>
                                <Can permission='suite:delete'>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className='text-destructive focus:text-destructive'
                                    onClick={() => setRemoving(item)}
                                  >
                                    <Trash2 className='mr-2 size-3.5' />
                                    删除场景集
                                  </DropdownMenuItem>
                                </Can>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
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
