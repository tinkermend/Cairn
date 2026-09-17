import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  RUN_EXECUTE_ALL_OF,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isFinishedRunStatus,
  type RunStatus,
  type RunSummaryDto,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { cancelRun, deleteRun, fetchRuns, previewDeleteRun } from '@/lib/runs-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargets } from '@/lib/targets-api'
import { CatalogName } from './catalog-name'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
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
import { DateRangePicker, type DateRange } from '@/components/date-range-picker'
import { dateRange, rangeToDayKeys } from '@/features/audit/range'
import { RunCreateDialog } from './create-dialog'
import {
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  runEvidenceStatusTone,
  runStatusTone,
} from './labels'

export function RunsPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const canReadTargets = useCan('target:read')
  const canReadScenarios = useCan('workflow:read')

  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })
  const [scenarioSearch, setScenarioSearch] = useState('')
  const scenarios = useQuery({
    queryKey: ['scenarios', { limit: 100, search: scenarioSearch.trim() || undefined }],
    queryFn: () => fetchScenarios({ limit: 100, search: scenarioSearch.trim() || undefined }),
    enabled: canReadScenarios,
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<RunSummaryDto | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<string>('all')
  const [targetId, setTargetId] = useState<string>('all')
  const [scenarioId, setScenarioId] = useState<string>('all')
  const [isTrial, setIsTrial] = useState<'all' | 'true'>('all')
  const [evidenceStatus, setEvidenceStatus] = useState<'all' | 'PENDING' | 'COMPLETE' | 'INCOMPLETE'>(
    'all',
  )
  const [sourceKind, setSourceKind] = useState<'all' | 'console' | 'service'>('all')
  const [range, setRange] = useState<DateRange | undefined>()

  const filters = useMemo(() => {
    const days = rangeToDayKeys(range)
    const bounds = dateRange(days.fromDay, days.toDay)
    return {
      search: search.trim() || undefined,
      targetId: targetId === 'all' ? undefined : targetId,
      scenarioId: scenarioId === 'all' ? undefined : scenarioId,
      status: status === 'all' ? undefined : (status as RunStatus),
      isTrial: isTrial === 'all' ? undefined : true,
      evidenceStatus: evidenceStatus === 'all' ? undefined : evidenceStatus,
      sourceKind: sourceKind === 'all' ? undefined : sourceKind,
      from: bounds.from?.toISOString(),
      to: bounds.to?.toISOString(),
      limit: page.pageSize,
      cursor: page.cursor,
    }
  }, [search, targetId, scenarioId, status, isTrial, evidenceStatus, sourceKind, range, page.pageSize, page.cursor])

  const query = useQuery({
    queryKey: ['runs', filters],
    queryFn: () => fetchRuns(filters),
    placeholderData: keepPreviousData,
  })

  const handleSearchChange = (val: string) => {
    setSearch(val)
    page.reset()
  }

  const handleStatusChange = (val: string) => {
    setStatus(val)
    page.reset()
  }

  const handleTargetChange = (val: string) => {
    setTargetId(val)
    page.reset()
  }

  const handleScenarioChange = (val: string) => {
    setScenarioId(val)
    page.reset()
  }

  const handleTrialChange = (val: 'all' | 'true') => {
    setIsTrial(val)
    page.reset()
  }

  const handleEvidenceChange = (val: 'all' | 'PENDING' | 'COMPLETE' | 'INCOMPLETE') => {
    setEvidenceStatus(val)
    page.reset()
  }

  const handleSourceChange = (val: 'all' | 'console' | 'service') => {
    setSourceKind(val)
    page.reset()
  }

  const items = query.data?.items ?? []

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='运行'
          description='对目标系统执行场景的一次记录。进度以手动刷新的 GET 为准。'
          actions={
            <Can allOf={RUN_EXECUTE_ALL_OF}>
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
        ) : (
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
              <div className='flex flex-wrap items-center gap-2'>
                <div className='flex flex-wrap gap-1'>
                  {(
                    [
                      ['all', '全部状态'],
                      ...RUN_STATUSES.map((value) => [value, RUN_STATUS_LABELS[value]] as const),
                    ] as const
                  ).map(([val, label]) => (
                    <Button
                      key={val}
                      variant={status === val ? 'secondary' : 'ghost'}
                      size='sm'
                      aria-pressed={status === val}
                      onClick={() => handleStatusChange(val)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                <Button
                  variant={isTrial === 'true' ? 'secondary' : 'ghost'}
                  size='sm'
                  aria-pressed={isTrial === 'true'}
                  onClick={() => handleTrialChange(isTrial === 'true' ? 'all' : 'true')}
                >
                  试跑记录
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

                {canReadScenarios && scenarios.data?.items && scenarios.data.items.length > 0 ? (
                  <Select value={scenarioId} onValueChange={handleScenarioChange}>
                    <SelectTrigger className='h-8 w-44' aria-label='场景筛选'>
                      <SelectValue placeholder='全部场景' />
                    </SelectTrigger>
                    <SelectContent>
                      <div className='p-1'>
                        <Input
                          aria-label='搜索场景'
                          placeholder='搜索场景'
                          value={scenarioSearch}
                          onChange={(event) => setScenarioSearch(event.target.value)}
                        />
                      </div>
                      <SelectItem value='all'>全部场景</SelectItem>
                      {scenarios.data.items.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <Select value={evidenceStatus} onValueChange={handleEvidenceChange}>
                  <SelectTrigger className='h-8 w-36' aria-label='证据状态筛选'>
                    <SelectValue placeholder='证据状态' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>全部证据</SelectItem>
                    <SelectItem value='PENDING'>证据待齐</SelectItem>
                    <SelectItem value='COMPLETE'>证据完整</SelectItem>
                    <SelectItem value='INCOMPLETE'>证据不完整</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={sourceKind} onValueChange={handleSourceChange}>
                  <SelectTrigger className='h-8 w-32' aria-label='来源筛选'>
                    <SelectValue placeholder='来源' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>全部来源</SelectItem>
                    <SelectItem value='console'>控制台</SelectItem>
                    <SelectItem value='service'>服务调用</SelectItem>
                  </SelectContent>
                </Select>

                <DateRangePicker
                  value={range}
                  onChange={(next) => {
                    setRange(next)
                    page.reset()
                  }}
                />
              </div>

              <div className='relative w-full sm:w-72'>
                <Search
                  aria-hidden='true'
                  className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                />
                <Input
                  aria-label='搜索运行'
                  placeholder='搜索场景或目标系统'
                  value={search}
                  onChange={(event) => handleSearchChange(event.target.value)}
                  className='pl-9'
                />
              </div>
            </div>

            {items.length === 0 ? (
              <EmptyState
                title='没有匹配的运行记录'
                description='从已绑定目标系统的场景发起一次执行，或清除筛选条件。'
                action={
                  search ||
                  status !== 'all' ||
                  targetId !== 'all' ||
                  scenarioId !== 'all' ||
                  isTrial !== 'all' ||
                  evidenceStatus !== 'all' ||
                  sourceKind !== 'all' ||
                  range ? (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setSearch('')
                        setStatus('all')
                        setTargetId('all')
                        setScenarioId('all')
                        setIsTrial('all')
                        setEvidenceStatus('all')
                        setSourceKind('all')
                        setRange(undefined)
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
                    <TableHead>状态</TableHead>
                    <TableHead>证据</TableHead>
                    <TableHead>场景</TableHead>
                    <TableHead>目标系统</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead className='w-40 text-end'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const isTerminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(
                      item.status,
                    )
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <StatusBadge tone={runStatusTone(item.status)}>
                            {RUN_STATUS_LABELS[item.status]}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>
                          {item.evidenceStatus === 'INCOMPLETE' ||
                          (item.evidenceStatus === 'PENDING' &&
                            isFinishedRunStatus(item.status)) ? (
                            <StatusBadge
                              tone={runEvidenceStatusTone(item.evidenceStatus, item.status)}
                            >
                              {RUN_EVIDENCE_STATUS_LABELS[item.evidenceStatus]}
                            </StatusBadge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <CatalogName name={item.scenarioName} deleted={item.scenarioDeleted}>
                            <Link
                              to='/scenarios/$scenarioId'
                              params={{ scenarioId: item.scenarioId }}
                              className='text-primary hover:underline'
                            >
                              {item.scenarioName}
                            </Link>
                          </CatalogName>
                        </TableCell>
                        <TableCell>
                          <CatalogName name={item.targetName} deleted={item.targetDeleted}>
                            <Link
                              to='/targets/$targetId'
                              params={{ targetId: item.targetId }}
                              className='text-primary hover:underline'
                            >
                              {item.targetName}
                            </Link>
                          </CatalogName>
                        </TableCell>
                        <TableCell className='whitespace-nowrap text-label'>
                          {new Date(item.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell className='text-end'>
                          <div className='flex items-center justify-end gap-1'>
                            <Button
                              variant='outline'
                              size='sm'
                              onClick={() =>
                                void navigate({
                                  to: '/runs/$runId',
                                  params: { runId: item.id },
                                })
                              }
                            >
                              查看
                            </Button>
                            {!isFinishedRunStatus(item.status) &&
                            item.status !== 'NEEDS_REVIEW' ? (
                              <Can permission='run:cancel'>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  className='text-destructive'
                                  onClick={() => {
                                    void cancelRun(item.id)
                                      .then((detail) => {
                                        toast.success(
                                          detail.status === 'CANCELLED' ? '已取消' : '已请求取消',
                                        )
                                        void query.refetch()
                                      })
                                      .catch((error) => {
                                        toast.error(
                                          error instanceof ApiRequestError
                                            ? error.message
                                            : '取消失败',
                                        )
                                      })
                                  }}
                                >
                                  取消
                                </Button>
                              </Can>
                            ) : null}
                            {isTerminal ? (
                              <Can permission='run:delete'>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='text-destructive'
                                  aria-label={`删除运行${item.id}`}
                                  onClick={() => setRemoving(item)}
                                >
                                  <Trash2 className='size-4' />
                                </Button>
                              </Can>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
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
        )}
      </Main>

      <RunCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

      <ResourceDeleteDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        resourceId={removing?.id ?? ''}
        resourceName={removing ? `${removing.scenarioName} (${removing.id.slice(0, 8)})` : ''}
        resourceType='run'
        previewFn={removing ? () => previewDeleteRun(removing.id) : undefined}
        deleteFn={(body) => (removing ? deleteRun(removing.id, body) : Promise.resolve())}
        onSuccess={() => {
          setRemoving(null)
          if (items.length <= 1 && page.pageIndex > 0) page.goPrev()
          void queryClient.invalidateQueries({ queryKey: ['runs'] })
        }}
      />
    </>
  )
}
