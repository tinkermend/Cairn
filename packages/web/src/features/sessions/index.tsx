import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  isFilterAllowedInBucket,
  type SessionOverviewFilter,
  type SessionSystemOverviewFilter,
} from '@cairn/shared'
import { useSessionObservation } from './use-session-observation'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Search,
  Server,
  Zap,
} from 'lucide-react'
import { fetchSessionOverview, fetchSessionSystemOverview } from '@/lib/sessions-api'
import { fetchTarget } from '@/lib/targets-api'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ACCOUNT_SESSION_BUCKET_LABELS,
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
  PRIMARY_ACTION_LABELS,
  SECONDARY_FILTER_OPTIONS,
  SESSION_SYSTEM_FILTER_LABELS,
  sessionOccupancyLabel,
  sessionOverviewAuthLabel,
  type AccountSessionBucketTab,
} from './labels'
import { SessionWorkbenchSheet } from './session-workbench-sheet'
import { AccountInstancesSubtable } from './account-instances-subtable'
import { SystemAccountsPanel } from './system-accounts-panel'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'

const BUCKET_TABS: AccountSessionBucketTab[] = ['all', 'problem', 'ready', 'busy', 'unprepared']

const SYSTEMS_FILTERS: Array<SessionSystemOverviewFilter | 'all'> = [
  'all',
  'problem',
  'unprepared',
  'ready',
  'busy',
  'retained',
]

function SessionSystemsAssistantBinding({ targetId, targetName }: { targetId: string; targetName: string }) {
  useAssistantContextBinding({
    page: 'session',
    routeKey: 'sessions.index.systems',
    targetId,
    statusLabel: '目标账号会话',
    summaryText: `目标系统「${targetName}」的账号会话列表`,
    statusTone: 'neutral',
  })
  return null
}

function getInitialStreamFilterState(): {
  bucket: AccountSessionBucketTab
  filter: SessionOverviewFilter | undefined
  retained: boolean
} {
  const savedBucket = sessionStorage.getItem('sessions-stream-bucket') as AccountSessionBucketTab | null
  const savedFilter = sessionStorage.getItem('sessions-stream-filter') as SessionOverviewFilter | null
  const savedRetained = sessionStorage.getItem('sessions-stream-retained') === 'true'

  if (savedBucket && BUCKET_TABS.includes(savedBucket)) {
    return {
      bucket: savedBucket,
      filter: savedFilter && isFilterAllowedInBucket(savedBucket, savedFilter) ? savedFilter : undefined,
      retained: savedRetained,
    }
  }

  // 兼容迁移旧 flat filter
  const legacy = sessionStorage.getItem('sessions-stream-filter')
  if (legacy === 'available') {
    return { bucket: 'ready', filter: undefined, retained: false }
  }
  if (legacy === 'retained') {
    return { bucket: 'all', filter: undefined, retained: true }
  }
  if (['needs_login', 'needs_check', 'identity_mismatch', 'lost'].includes(legacy as string)) {
    return { bucket: 'problem', filter: legacy as SessionOverviewFilter, retained: false }
  }
  if (['executing', 'maintenance'].includes(legacy as string)) {
    return { bucket: 'busy', filter: legacy as SessionOverviewFilter, retained: false }
  }
  if (legacy === 'unprepared') {
    return { bucket: 'unprepared', filter: undefined, retained: false }
  }
  return { bucket: 'all', filter: undefined, retained: false }
}

