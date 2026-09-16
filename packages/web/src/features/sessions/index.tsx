import { useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { SessionOverviewFilter } from '@cairn/shared'
import { useSessionObservation } from './use-session-observation'
import { Search, Users, CheckCircle2, CircleHelp, Pin } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchSessionOverview,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
} from '@/lib/sessions-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
  PRIMARY_ACTION_LABELS,
  SESSION_FILTER_LABELS,
  sessionAuthLabel,
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

export function SessionsPage() {
  const page = useCursorPage(20, 'sessions-list')
  const observation = useSessionObservation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearchValue] = useState(() => sessionStorage.getItem('sessions-search') ?? '')
  const setSearch = (value: string) => {
    setSearchValue(value)
    sessionStorage.setItem('sessions-search', value)
  }
  const [filter, setFilterValue] = useState<SessionOverviewFilter | 'all'>(() => {
    const saved = sessionStorage.getItem('sessions-filter')
    return FILTERS.find((value) => value === saved) ?? 'all'
  })
  const setFilter = (value: SessionOverviewFilter | 'all') => {
    setFilterValue(value)
    sessionStorage.setItem('sessions-filter', value)
  }

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      filter: filter === 'all' ? undefined : filter,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, filter, page.pageSize, page.cursor],
  )

  const query = useQuery({
    queryKey: ['sessions-overview', filters],
    queryFn: () => fetchSessionOverview(filters),
    placeholderData: keepPreviousData,
  })

  const act = useMutation({
    mutationFn: (input: {
      targetId: string
      accountId: string
      sessionId: string | null
      generation: number | null
      kind: 'PREPARE' | 'VERIFY_AUTH' | 'LOGIN'
    }) =>
      requestAccountSessionOperation(input.targetId, input.accountId, {
        kind: input.kind,
        ...(input.sessionId && input.generation
          ? { expectedSessionId: input.sessionId, expectedGeneration: input.generation }
          : {}),
        idempotencyKey: newSessionIdempotencyKey(input.kind),
      }),
    onSuccess: async (result, variables) => {
      toast.success(result.reusedRunId ? '已转到运行认证等待' : '已提交会话操作')
      await queryClient.invalidateQueries({ queryKey: ['sessions-overview'] })
      if (result.reusedRunId) {
        await navigate({ to: '/runs/$runId', params: { runId: result.reusedRunId } })
        return
      }
      await navigate({
        to: '/sessions/$targetId/$accountId',
        params: { targetId: variables.targetId, accountId: variables.accountId },
      })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '提交失败')
    },
  })

  const items = query.data?.items ?? []
  const summary = query.data?.summary

  return (
    <>
      <AppHeader
        fixed
        leading={
          <span className="me-auto text-small text-muted-foreground">
            工作台 <span className="mx-2">/</span> 浏览器会话
          </span>
        }
      />
      <Main className="flex min-w-0 flex-1 flex-col gap-6">
        <PageHeader
          title="浏览器会话"
          description="按目标系统和账号查看准备、登录与保留状态。没有运行时也可以维护会话。"
        />
        {!observation.connected && query.data ? (
          <p role="status" className="text-small text-muted-foreground">
            连接已断开，正在恢复。最后状态：{new Date(query.data.asOf).toLocaleString()}
          </p>
        ) : null}
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title="无法加载会话总览" onRetry={() => void query.refetch()} />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  icon: <Users className="size-4" />,
                  label: '账号',
                  value: summary?.total ?? 0,
                  description: '已登记的目标账号',
                },
                {
                  icon: <CheckCircle2 className="size-4" />,
                  label: '可用',
                  value: summary?.available ?? 0,
                  description: '就绪且空闲',
                },
                {
                  icon: <CircleHelp className="size-4" />,
                  label: '待处理',
                  value: (summary?.needsCheck ?? 0) + (summary?.needsLogin ?? 0),
                  description: '待检查或需要登录',
                },
                {
                  icon: <Pin className="size-4" />,
                  label: '保留中',
                  value: summary?.retained ?? 0,
                  description: '后台维护的账号',
                },
              ]}
            />
            <section className="min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4">
                <div className="flex flex-wrap gap-1" aria-label="会话状态筛选">
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
                    aria-label="搜索目标或账号"
                    className="ps-9"
                    placeholder="搜索系统或账号"
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
                      <TableHead>目标系统</TableHead>
                      <TableHead>账号</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>登录核验</TableHead>
                      <TableHead>占用</TableHead>
                      <TableHead>保留</TableHead>
                      <TableHead className="w-36" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow
                        key={`${item.targetId}:${item.targetAccountId}`}
                        className="cursor-pointer"
                        onClick={() =>
                          void navigate({
                            to: '/sessions/$targetId/$accountId',
                            params: { targetId: item.targetId, accountId: item.targetAccountId },
                          })
                        }
                      >
                        <TableCell className="font-medium text-text-primary">{item.targetName}</TableCell>
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
                          {sessionAuthLabel(item.authState, item.identityState)}
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
                          ) : item.occupyingOperationId ? (
                            '维护占用'
                          ) : (
                            '空闲'
                          )}
                        </TableCell>
                        <TableCell className="text-label text-muted-foreground">
                          {item.retainUntil ? new Date(item.retainUntil).toLocaleString() : '—'}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              act.isPending ||
                              item.primaryAction === 'view' ||
                              item.primaryAction === 'dispose'
                            }
                            onClick={(event) => {
                              event.stopPropagation()
                              if (
                                item.primaryAction === 'PREPARE' ||
                                item.primaryAction === 'VERIFY_AUTH' ||
                                item.primaryAction === 'LOGIN'
                              ) {
                                act.mutate({
                                  targetId: item.targetId,
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
                        </TableCell>
                      </TableRow>
                    ))}
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
          </>
        )}
      </Main>
    </>
  )
}
