import { useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import { canCloseAccountSession, type SessionOverviewFilter } from '@cairn/shared'
import { useSessionObservation } from './use-session-observation'
import { ArrowLeft, Search } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchSessionOverview,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
} from '@/lib/sessions-api'
import { fetchTarget } from '@/lib/targets-api'
import { disposeWorkerSession } from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
  PRIMARY_ACTION_LABELS,
  SESSION_FILTER_LABELS,
  sessionOccupancyLabel,
  sessionOverviewAuthLabel,
} from './labels'

const FILTERS: Array<SessionOverviewFilter | 'all'> = [
  'all',
  'available',
  'needs_check',
  'needs_login',
  'identity_mismatch',
  'maintenance',
  'executing',
  'lost',
  'unprepared',
  'retained',
]

const route = getRouteApi('/_authenticated/sessions/$targetId/')

export function SessionSystemPage() {
  const { targetId } = route.useParams()
  const page = useCursorPage(20, `sessions-accounts-list-${targetId}`)
  const observation = useSessionObservation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const searchKey = `sessions-accounts-search-${targetId}`
  const filterKey = `sessions-accounts-filter-${targetId}`
  const [search, setSearchValue] = useState(() => sessionStorage.getItem(searchKey) ?? '')
  const setSearch = (value: string) => {
    setSearchValue(value)
    sessionStorage.setItem(searchKey, value)
  }
  const [filter, setFilterValue] = useState<SessionOverviewFilter | 'all'>(() => {
    const saved = sessionStorage.getItem(filterKey)
    return FILTERS.find((value) => value === saved) ?? 'all'
  })
  const setFilter = (value: SessionOverviewFilter | 'all') => {
    setFilterValue(value)
    sessionStorage.setItem(filterKey, value)
  }
  const [closing, setClosing] = useState<{
    accountId: string
    accountDisplayName: string
    sessionId: string
    generation: number
  } | null>(null)

  const filters = useMemo(
    () => ({
      targetId,
      search: search.trim() || undefined,
      filter: filter === 'all' ? undefined : filter,
      limit: page.pageSize,
      cursor: page.cursor || undefined,
    }),
    [targetId, search, filter, page.pageSize, page.cursor],
  )

  const target = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
  })
  const query = useQuery({
    queryKey: ['sessions-overview', filters],
    queryFn: () => fetchSessionOverview(filters),
    placeholderData: keepPreviousData,
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sessions-overview'] })
    await queryClient.invalidateQueries({ queryKey: ['sessions-systems'] })
  }

  const act = useMutation({
    mutationFn: (input: {
      accountId: string
      sessionId: string | null
      generation: number | null
      kind: 'PREPARE' | 'VERIFY_AUTH' | 'LOGIN' | 'CLOSE'
    }) =>
      requestAccountSessionOperation(targetId, input.accountId, {
        kind: input.kind,
        ...(input.sessionId && input.generation
          ? { expectedSessionId: input.sessionId, expectedGeneration: input.generation }
          : {}),
        idempotencyKey: newSessionIdempotencyKey(input.kind),
      }),
    onSuccess: async (result, variables) => {
      toast.success(result.reusedRunId ? '已转到运行认证等待' : variables.kind === 'CLOSE' ? '已提交关闭' : '已提交会话操作')
      await invalidate()
      if (result.reusedRunId) {
        await navigate({ to: '/runs/$runId', params: { runId: result.reusedRunId } })
        return
      }
      if (variables.kind !== 'CLOSE') {
        await navigate({
          to: '/sessions/$targetId/$accountId',
          params: { targetId, accountId: variables.accountId },
        })
      }
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '提交失败')
    },
  })

  const dispose = useMutation({
    mutationFn: (sessionId: string) => disposeWorkerSession(sessionId, { note: '系统会话页处置失联实例' }),
    onSuccess: async () => {
      toast.success('已提交处置')
      await invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiRequestError ? error.message : '处置失败'),
  })

  const items = query.data?.items ?? []
  const summary = query.data?.summary
  const problemCount =
    (summary?.needsCheck ?? 0) +
    (summary?.needsLogin ?? 0) +
    (summary?.identityMismatch ?? 0) +
    (summary?.lost ?? 0)
  const busyCount = (summary?.maintenance ?? 0) + (summary?.executing ?? 0)
  const openWorkbench = (accountId: string) =>
    void navigate({
      to: '/sessions/$targetId/$accountId',
      params: { targetId, accountId },
    })

  return (
    <>
      <Main className="flex min-w-0 flex-1 flex-col gap-6">
        <PageHeader
          parent={
            <Link to="/sessions" className="inline-flex items-center gap-1.5 hover:text-link">
              <ArrowLeft className="size-4" />
              返回总览
            </Link>
          }
          title={target.data?.name ?? '系统会话'}
          description={
            target.data
              ? `${summary ? `${summary.available} 就绪 · ${problemCount} 有问题 · ${summary.unprepared} 未准备 · ${busyCount} 占用中` : '查看该系统下每个账号的会话。'} · ${target.data.code}`
              : '查看该系统下每个账号的会话。'
          }
          actions={
            target.data ? (
              <Button variant="outline" asChild>
                <Link to="/targets/$targetId" params={{ targetId }}>
                  前往目标系统
                </Link>
              </Button>
            ) : undefined
          }
        />
        {!observation.connected && query.data ? (
          <p role="status" className="text-small text-muted-foreground">
            连接已断开，正在恢复。最后状态：{new Date(query.data.asOf).toLocaleString()}
          </p>
        ) : null}
        {target.isError ? (
          <EmptyState title="没有这个目标系统" description="它可能已被删除，或你没有查看权限。" />
        ) : target.isPending || query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title="无法加载系统会话" onRetry={() => void query.refetch()} />
        ) : (
          <section className="min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4">
              <div className="flex flex-wrap gap-1" aria-label="账号会话筛选">
                {FILTERS.map((value) => (
                  <Button
                    key={value}
                    variant={filter === value ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={filter === value}
                    onClick={() => {
                      setFilter(value)
                      page.reset()
                    }}
                  >
                    {SESSION_FILTER_LABELS[value]}
                  </Button>
                ))}
              </div>
              <div className="relative w-full max-w-xs">
                <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="搜索账号"
                  className="ps-9"
                  placeholder="搜索账号名称或登录名"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    page.reset()
                  }}
                />
              </div>
            </div>
            {items.length === 0 ? (
              <EmptyState title="没有匹配的账号会话" description="换一个筛选，或先在目标系统里登记账号。" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>账号</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>登录核验</TableHead>
                    <TableHead>占用</TableHead>
                    <TableHead>保留</TableHead>
                    <TableHead className="w-52" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const closable = canCloseAccountSession({
                      status: item.status,
                      sessionId: item.sessionId,
                    })
                    return (
                      <TableRow
                        key={item.targetAccountId}
                        className="cursor-pointer"
                        onClick={() => openWorkbench(item.targetAccountId)}
                      >
                        <TableCell>
                          <div>{item.accountDisplayName}</div>
                          <code className="text-label text-muted-foreground">{item.accountUsername}</code>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[item.status]}>
                            {ACCOUNT_SESSION_STATUS_LABELS[item.status]}
                          </StatusBadge>
                          {item.retained ? (
                            <p className="mt-1 text-label text-muted-foreground">保留中</p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-label text-muted-foreground">
                          {sessionOverviewAuthLabel(item.status, item.authState, item.identityState)}
                          {item.lastAuthCheckedAt
                            ? ` · ${new Date(item.lastAuthCheckedAt).toLocaleString()}`
                            : ''}
                        </TableCell>
                        <TableCell className="text-label">
                          {item.occupyingRunId ? (
                            <Link
                              className="underline"
                              to="/runs/$runId"
                              params={{ runId: item.occupyingRunId }}
                              onClick={(event) => event.stopPropagation()}
                            >
                              运行占用
                            </Link>
                          ) : (
                            sessionOccupancyLabel(item)
                          )}
                        </TableCell>
                        <TableCell className="text-label text-muted-foreground">
                          {item.retainUntil ? new Date(item.retainUntil).toLocaleString() : '—'}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-2">
                            {item.primaryAction === 'view' ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  openWorkbench(item.targetAccountId)
                                }}
                              >
                                查看
                              </Button>
                            ) : item.primaryAction === 'dispose' ? (
                              <Can permission="session:dispose">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={dispose.isPending || !item.sessionId}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (item.sessionId) dispose.mutate(item.sessionId)
                                  }}
                                >
                                  处置失联
                                </Button>
                              </Can>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={act.isPending}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  if (
                                    item.primaryAction === 'PREPARE' ||
                                    item.primaryAction === 'VERIFY_AUTH' ||
                                    item.primaryAction === 'LOGIN'
                                  ) {
                                    act.mutate({
                                      accountId: item.targetAccountId,
                                      sessionId: item.sessionId,
                                      generation: item.generation,
                                      kind: item.primaryAction,
                                    })
                                  }
                                }}
                              >
                                {PRIMARY_ACTION_LABELS[item.primaryAction] ?? '查看'}
                              </Button>
                            )}
                            {closable ? (
                              <Can permission="session:manage">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={act.isPending}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (item.sessionId && item.generation) {
                                      setClosing({
                                        accountId: item.targetAccountId,
                                        accountDisplayName: item.accountDisplayName,
                                        sessionId: item.sessionId,
                                        generation: item.generation,
                                      })
                                    }
                                  }}
                                >
                                  关闭会话
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
            <div className="flex justify-end border-t border-border-divider px-4 py-3">
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
      <ConfirmDialog
        open={Boolean(closing)}
        onOpenChange={(open) => {
          if (!open) setClosing(null)
        }}
        title="关闭会话"
        desc={`将关闭 ${target.data?.name ?? '该系统'} / ${closing?.accountDisplayName ?? '该账号'} 的会话实例，并保留登录 Profile。`}
        confirmText="确认关闭"
        destructive
        isLoading={act.isPending}
        handleConfirm={() => {
          if (!closing) return
          act.mutate({
            accountId: closing.accountId,
            sessionId: closing.sessionId,
            generation: closing.generation,
            kind: 'CLOSE',
          })
          setClosing(null)
        }}
      />
    </>
  )
}