export function SessionsPage() {
  const observation = useSessionObservation()
  const navigate = useNavigate()
  const searchParams = useSearch({ strict: false }) as {
    view?: 'stream' | 'systems'
    targetId?: string
  }

  // 视图模式：URL 参数 > sessionStorage > 默认 'stream'
  const [view, setView] = useState<'stream' | 'systems'>(() => {
    if (searchParams.targetId) return 'systems'
    if (searchParams.view === 'systems' || searchParams.view === 'stream') return searchParams.view
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
    void navigate({
      to: '/sessions',
      search: (prev: any) => ({ ...prev, view: nextView }),
      replace: true,
    })
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
  // 2. 会话流（分层筛选与多实例展开）
  // -------------------------------------------------------------
  const streamPage = useCursorPage(20, 'sessions-stream-list')
  const [streamSearch, setStreamSearchValue] = useState(() => sessionStorage.getItem('sessions-stream-search') ?? '')
  const setStreamSearch = (value: string) => {
    setStreamSearchValue(value)
    sessionStorage.setItem('sessions-stream-search', value)
  }

  const initialFilter = useMemo(() => getInitialStreamFilterState(), [])
  const [streamBucket, setStreamBucketValue] = useState<AccountSessionBucketTab>(initialFilter.bucket)
  const setStreamBucket = (val: AccountSessionBucketTab) => {
    setStreamBucketValue(val)
    sessionStorage.setItem('sessions-stream-bucket', val)
  }

  const [streamFilter, setStreamFilterValue] = useState<SessionOverviewFilter | undefined>(initialFilter.filter)
  const setStreamFilter = (val: SessionOverviewFilter | undefined) => {
    setStreamFilterValue(val)
    if (val) {
      sessionStorage.setItem('sessions-stream-filter', val)
    } else {
      sessionStorage.removeItem('sessions-stream-filter')
    }
  }

  const [streamRetained, setStreamRetainedValue] = useState<boolean>(initialFilter.retained)
  const setStreamRetained = (val: boolean) => {
    setStreamRetainedValue(val)
    sessionStorage.setItem('sessions-stream-retained', String(val))
  }

  const [expandedStreamAccounts, setExpandedStreamAccounts] = useState<Set<string>>(new Set())
  const toggleStreamAccount = (accountId: string) => {
    setExpandedStreamAccounts((prev) => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  const streamFilters = useMemo(
    () => ({
      search: streamSearch.trim() || undefined,
      bucket: streamBucket === 'all' ? undefined : streamBucket,
      filter: streamFilter || undefined,
      retained: streamRetained ? true : undefined,
      limit: streamPage.pageSize,
      cursor: streamPage.cursor || undefined,
    }),
    [streamSearch, streamBucket, streamFilter, streamRetained, streamPage.pageSize, streamPage.cursor],
  )
  const streamQuery = useQuery({
    queryKey: ['sessions-overview', streamFilters],
    queryFn: () => fetchSessionOverview(streamFilters),
    placeholderData: keepPreviousData,
    enabled: view === 'stream',
  })

  // -------------------------------------------------------------
  // 3. 按目标系统视图（原地展开 M3）
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

  // 原地展开的目标系统（最多 3 个）
  const [expandedTargetIds, setExpandedTargetIds] = useState<string[]>(() => {
    return searchParams.targetId ? [searchParams.targetId] : []
  })

  useEffect(() => {
    if (searchParams.targetId && !expandedTargetIds.includes(searchParams.targetId)) {
      setExpandedTargetIds((prev) => [...prev.slice(-2), searchParams.targetId!])
    }
  }, [searchParams.targetId])

  // 从旧的 /sessions/$targetId 跳转过来时，如果该系统不在当前列表页（被筛选或翻页挡住），
  // 自动把搜索框填成它的名字并清空筛选，保证用户看得见（§4.5(1)）；每个 targetId 只自动定位一次，
  // 避免和用户之后自己修改搜索/筛选打架。
  const targetLocateAttempted = useRef<string | null>(null)
  const targetNameQuery = useQuery({
    queryKey: ['target-name', searchParams.targetId],
    queryFn: () => fetchTarget(searchParams.targetId!),
    enabled: view === 'systems' && Boolean(searchParams.targetId),
    retry: false,
  })

  useEffect(() => {
    const targetId = searchParams.targetId
    if (!targetId || view !== 'systems' || !systemsQuery.data) return
    if (targetLocateAttempted.current === targetId) return
    const visible = systemsQuery.data.items.some((item) => item.targetId === targetId)
    if (visible) {
      targetLocateAttempted.current = targetId
      return
    }
    if (!targetNameQuery.data) return
    targetLocateAttempted.current = targetId
    if (systemsFilter !== 'all') applySystemsFilter('all')
    if (systemsSearch.trim() !== targetNameQuery.data.name) {
      setSystemsSearch(targetNameQuery.data.name)
      systemsPage.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.targetId, view, systemsQuery.data, targetNameQuery.data])

  // 定位到目标系统所在行并滚动可见
  const targetRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  useEffect(() => {
    const targetId = searchParams.targetId
    if (!targetId || view !== 'systems') return
    const row = targetRowRefs.current.get(targetId)
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchParams.targetId, view, systemsQuery.data])

  const toggleTargetExpand = (targetId: string) => {
    setExpandedTargetIds((prev) => {
      if (prev.includes(targetId)) {
        return prev.filter((id) => id !== targetId)
      }
      return [...prev.slice(-2), targetId]
    })
  }

  const streamSummary = streamQuery.data?.summary
  const streamProblemCount =
    streamSummary?.problem ??
    ((streamSummary?.needsCheck ?? 0) +
      (streamSummary?.needsLogin ?? 0) +
      (streamSummary?.identityMismatch ?? 0) +
      (streamSummary?.lost ?? 0))
  const streamBusyCount =
    streamSummary?.busy ??
    ((streamSummary?.maintenance ?? 0) + (streamSummary?.executing ?? 0))

  const handleBucketTabChange = (nextBucket: AccountSessionBucketTab) => {
    setStreamBucket(nextBucket)
    if (streamFilter && !isFilterAllowedInBucket(nextBucket, streamFilter)) {
      setStreamFilter(undefined)
    }
    streamPage.reset()
  }

  const applySystemsFilter = (value: SessionSystemOverviewFilter | 'all') => {
    setSystemsFilter(value)
    systemsPage.reset()
  }

  const currentAsOf = view === 'stream' ? streamQuery.data?.asOf : systemsQuery.data?.asOf
  const secondaryStreamOptions =
    streamBucket === 'problem'
      ? SECONDARY_FILTER_OPTIONS.problem
      : streamBucket === 'busy'
        ? SECONDARY_FILTER_OPTIONS.busy
        : null

  return (
    <>
      {!activeSession && view === 'systems' && searchParams.targetId &&
        targetNameQuery.data?.id === searchParams.targetId ? (
          <SessionSystemsAssistantBinding
            targetId={searchParams.targetId}
            targetName={targetNameQuery.data.name}
          />
        ) : null}
      <Main className="flex min-w-0 flex-1 flex-col gap-6">
        <PageHeader
          title="账号会话"
          description={
            view === 'stream'
              ? streamSummary
                ? `${streamSummary.available} 就绪 · ${streamProblemCount} 有问题 · ${streamSummary.unprepared} 未准备 · ${streamBusyCount} 占用中`
                : '全局会话工作台：接管会话、处理登录与巡检。'
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

            {/* 核心指标微卡（与 4 桶严格对齐） */}
            <CollectionSummary
              items={[
                {
                  icon: <Activity className="size-4" />,
                  label: '全部账号',
                  value: streamSummary?.total ?? 0,
                  description: '已纳管的全部业务账号',
                  pressed: streamBucket === 'all',
                  onClick: () => handleBucketTabChange('all'),
                },
                {
                  icon: <AlertTriangle className="size-4 text-status-warning-foreground" />,
                  label: '需关注',
                  value: streamProblemCount,
                  description: '待检查、需登录、不符或失联',
                  pressed: streamBucket === 'problem',
                  onClick: () => handleBucketTabChange('problem'),
                },
                {
                  icon: <CheckCircle2 className="size-4 text-status-success-foreground" />,
                  label: '已就绪',
                  value: streamSummary?.available ?? 0,
                  description: '当前可立即复用的就绪会话',
                  pressed: streamBucket === 'ready',
                  onClick: () => handleBucketTabChange('ready'),
                },
                {
                  icon: <CircleDashed className="size-4" />,
                  label: '占用中',
                  value: streamBusyCount,
                  description: '正在执行任务或维护中',
                  pressed: streamBucket === 'busy',
                  onClick: () => handleBucketTabChange('busy'),
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
                  <div className="flex flex-wrap items-center gap-2" aria-label="会话流筛选">
                    {BUCKET_TABS.map((tab) => (
                      <Button
                        key={tab}
                        variant={streamBucket === tab ? 'secondary' : 'ghost'}
                        size="sm"
                        aria-pressed={streamBucket === tab}
                        onClick={() => handleBucketTabChange(tab)}
                      >
                        {ACCOUNT_SESSION_BUCKET_LABELS[tab]}
                      </Button>
                    ))}

                    {secondaryStreamOptions ? (
                      <Select
                        value={streamFilter ?? 'all'}
                        onValueChange={(val) => {
                          setStreamFilter(val === 'all' ? undefined : (val as SessionOverviewFilter))
                          streamPage.reset()
                        }}
                      >
                        <SelectTrigger className="h-8 w-32 text-label" aria-label="细分状态筛选">
                          <SelectValue placeholder="全部细分" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">
                            全部{streamBucket === 'problem' ? '需关注' : '占用中'}
                          </SelectItem>
                          {secondaryStreamOptions.map((opt: { value: SessionOverviewFilter; label: string }) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}

                    <label className="flex items-center gap-1.5 ms-2 text-label cursor-pointer text-muted-foreground select-none">
                      <Checkbox
                        checked={streamRetained}
                        onCheckedChange={(checked) => {
                          setStreamRetained(Boolean(checked))
                          streamPage.reset()
                        }}
                      />
                      仅看保留中
                    </label>
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
                        <TableHead className="w-10" />
                        <TableHead>目标系统</TableHead>
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
                      {streamQuery.data?.items.map((item) => {
                        const canExpand = item.effectiveCap > 1 && item.liveCount >= 1
                        const isExpanded = expandedStreamAccounts.has(item.targetAccountId)

                        return (
                          <Fragment key={item.targetAccountId}>
                            <TableRow
                              className="cursor-pointer hover:bg-surface-subtle"
                              onClick={() => setActiveSession({ targetId: item.targetId, accountId: item.targetAccountId })}
                            >
                              <TableCell className="p-2 text-center" onClick={(e) => e.stopPropagation()}>
                                {canExpand ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-6 p-0 text-muted-foreground hover:text-foreground"
                                    aria-label={isExpanded ? '收起实例' : '展开实例'}
                                    onClick={() => toggleStreamAccount(item.targetAccountId)}
                                  >
                                    <ChevronRight
                                      className={`size-3.5 transition-transform duration-150 ${
                                        isExpanded ? 'rotate-90' : ''
                                      }`}
                                    />
                                  </Button>
                                ) : null}
                              </TableCell>
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

                            {canExpand && isExpanded ? (
                              <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={9} className="p-0">
                                  <AccountInstancesSubtable
                                    targetId={item.targetId}
                                    accountId={item.targetAccountId}
                                    onOpenWorkbench={(accId) =>
                                      setActiveSession({ targetId: item.targetId, accountId: accId })
                                    }
                                    onChanged={() => void streamQuery.refetch()}
                                  />
                                </TableCell>
                              </TableRow>
                            ) : null}
                          </Fragment>
                        )
                      })}
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

        {/* ---------------- 模式 2：按目标系统资产查看（原地展开 M3） ---------------- */}
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
                          <TableHead className="w-10" />
                          <TableHead>目标系统</TableHead>
                          <TableHead>账号数</TableHead>
                          <TableHead className="hidden md:table-cell">就绪</TableHead>
                          <TableHead className="hidden md:table-cell">有问题</TableHead>
                          <TableHead className="hidden md:table-cell">未准备</TableHead>
                          <TableHead>综合状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {systemsQuery.data?.items.map((item) => {
                          const isExpanded = expandedTargetIds.includes(item.targetId)

                          return (
                            <Fragment key={item.targetId}>
                              <TableRow
                                ref={(el) => {
                                  if (el) targetRowRefs.current.set(item.targetId, el)
                                  else targetRowRefs.current.delete(item.targetId)
                                }}
                                className="cursor-pointer hover:bg-surface-subtle"
                                onClick={() => toggleTargetExpand(item.targetId)}
                              >
                                <TableCell className="p-2 text-center" onClick={(e) => e.stopPropagation()}>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-6 p-0 text-muted-foreground hover:text-foreground"
                                    aria-label={isExpanded ? '收起系统账号' : '展开系统账号'}
                                    onClick={() => toggleTargetExpand(item.targetId)}
                                  >
                                    <ChevronRight
                                      className={`size-3.5 transition-transform duration-150 ${
                                        isExpanded ? 'rotate-90' : ''
                                      }`}
                                    />
                                  </Button>
                                </TableCell>
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

                              {isExpanded ? (
                                <TableRow className="hover:bg-transparent">
                                  <TableCell colSpan={7} className="p-0">
                                    <SystemAccountsPanel
                                      targetId={item.targetId}
                                      targetName={item.targetName}
                                      targetCode={item.targetCode}
                                      onOpenWorkbench={(accountId) =>
                                        setActiveSession({ targetId: item.targetId, accountId })
                                      }
                                    />
                                  </TableCell>
                                </TableRow>
                              ) : null}
                            </Fragment>
                          )
                        })}
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
