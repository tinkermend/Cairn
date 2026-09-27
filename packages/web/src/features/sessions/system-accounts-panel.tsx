import { Fragment, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  canCloseAccountSession,
  isFilterAllowedInBucket,
  type SessionOverviewFilter,
} from '@cairn/shared'
import { ChevronRight, Search } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchSessionOverview,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
} from '@/lib/sessions-api'
import { disposeWorkerSession } from '@/lib/workers-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  ACCOUNT_SESSION_BUCKET_LABELS,
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
  PRIMARY_ACTION_LABELS,
  SECONDARY_FILTER_OPTIONS,
  sessionOccupancyLabel,
  sessionOverviewAuthLabel,
  type AccountSessionBucketTab,
} from './labels'
import { AccountInstancesSubtable } from './account-instances-subtable'

const BUCKET_TABS: AccountSessionBucketTab[] = ['all', 'problem', 'ready', 'busy', 'unprepared']

export interface SystemAccountsPanelProps {
  targetId: string
  targetName: string
  targetCode?: string
  onOpenWorkbench?: (accountId: string) => void
}

export function SystemAccountsPanel({
  targetId,
  targetName,
  onOpenWorkbench,
}: SystemAccountsPanelProps) {
  const queryClient = useQueryClient()
  const page = useCursorPage(10, `sessions-accounts-list-${targetId}`)
  const searchKey = `sessions-accounts-search-${targetId}`
  const bucketKey = `sessions-accounts-bucket-${targetId}`
  const filterKey = `sessions-accounts-filter-${targetId}`
  const retainedKey = `sessions-accounts-retained-${targetId}`

  const [search, setSearchValue] = useState(() => sessionStorage.getItem(searchKey) ?? '')
  const setSearch = (value: string) => {
    setSearchValue(value)
    sessionStorage.setItem(searchKey, value)
  }

  const [bucket, setBucketValue] = useState<AccountSessionBucketTab>(() => {
    const saved = sessionStorage.getItem(bucketKey) as AccountSessionBucketTab | null
    return saved && BUCKET_TABS.includes(saved) ? saved : 'all'
  })
  const setBucket = (val: AccountSessionBucketTab) => {
    setBucketValue(val)
    sessionStorage.setItem(bucketKey, val)
  }

  const [filter, setFilterValue] = useState<SessionOverviewFilter | undefined>(() => {
    const saved = sessionStorage.getItem(filterKey) as SessionOverviewFilter | null
    return saved && isFilterAllowedInBucket(bucket, saved) ? saved : undefined
  })
  const setFilter = (val: SessionOverviewFilter | undefined) => {
    setFilterValue(val)
    if (val) {
      sessionStorage.setItem(filterKey, val)
    } else {
      sessionStorage.removeItem(filterKey)
    }
  }

  const [retained, setRetainedValue] = useState<boolean>(() => {
    return sessionStorage.getItem(retainedKey) === 'true'
  })
  const setRetained = (val: boolean) => {
    setRetainedValue(val)
    sessionStorage.setItem(retainedKey, String(val))
  }

  const [expandedAccountIds, setExpandedAccountIds] = useState<Set<string>>(new Set())
  const toggleExpand = (accountId: string) => {
    setExpandedAccountIds((prev) => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
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
      bucket: bucket === 'all' ? undefined : bucket,
      filter: filter || undefined,
      retained: retained ? true : undefined,
      limit: page.pageSize,
      cursor: page.cursor || undefined,
    }),
    [targetId, search, bucket, filter, retained, page.pageSize, page.cursor],
  )

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
      toast.success(
        result.reusedRunId
          ? '已转到运行认证等待'
          : variables.kind === 'CLOSE'
            ? '已提交关闭'
            : '已提交会话操作',
      )
      await invalidate()
      if (variables.kind !== 'CLOSE') {
        onOpenWorkbench?.(variables.accountId)
      }
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '提交失败')
    },
  })

  const dispose = useMutation({
    mutationFn: (sessionId: string) =>
      disposeWorkerSession(sessionId, { note: '系统会话展开区处置失联实例' }),
    onSuccess: async () => {
      toast.success('已提交处置')
      await invalidate()
    },
    onError: (error) => toast.error(error instanceof ApiRequestError ? error.message : '处置失败'),
  })

  const handleBucketChange = (nextBucket: AccountSessionBucketTab) => {
    setBucket(nextBucket)
    if (filter && !isFilterAllowedInBucket(nextBucket, filter)) {
      setFilter(undefined)
    }
    page.reset()
  }

  const secondaryOptions =
    bucket === 'problem'
      ? SECONDARY_FILTER_OPTIONS.problem
      : bucket === 'busy'
        ? SECONDARY_FILTER_OPTIONS.busy
        : null

  return (
    <div className="border-t border-border-divider bg-muted/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {BUCKET_TABS.map((tab) => (
            <Button
              key={tab}
              variant={bucket === tab ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 text-label"
              onClick={() => handleBucketChange(tab)}
            >
              {ACCOUNT_SESSION_BUCKET_LABELS[tab]}
            </Button>
          ))}

          {secondaryOptions ? (
            <Select
              value={filter ?? 'all'}
              onValueChange={(val) => {
                setFilter(val === 'all' ? undefined : (val as SessionOverviewFilter))
                page.reset()
              }}
            >
              <SelectTrigger className="h-8 w-32 text-label">
                <SelectValue placeholder="全部细分" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  全部{bucket === 'problem' ? '需关注' : '占用中'}
                </SelectItem>
                {secondaryOptions.map((opt: { value: SessionOverviewFilter; label: string }) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <label className="flex items-center gap-1.5 ms-2 text-label cursor-pointer text-muted-foreground select-none">
            <Checkbox
              checked={retained}
              onCheckedChange={(checked) => {
                setRetained(Boolean(checked))
                page.reset()
              }}
            />
            仅看保留中
          </label>
        </div>

        <div className="relative w-full max-w-xs">
          <Search className="absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索账号"
            className="h-8 ps-8 text-label"
            placeholder={`在 ${targetName} 中搜索账号`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              page.reset()
            }}
          />
        </div>
      </div>

      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <QueryErrorState title="无法加载账号列表" onRetry={() => void query.refetch()} />
      ) : (query.data?.items ?? []).length === 0 ? (
        <EmptyState title="没有匹配的账号会话" description="换一个筛选条件，或在系统里登记账号。" />
      ) : (
        <div className="overflow-hidden rounded-md border border-border-card bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow className="h-9">
                <TableHead className="w-10" />
                <TableHead>账号</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>节点</TableHead>
                <TableHead>登录核验</TableHead>
                <TableHead>占用</TableHead>
                <TableHead>保留</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data?.items.map((item) => {
                const canExpand = item.effectiveCap > 1 && item.liveCount >= 1
                const isExpanded = expandedAccountIds.has(item.targetAccountId)
                const closable =
                  item.liveCount <= 1 &&
                  item.sessionId &&
                  item.generation &&
                  canCloseAccountSession({ status: item.status, sessionId: item.sessionId })

                return (
                  <Fragment key={item.targetAccountId}>
                    <TableRow
                      className="cursor-pointer hover:bg-surface-subtle"
                      onClick={() => onOpenWorkbench?.(item.targetAccountId)}
                    >
                      <TableCell className="p-2 text-center" onClick={(e) => e.stopPropagation()}>
                        {canExpand ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 p-0 text-muted-foreground hover:text-foreground"
                            aria-label={isExpanded ? '收起实例' : '展开实例'}
                            onClick={() => toggleExpand(item.targetAccountId)}
                          >
                            <ChevronRight
                              className={`size-3.5 transition-transform duration-150 ${
                                isExpanded ? 'rotate-90' : ''
                              }`}
                            />
                          </Button>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-text-primary">{item.accountDisplayName}</div>
                        <code className="text-label text-muted-foreground">{item.accountUsername}</code>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[item.status]}>
                            {ACCOUNT_SESSION_STATUS_LABELS[item.status]}
                          </StatusBadge>
                          {item.effectiveCap > 1 ? (
                            <span className="tabular-nums text-label text-muted-foreground">
                              {item.liveCount}/{item.effectiveCap}
                            </span>
                          ) : null}
                        </div>
                        {item.retained ? (
                          <p className="mt-0.5 text-label text-muted-foreground">保留中</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {item.ownerWorkerId ? (
                          <div className="flex items-center gap-1.5 text-label">
                            <span
                              className={`size-2 rounded-full ${
                                item.ownerWorkerOnline
                                  ? 'bg-status-success-foreground'
                                  : 'bg-muted-foreground/40'
                              }`}
                              title={item.ownerWorkerOnline ? 'Worker 在线' : 'Worker 离线'}
                            />
                            <Link
                              to="/workers/$workerId"
                              params={{ workerId: item.ownerWorkerId }}
                              className="hover:text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {item.ownerWorkerLabel || item.ownerWorkerId}
                            </Link>
                            {item.liveWorkerCount > 1 ? (
                              <span className="text-label text-muted-foreground">
                                等 {item.liveWorkerCount} 个节点
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-label text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-label text-muted-foreground">
                        {sessionOverviewAuthLabel(item.status, item.authState, item.identityState)}
                        {item.lastAuthCheckedAt
                          ? ` · ${new Date(item.lastAuthCheckedAt).toLocaleTimeString()}`
                          : ''}
                      </TableCell>
                      <TableCell className="text-label">
                        {item.occupyingRunId ? (
                          <Link
                            className="underline hover:text-link"
                            to="/runs/$runId"
                            params={{ runId: item.occupyingRunId }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            运行 {item.occupyingRunId.slice(0, 8)}
                          </Link>
                        ) : (
                          sessionOccupancyLabel(item)
                        )}
                      </TableCell>
                      <TableCell className="text-label text-muted-foreground">
                        {item.retainUntil ? new Date(item.retainUntil).toLocaleTimeString() : '—'}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          {item.primaryAction === 'dispose' ? (
                            <Can permission="session:dispose">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-label"
                                disabled={dispose.isPending || !item.sessionId}
                                onClick={() => {
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
                              className="h-7 px-2 text-label"
                              onClick={() => {
                                if (item.primaryAction === 'view') {
                                  onOpenWorkbench?.(item.targetAccountId)
                                } else if (
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
                                } else {
                                  onOpenWorkbench?.(item.targetAccountId)
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
                                className="h-7 px-2 text-label text-muted-foreground hover:text-foreground"
                                onClick={() =>
                                  setClosing({
                                    accountId: item.targetAccountId,
                                    accountDisplayName: item.accountDisplayName,
                                    sessionId: item.sessionId!,
                                    generation: item.generation!,
                                  })
                                }
                              >
                                关闭会话
                              </Button>
                            </Can>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>

                    {canExpand && isExpanded ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="p-0">
                          <AccountInstancesSubtable
                            targetId={targetId}
                            accountId={item.targetAccountId}
                            onOpenWorkbench={onOpenWorkbench}
                            onChanged={invalidate}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>

          <div className="flex justify-end border-t border-border-divider px-4 py-2">
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

      <ConfirmDialog
        open={Boolean(closing)}
        onOpenChange={(open) => !open && setClosing(null)}
        title="确认关闭此账号会话？"
        desc={
          closing
            ? `将关闭 ${closing.accountDisplayName} 的受管会话。`
            : ''
        }
        confirmText="关闭会话"
        destructive
        isLoading={act.isPending}
        handleConfirm={() => {
          if (closing) {
            act.mutate({
              accountId: closing.accountId,
              sessionId: closing.sessionId,
              generation: closing.generation,
              kind: 'CLOSE',
            })
            setClosing(null)
          }
        }}
      />
    </div>
  )
}
