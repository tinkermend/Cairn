import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { TargetDto } from '@cairn/shared'
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Globe2,
  Plus,
  Search,
  ShieldAlert,
  Users,
} from 'lucide-react'
import { fetchTargets, previewDeleteTarget, deleteTarget } from '@/lib/targets-api'
import { fetchSessionSystemOverview } from '@/lib/sessions-api'
import { systemSessionOccupancyHint } from '@/features/sessions/occupancy-label'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { CursorPagination } from '@/components/data-table'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  AUTH_METHOD_LABELS,
  TARGET_STATUS_LABELS,
} from './labels'
import { TargetFormDialog } from './target-form-dialog'
import { TargetOverviewPanel } from './target-overview-panel'

export function TargetsPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const canReadSession = useCan('session:read')
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<TargetDto | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all')
  const [authMethod, setAuthMethod] = useState<'all' | 'password' | 'manual'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const sessionSystemsQuery = useQuery({
    queryKey: ['sessions-systems-overview'],
    queryFn: () => fetchSessionSystemOverview(),
    enabled: canReadSession,
    staleTime: 10_000,
  })

  const sessionSystemMap = useMemo(
    () =>
      new Map(
        (sessionSystemsQuery.data?.items ?? []).map((item) => [
          item.targetId,
          item,
        ]),
      ),
    [sessionSystemsQuery.data],
  )

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      status: status === 'all' ? undefined : status,
      authMethod: authMethod === 'all' ? undefined : authMethod,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, status, authMethod, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['targets', filters],
    queryFn: () => fetchTargets(filters),
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

  const handleAuthMethodChange = (val: 'all' | 'password' | 'manual') => {
    setAuthMethod(val)
    page.reset()
  }

  const items = query.data?.items ?? []
  const selected = items.find((item) => item.id === selectedId) ?? items[0]

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='目标系统'
          description='连接真实业务系统，为场景准备入口、认证方式与目标账号。'
          actions={
            <Can permission='target:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                新建目标系统
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState
            title='无法加载目标系统'
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '本页系统',
                  value: items.length,
                  description: '当前页已加载，不是全部总量',
                  icon: <Globe2 className='size-4' />,
                },
                {
                  label: '本页已启用',
                  value: items.filter((item) => item.status === 'active')
                    .length,
                  description: '当前页中已启用的系统',
                  icon: (
                    <CheckCircle2 className='size-4 text-status-success-foreground' />
                  ),
                },
                {
                  label: '本页账号',
                  value: items.reduce(
                    (sum, item) => sum + item.accountCount,
                    0
                  ),
                  description: '当前页系统下的账号合计',
                  icon: <Users className='size-4' />,
                },
                {
                  label: '本页验证码',
                  value: items.filter((item) => item.captchaMode !== 'none')
                    .length,
                  description: '当前页中需要关注认证的系统',
                  icon: (
                    <ShieldAlert className='size-4 text-status-warning-foreground' />
                  ),
                },
              ]}
            />
            <div className='grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]'>
              <section
                aria-label='目标系统列表'
                className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                  <div
                    className='flex flex-wrap gap-1'
                    aria-label='系统状态筛选'
                  >
                    {(
                      [
                        ['all', '全部系统'],
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
                  <div className='flex flex-wrap gap-1' aria-label='认证方式筛选'>
                    {(
                      [
                        ['all', '全部认证'],
                        ['password', '口令登录'],
                        ['manual', '手工登录'],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        variant={authMethod === value ? 'secondary' : 'ghost'}
                        size='sm'
                        aria-pressed={authMethod === value}
                        onClick={() => handleAuthMethodChange(value)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className='relative w-full sm:w-64'>
                    <Search
                      aria-hidden='true'
                      className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                    />
                    <Input
                      aria-label='搜索目标系统'
                      placeholder='搜索名称、编码或入口'
                      value={search}
                      onChange={(event) => handleSearchChange(event.target.value)}
                      className='pl-9'
                    />
                  </div>
                </div>
                {items.length === 0 ? (
                  <EmptyState
                    title={
                      search || status !== 'all' || authMethod !== 'all'
                        ? '没有匹配的目标系统'
                        : '还没有目标系统'
                    }
                    description={
                      search || status !== 'all' || authMethod !== 'all'
                        ? '试试其他关键词，或清除筛选条件。'
                        : '登记第一个业务系统，然后添加用于执行场景的目标账号。'
                    }
                    action={
                      search || status !== 'all' || authMethod !== 'all' ? (
                      <Button
                        variant='outline'
                        onClick={() => {
                          setSearch('')
                          setStatus('all')
                          setAuthMethod('all')
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
                        <TableHead>系统 / 入口</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>认证</TableHead>
                        <TableHead>账号 / 会话</TableHead>
                        <TableHead>
                          <span className='sr-only'>详情</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow
                          key={item.id}
                          className='cursor-pointer'
                          onClick={() => setSelectedId(item.id)}
                          data-state={
                            selected?.id === item.id ? 'selected' : undefined
                          }
                        >
                          <TableCell className='py-4'>
                            <div className='flex items-center gap-3'>
                              <span
                                aria-hidden='true'
                                className='flex size-10 shrink-0 items-center justify-center rounded-md border border-border-default bg-card text-primary'
                              >
                                <Globe2 className='size-5' />
                              </span>
                              <div className='min-w-0'>
                                <button
                                  type='button'
                                  aria-pressed={selected?.id === item.id}
                                  aria-controls='target-overview'
                                  className='block max-w-64 truncate rounded-sm text-body font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                                  title={item.name}
                                >
                                  {item.name}
                                </button>
                                <div className='mt-1 flex items-center gap-1.5'>
                                  <p
                                    className='max-w-56 truncate text-label text-muted-foreground'
                                    title={item.entryUrl}
                                  >
                                    {item.entryUrl}
                                  </p>
                                  <a
                                    href={item.entryUrl}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                    className='text-muted-foreground hover:text-text-primary p-0.5 rounded focus-visible:outline-2 focus-visible:outline-ring'
                                    onClick={(e) => e.stopPropagation()}
                                    title={`新标签页打开${item.name}入口`}
                                    aria-label={`新标签页打开${item.name}入口`}
                                  >
                                    <ExternalLink className='size-3 shrink-0' />
                                  </a>
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              tone={
                                item.status === 'active' ? 'success' : 'neutral'
                              }
                            >
                              {TARGET_STATUS_LABELS[item.status]}
                            </StatusBadge>
                          </TableCell>
                          <TableCell>
                            {AUTH_METHOD_LABELS[item.authMethod]}
                          </TableCell>
                          <TableCell>
                            {(() => {
                              const sessionInfo = sessionSystemMap.get(item.id)
                              if (item.accountCount === 0) {
                                return (
                                  <span className='text-muted-foreground'>
                                    0 个
                                  </span>
                                )
                              }
                              if (sessionInfo) {
                                const occupancy = systemSessionOccupancyHint({
                                  accountCount: item.accountCount,
                                  liveSessionCount: sessionInfo.liveSessionCount,
                                  sessionCapTotal: sessionInfo.sessionCapTotal,
                                })
                                if (sessionInfo.problemCount > 0) {
                                  return (
                                    <span className='inline-flex items-center gap-1.5 tabular-nums text-status-warning-foreground font-medium'>
                                      <span className='size-2 rounded-full bg-status-warning-foreground shrink-0' />
                                      <span>
                                        {item.accountCount} 个 ({sessionInfo.problemCount} 待处理)
                                        {occupancy ? ` · ${occupancy}` : ''}
                                      </span>
                                    </span>
                                  )
                                }
                                if (
                                  sessionInfo.readyCount === item.accountCount
                                ) {
                                  return (
                                    <span className='inline-flex items-center gap-1.5 tabular-nums text-status-success-foreground font-medium'>
                                      <span className='size-2 rounded-full bg-status-success-foreground shrink-0' />
                                      <span>
                                        {item.accountCount} 个 (全就绪)
                                        {occupancy ? ` · ${occupancy}` : ''}
                                      </span>
                                    </span>
                                  )
                                }
                                return (
                                  <span className='tabular-nums'>
                                    {item.accountCount} 个
                                    {occupancy ? ` · ${occupancy}` : ''}
                                  </span>
                                )
                              }
                              return (
                                <span className='tabular-nums'>
                                  {item.accountCount} 个
                                </span>
                              )
                            })()}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant='ghost'
                              size='icon'
                              asChild
                            >
                              <Link
                                to='/targets/$targetId'
                                params={{ targetId: item.id }}
                                aria-label={`查看${item.name}详情`}
                                title={`查看${item.name}详情`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ChevronRight />
                              </Link>
                            </Button>
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
              {selected ? (
                <TargetOverviewPanel
                  target={selected}
                  onDelete={(target) => setRemoving(target)}
                />
              ) : null}
            </div>
          </>
        )}
      </Main>
      <TargetFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(target) => {
          void navigate({
            to: '/targets/$targetId',
            params: { targetId: target.id },
          })
        }}
      />
      <ResourceDeleteDialog
        open={Boolean(removing)}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        resourceId={removing?.id ?? ''}
        resourceName={removing ? `${removing.name}（${removing.code}）` : ''}
        resourceType='target'
        previewFn={removing ? () => previewDeleteTarget(removing.id) : undefined}
        deleteFn={(body) => (removing ? deleteTarget(removing.id, body) : Promise.resolve())}
        onSuccess={async () => {
          setRemoving(null)
          await queryClient.invalidateQueries({ queryKey: ['targets'] })
          if (items.length <= 1 && page.pageIndex > 0) page.goPrev()
        }}
      />
    </>
  )
}
