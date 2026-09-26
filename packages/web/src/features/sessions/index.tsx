import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { SessionOverviewFilter, SessionSystemOverviewFilter } from '@cairn/shared'
import { useSessionObservation } from './use-session-observation'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Search,
  Server,
  Zap,
} from 'lucide-react'
import { fetchSessionOverview, fetchSessionSystemOverview } from '@/lib/sessions-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
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
  SESSION_SYSTEM_FILTER_LABELS,
  sessionOccupancyLabel,
  sessionOverviewAuthLabel,
} from './labels'
import { SessionWorkbenchSheet } from './session-workbench-sheet'

const SYSTEMS_FILTERS: Array<SessionSystemOverviewFilter | 'all'> = [
  'all',
  'problem',
  'unprepared',
  'ready',
  'busy',
  'retained',
]

const STREAM_FILTERS: Array<SessionOverviewFilter | 'all'> = [
  'all',
  'needs_login',
  'identity_mismatch',
  'needs_check',
  'lost',
  'available',
  'executing',
  'maintenance',
  'unprepared',
  'retained',
]

export function SessionsPage() {
  const observation = useSessionObservation()
  const navigate = useNavigate()

  // 视图模式切换：默认为「待办与会话流」，兼顾按系统资产查看
  const [view, setView] = useState<'stream' | 'systems'>(() => {
    const saved = sessionStorage.getItem('sessions-active-view')
    if (saved === 'systems' || saved === 'stream') return saved
    if (sessionStorage.getItem('sessions-systems-list') && !sessionStorage.getItem('sessions-stream-list')) {
      return 'systems'
    }
    return 'stream'
  })
  const handleViewChange = (nextView: 'stream' | 'systems') => {
    setView(nextView)
    sessionStorage.setItem('sessions-active-view', nextView)
  }

  // 侧滑抽屉选中的会话
  const [activeSession, setActiveSession] = useState<{ targetId: string; accountId: string } | null>(null)

  // -------------------------------------------------------------
  // 1. 待办卡片带：拉取需要关注的账号（问题状态）
  // -------------------------------------------------------------
  const attentionQuery = useQuery({
    queryKey: ['sessions-attention'],
    queryFn: () => fetchSessionOverview({ limit: 100 }),
    placeholderData: keepPreviousData,
    enabled: view === 'stream',
  })
  const attentionItems = useMemo(() => {
    return (attentionQuery.data?.items ?? []).filter(
      (item) =>
        item.status === 'needs_login' ||
        item.status === 'identity_mismatch' ||
        item.status === 'needs_check' ||
        item.status === 'lost',
    )
  }, [attentionQuery.data?.items])

  // -------------------------------------------------------------
  // 2. 会话流（全量账号视图）
  // -------------------------------------------------------------
  const streamPage = useCursorPage(20, 'sessions-stream-list')
  const [streamSearch, setStreamSearchValue] = useState(() => sessionStorage.getItem('sessions-stream-search') ?? '')
  const setStreamSearch = (value: string) => {
    setStreamSearchValue(value)
    sessionStorage.setItem('sessions-stream-search', value)
  }
  const [streamFilter, setStreamFilterValue] = useState<SessionOverviewFilter | 'all'>(() => {
    const saved = sessionStorage.getItem('sessions-stream-filter')
    return STREAM_FILTERS.find((v) => v === saved) ?? 'all'
  })
  const setStreamFilter = (value: SessionOverviewFilter | 'all') => {
    setStreamFilterValue(value)
    sessionStorage.setItem('sessions-stream-filter', value)
  }
  const streamFilters = useMemo(
    () => ({
      search: streamSearch.trim() || undefined,
      filter: streamFilter === 'all' ? undefined : streamFilter,
      limit: streamPage.pageSize,
      cursor: streamPage.cursor || undefined,
    }),
    [streamSearch, streamFilter, streamPage.pageSize, streamPage.cursor],
  )
  const streamQuery = useQuery({
    queryKey: ['sessions-overview', streamFilters],
    queryFn: () => fetchSessionOverview(streamFilters),
    placeholderData: keepPreviousData,
    enabled: view === 'stream',
  })

  // -------------------------------------------------------------
  // 3. 按目标系统视图
  // -------------------------------------------------------------
  const systemsPage = useCursorPage(20, 'sessions-systems-list')
  const [systemsSearch, setSystemsSearchValue] = useState(() => sessionStorage.getItem('sessions-systems-search') ?? '')
  const setSystemsSearch = (value: string) => {
    setSystemsSearchValue(value)
    sessionStorage.setItem('sessions-systems-search', value)
  }
  const [systemsFilter, setSystemsFilterValue] = useState<SessionSystemOverviewFilter | 'all'>(() => {
    const saved = sessionStorage.getItem('sessions-systems-filter')
    return SYSTEMS_FILTERS.find((v) => v === saved) ?? 'all'
  })
  const setSystemsFilter = (value: SessionSystemOverviewFilter | 'all') => {
    setSystemsFilterValue(value)
    sessionStorage.setItem('sessions-systems-filter', value)
  }
  const systemsFilters = useMemo(
    () => ({
      search: systemsSearch.trim() || undefined,
      filter: systemsFilter === 'all' ? undefined : systemsFilter,
      limit: systemsPage.pageSize,
      cursor: systemsPage.cursor || undefined,
    }),
    [systemsSearch, systemsFilter, systemsPage.pageSize, systemsPage.cursor],
  )
  const systemsQuery = useQuery({
    queryKey: ['sessions-systems', systemsFilters],
    queryFn: () => fetchSessionSystemOverview(systemsFilters),
    placeholderData: keepPreviousData,
    enabled: view === 'systems',
  })

  const streamSummary = streamQuery.data?.summary
  const streamProblemCount =
    (streamSummary?.needsCheck ?? 0) +
    (streamSummary?.needsLogin ?? 0) +
    (streamSummary?.identityMismatch ?? 0) +
    (streamSummary?.lost ?? 0)

  const applySystemsFilter = (value: SessionSystemOverviewFilter | 'all') => {
    setSystemsFilter(value)
    systemsPage.reset()
  }

  const applyStreamFilter = (value: SessionOverviewFilter | 'all') => {
    setStreamFilter(value)
    streamPage.reset()
  }

  const currentAsOf = view === 'stream' ? streamQuery.data?.asOf : systemsQuery.data?.asOf

  return (
    <>
      <Main className="flex min-w-0 flex-1 flex-col gap-6">
        <PageHeader
          title="浏览器"
          description={
            view === 'stream'
              ? streamSummary
                ? `${streamSummary.available} 就绪 · ${streamProblemCount} 有问题 · ${streamSummary.unprepared} 未准备 · ${(streamSummary.maintenance ?? 0) + (streamSummary.executing ?? 0)} 占用中`
                : '全局会话工作台。一键接管受管浏览器，即时处理登录与巡检。'
              : '按目标系统统筹查看会话健康度与容量配额。'
          }
          actions={
            <div className="flex items-center rounded-lg border border-border-divider bg-muted/50 p-0.5">
              <Button
                variant={view === 'stream' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 gap-1.5 px-3 font-medium"
                onClick={() => handleViewChange('stream')}
              >
                <Zap className="size-3.5 text-primary" />
                待办与会话流
              </Button>
              <Button
                variant={view === 'systems' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 gap-1.5 px-3 font-medium"
                onClick={() => handleViewChange('systems')}
              >
                <Server className="size-3.5" />
                按目标系统
              </Button>
            </div>
          }
        />

        {!observation.connected && currentAsOf ? (
          <p role="status" className="text-small text-muted-foreground">
            连接已断开，正在恢复。最后状态：{new Date(currentAsOf).toLocaleString()}
          </p>
        ) : null}

        {/* ---------------- 模式 1：待办与会话流 ---------------- */}
        {view === 'stream' && (
          <>
            {/* 置顶待办微卡带：一眼发现并处理异常/需登录账号 */}
            {attentionItems.length > 0 ? (
              <section className="rounded-lg border border-status-warning-border/80 bg-status-warning-surface/30 p-4 shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <CircleAlert className="size-4 text-status-warning-foreground" />
                    <h2 className="text-small font-semibold text-foreground">
                      需要人工介入 ({attentionItems.length} 个账号)
                    </h2>
                    <span className="text-label text-muted-foreground hidden sm:inline">
                      验证码阻断、需重新登录、账号不符或失联
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {attentionItems.map((item) => (
                    <div
                      key={item.targetAccountId}
                      className="flex items-center justify-between gap-3 rounded-md border border-border-card bg-card p-3 shadow-xs hover:border-primary/50 transition-colors cursor-pointer"
                      onClick={() => setActiveSession({ targetId: item.targetId, accountId: item.targetAccountId })}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-body font-medium truncate" title={`${item.targetName} / ${item.accountDisplayName}`}>
                          {item.targetName} · {item.accountDisplayName}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[item.status]}>
                            {ACCOUNT_SESSION_STATUS_LABELS[item.status]}
                          </StatusBadge>
                          <code className="text-label text-muted-foreground truncate">{item.accountUsername}</code>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={item.status === 'needs_login' || item.status === 'identity_mismatch' ? 'default' : 'outline'}
                        className="shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          setActiveSession({ targetId: item.targetId, accountId: item.targetAccountId })
                        }}
                      >
                        {item.status === 'needs_login' || item.status === 'identity_mismatch'
                          ? '处理登录'
                          : item.status === 'lost'
                            ? '处置'
                            : '接管'}
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* 核心指标微卡 */}
            <CollectionSummary
              items={[
                {
                  icon: <Activity className="size-4" />,
                  label: '全部账号',
                  value: streamSummary?.total ?? 0,
                  description: '已纳管的全部业务账号',
                  pressed: streamFilter === 'all',
                  onClick: () => applyStreamFilter('all'),
                },
                {
                  icon: <CircleAlert className="size-4" />,
                  label: '待核验',
                  value: streamSummary?.needsCheck ?? 0,
                  description: '登录态过期或待确认',
                  pressed: streamFilter === 'needs_check',
                  onClick: () => applyStreamFilter('needs_check'),
                },
                {
                  icon: <AlertTriangle className="size-4" />,
                  label: '需要登录',
                  value: streamSummary?.needsLogin ?? 0,
                  description: '需要人工登录或续登',
                  pressed: streamFilter === 'needs_login',
                  onClick: () => applyStreamFilter('needs_login'),
                },
                {
                  icon: <CheckCircle2 className="size-4" />,
                  label: '空闲就绪',
                  value: streamSummary?.available ?? 0,
                  description: '当前可立即复用的就绪会话',
                  pressed: streamFilter === 'available',
                  onClick: () => applyStreamFilter('available'),
                },
              ]}
            />

            {/* 会话流主表格 */}
            {streamQuery.isPending ? (
              <PageSkeleton />
            ) : streamQuery.isError ? (
              <QueryErrorState title="无法加载会话流" onRetry={() => void streamQuery.refetch()} />
            ) : (
              <section className="min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4">
                  <div className="flex flex-wrap gap-1" aria-label="会话流筛选">
                    {STREAM_FILTERS.map((value) => (
                      <Button
                        key={value}
                        variant={streamFilter === value ? 'secondary' : 'ghost'}
                        size="sm"
                        aria-pressed={streamFilter === value}
                        onClick={() => applyStreamFilter(value)}
                      >
                        {SESSION_FILTER_LABELS[value]}
                      </Button>
                    ))}
                  </div>
                  <div className="relative w-full max-w-xs">
                    <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label="搜索会话"
                      className="ps-9"
                      placeholder="搜索系统名称、账号或用户名"
                      value={streamSearch}
                      onChange={(event) => {
                        setStreamSearch(event.target.value)
                        streamPage.reset()
                      }}
                    />
                  </div>
                </div>

                {(streamQuery.data?.items ?? []).length === 0 ? (
                  <EmptyState title="没有匹配的会话" description="换一个筛选条件，或在目标系统里登记账号。" />
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
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {streamQuery.data?.items.map((item) => (
                        <TableRow
                          key={item.targetAccountId}
                          className="cursor-pointer hover:bg-surface-subtle"
                          onClick={() => setActiveSession({ targetId: item.targetId, accountId: item.targetAccountId })}
                        >
                          <TableCell className="font-medium text-text-primary">
                            <div>{item.targetName}</div>
                          </TableCell>
                          <TableCell>
                            <div>{item.accountDisplayName}</div>
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
                              <p className="mt-1 text-label text-muted-foreground">保留中</p>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-label text-muted-foreground">
                            {sessionOverviewAuthLabel(item.status, item.authState, item.identityState)}
                            {item.lastAuthCheckedAt ? ` · ${new Date(item.lastAuthCheckedAt).toLocaleTimeString()}` : ''}
                          </TableCell>
                          <TableCell className="text-label">
                            {item.occupyingRunId ? (
                              <Link
                                className="underline hover:text-link"
                                to="/runs/$runId"
                                params={{ runId: item.occupyingRunId }}
                                onClick={(event) => event.stopPropagation()}
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
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(event) => {
                                event.stopPropagation()
                                setActiveSession({ targetId: item.targetId, accountId: item.targetAccountId })
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
                    pageIndex={streamPage.pageIndex}
                    pageSize={streamPage.pageSize}
                    hasPreviousPage={streamPage.pageIndex > 0}
                    hasNextPage={Boolean(streamQuery.data?.nextCursor)}
                    updating={streamQuery.isFetching && streamQuery.isPlaceholderData}
                    onPageSizeChange={streamPage.setPageSize}
                    onPreviousPage={streamPage.goPrev}
                    onNextPage={() => {
                      if (streamQuery.data?.nextCursor) streamPage.goNext(streamQuery.data.nextCursor)
                    }}
                  />
                </div>
              </section>
            )}
          </>
        )}

        {/* ---------------- 模式 2：按目标系统资产查看 ---------------- */}
        {view === 'systems' && (
          <>
            {systemsQuery.isPending ? (
              <PageSkeleton />
            ) : systemsQuery.isError ? (
              <QueryErrorState title="无法加载系统总览" onRetry={() => void systemsQuery.refetch()} />
            ) : (
              <>
                <CollectionSummary
                  items={[
                    {
                      icon: <Server className="size-4" />,
                      label: '系统',
                      value: systemsQuery.data?.summary?.systems ?? 0,
                      description: '已登记账号的目标系统',
                      pressed: systemsFilter === 'all',
                      onClick: () => applySystemsFilter('all'),
                    },
                    {
                      icon: <CircleAlert className="size-4" />,
                      label: '有问题',
                      value: systemsQuery.data?.summary?.problemAccounts ?? 0,
                      description: '待检查、需登录、不符或失联',
                      pressed: systemsFilter === 'problem',
                      onClick: () => applySystemsFilter('problem'),
                    },
                    {
                      icon: <CircleDashed className="size-4" />,
                      label: '未准备',
                      value: systemsQuery.data?.summary?.unpreparedAccounts ?? 0,
                      description: '还没有会话实例',
                      pressed: systemsFilter === 'unprepared',
                      onClick: () => applySystemsFilter('unprepared'),
                    },
                    {
                      icon: <CheckCircle2 className="size-4" />,
                      label: '就绪账号',
                      value: systemsQuery.data?.summary?.readyAccounts ?? 0,
                      description: '已就绪的账号数，不是全就绪系统',
                    },
                  ]}
                />
                <section className="min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4">
                    <div className="flex flex-wrap gap-1" aria-label="系统会话筛选">
                      {SYSTEMS_FILTERS.map((value) => (
                        <Button
                          key={value}
                          variant={systemsFilter === value ? 'secondary' : 'ghost'}
                          size="sm"
                          aria-pressed={systemsFilter === value}
                          onClick={() => applySystemsFilter(value)}
                        >
                          {SESSION_SYSTEM_FILTER_LABELS[value]}
                        </Button>
                      ))}
                    </div>
                    <div className="relative w-full max-w-xs">
                      <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        aria-label="搜索目标系统"
                        className="ps-9"
                        placeholder="搜索系统名称或编码"
                        value={systemsSearch}
                        onChange={(event) => {
                          setSystemsSearch(event.target.value)
                          systemsPage.reset()
                        }}
                      />
                    </div>
                  </div>
                  {(systemsQuery.data?.items ?? []).length === 0 ? (
                    <EmptyState title="没有匹配的目标系统" description="换一个筛选，或先在目标系统里登记账号。" />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>目标系统</TableHead>
                          <TableHead>账号数</TableHead>
                          <TableHead className="hidden md:table-cell">就绪</TableHead>
                          <TableHead className="hidden md:table-cell">有问题</TableHead>
                          <TableHead className="hidden md:table-cell">未准备</TableHead>
                          <TableHead>综合状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {systemsQuery.data?.items.map((item) => (
                          <TableRow
                            key={item.targetId}
                            className="cursor-pointer hover:bg-surface-subtle"
                            onClick={() =>
                              void navigate({
                                to: '/sessions/$targetId',
                                params: { targetId: item.targetId },
                              })
                            }
                          >
                            <TableCell className="font-medium text-text-primary">
                              <div>{item.targetName}</div>
                              <code className="text-label text-muted-foreground">{item.targetCode}</code>
                            </TableCell>
                            <TableCell className="tabular-nums">{item.accountTotal}</TableCell>
                            <TableCell className="hidden tabular-nums md:table-cell">{item.readyCount}</TableCell>
                            <TableCell className="hidden tabular-nums md:table-cell">{item.problemCount}</TableCell>
                            <TableCell className="hidden tabular-nums md:table-cell">{item.unpreparedCount}</TableCell>
                            <TableCell>
                              <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[item.worstStatus]}>
                                {ACCOUNT_SESSION_STATUS_LABELS[item.worstStatus]}
                              </StatusBadge>
                              <p className="mt-1 text-label text-muted-foreground md:hidden">
                                就绪 {item.readyCount} · 有问题 {item.problemCount} · 未准备 {item.unpreparedCount}
                              </p>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <div className="flex justify-end border-t border-border-divider px-4 py-3">
                    <CursorPagination
                      pageIndex={systemsPage.pageIndex}
                      pageSize={systemsPage.pageSize}
                      hasPreviousPage={systemsPage.pageIndex > 0}
                      hasNextPage={Boolean(systemsQuery.data?.nextCursor)}
                      updating={systemsQuery.isFetching && systemsQuery.isPlaceholderData}
                      onPageSizeChange={systemsPage.setPageSize}
                      onPreviousPage={systemsPage.goPrev}
                      onNextPage={() => {
                        if (systemsQuery.data?.nextCursor) systemsPage.goNext(systemsQuery.data.nextCursor)
                      }}
                    />
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </Main>

      {/* 侧滑抽屉工作台：点击任意账号即地接管画面，无需页面跳转 */}
      <SessionWorkbenchSheet
        open={Boolean(activeSession)}
        onOpenChange={(open) => {
          if (!open) setActiveSession(null)
        }}
        targetId={activeSession?.targetId}
        accountId={activeSession?.accountId}
      />
    </>
  )
}
