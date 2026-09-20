import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import { BrowserView } from '@/features/runs/browser-view'
import { useSessionObservation } from './use-session-observation'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { canCloseAccountSession, hasPermission } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchAccountSession,
  fetchAccountSessionEvents,
  fetchSessionOperation,
  cancelSessionOperation,
  sessionBrowserTransport,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
  setAccountSessionRetention,
} from '@/lib/sessions-api'
import { disposeWorkerSession } from '@/lib/workers-api'
import { useAuthStore } from '@/stores/auth-store'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AUTH_CAPABILITY_LABELS } from '@/features/targets/labels'
import { SESSION_MAINTENANCE_ERROR_MESSAGES } from '@cairn/shared'
import {
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
  OPERATION_KIND_LABELS,
  PRIMARY_ACTION_LABELS,
  groupSessionEventsByActivity,
  resolveSessionEvent,
  sessionAuthLabel,
  sessionEventLabel,
} from './labels'

const operationTransport = sessionBrowserTransport('operation')
const instanceTransport = sessionBrowserTransport('session')
const operationStatusLabels: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  WAITING_FOR_AUTH: '等待人工认证',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  SUBMITTING: '已提交',
}
const IN_FLIGHT_OPERATION = new Set(['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH'])

export function sessionOperationProgress(input: {
  submittingKind?: string | null
  currentKind?: string | null
  currentStatus?: string | null
}): { kind: string; status: string } | null {
  if (input.submittingKind) return { kind: input.submittingKind, status: 'SUBMITTING' }
  if (input.currentKind && input.currentStatus && IN_FLIGHT_OPERATION.has(input.currentStatus)) {
    return { kind: input.currentKind, status: input.currentStatus }
  }
  return null
}

export function sessionRetentionHint(input: {
  retained: boolean
  retainUntil?: string | null
  quotaUsed?: number
  quotaLimit?: number
}): string {
  const quota =
    input.quotaUsed != null && input.quotaLimit != null
      ? `配额 ${input.quotaUsed}/${input.quotaLimit}`
      : null
  if (input.retained && input.retainUntil) {
    const until = `截止 ${new Date(input.retainUntil).toLocaleString()}`
    return quota ? `${until} · ${quota}` : until
  }
  if (quota) return `未设置保留。当前节点${quota}。只有打开的实例可以占用节点配额。`
  return '未设置保留。只有打开的实例可以占用节点配额。'
}

const route = getRouteApi('/_authenticated/sessions/$targetId/$accountId/')

export function SessionDetailPage() {
  const { targetId, accountId } = route.useParams()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const observation = useSessionObservation(targetId, accountId)
  const [requestedId, setRequestedId] = useState<string | null>(null)
  const [eventCursors, setEventCursors] = useState<(string | undefined)[]>([undefined])
  const eventCursor = eventCursors[eventCursors.length - 1]
  const permissions = useAuthStore((state) => state.auth.user?.permissions ?? [])
  const [retainSeconds, setRetainSeconds] = useState(3600)
  const [confirmKind, setConfirmKind] = useState<'CLOSE' | 'RESTART' | 'RESET_PROFILE' | null>(null)
  const [eventFilter, setEventFilter] = useState<'all' | 'operation' | 'signal' | 'retention'>('all')
  const [copiedId, setCopiedId] = useState(false)
  const [expandedActivities, setExpandedActivities] = useState<Record<string, boolean>>({})
  const [expandedSubSignals, setExpandedSubSignals] = useState<Record<string, boolean>>({})

  const detail = useQuery({
    queryKey: ['account-session', targetId, accountId],
    queryFn: () => fetchAccountSession(targetId, accountId),
  })
  const events = useQuery({
    queryKey: ['account-session-events', targetId, accountId, eventCursor],
    queryFn: () => fetchAccountSessionEvents(targetId, accountId, eventCursor),
  })
  const operationId = detail.data?.currentOperation?.id ?? requestedId
  const operation = useQuery({
    queryKey: ['session-operation', operationId],
    queryFn: () => fetchSessionOperation(operationId!),
    enabled: Boolean(operationId),
  })

  useEffect(() => {
    const status = operation.data?.status
    if (
      requestedId &&
      operation.data?.id === requestedId &&
      status &&
      !IN_FLIGHT_OPERATION.has(status)
    ) {
      setRequestedId(null)
    }
  }, [operation.data, requestedId])

  const cancel = useMutation({
    mutationFn: () => cancelSessionOperation(operationId!),
    onSuccess: () => {
      void detail.refetch()
      void operation.refetch()
    },
    onError: (error) => toast.error(error.message),
  })

  const operate = useMutation({
    mutationFn: (
      kind: 'PREPARE' | 'VERIFY_AUTH' | 'LOGIN' | 'RENEW_AUTH' | 'CLOSE' | 'RESTART' | 'RESET_PROFILE',
    ) =>
      requestAccountSessionOperation(
        targetId,
        accountId,
        kind === 'RESET_PROFILE'
          ? {
              kind,
              idempotencyKey: newSessionIdempotencyKey(kind),
              confirmAccountId: accountId,
              ...(detail.data?.session
                ? {
                    expectedSessionId: detail.data.session.id,
                    expectedGeneration: detail.data.session.generation,
                  }
                : {}),
            }
          : {
              kind,
              idempotencyKey: newSessionIdempotencyKey(kind),
              ...(detail.data?.session
                ? {
                    expectedSessionId: detail.data.session.id,
                    expectedGeneration: detail.data.session.generation,
                  }
                : {}),
            },
      ),
    onSuccess: async (result) => {
      setRequestedId(result.operationId)
      if (result.reusedRunId) {
        await navigate({ to: '/runs/$runId', params: { runId: result.reusedRunId } })
        return
      }
      toast.success('已提交会话操作')
      await queryClient.invalidateQueries({ queryKey: ['account-session', targetId, accountId] })
    },
    onError: (error) => toast.error(error instanceof ApiRequestError ? error.message : '操作失败'),
  })

  const retain = useMutation({
    mutationFn: (action: 'set' | 'extend' | 'clear') =>
      setAccountSessionRetention(
        targetId,
        accountId,
        action === 'clear' ? { action } : { action, retainSeconds },
      ),
    onSuccess: async () => {
      toast.success('已更新保留')
      await queryClient.invalidateQueries({ queryKey: ['account-session', targetId, accountId] })
    },
    onError: (error) => toast.error(error instanceof ApiRequestError ? error.message : '保留失败'),
  })

  const dispose = useMutation({
    mutationFn: () => disposeWorkerSession(detail.data!.session!.id, { note: '会话页处置失联实例' }),
    onSuccess: async () => {
      toast.success('已提交处置')
      await queryClient.invalidateQueries({ queryKey: ['account-session', targetId, accountId] })
    },
    onError: (error) => toast.error(error instanceof ApiRequestError ? error.message : '处置失败'),
  })

  const data = detail.data
  const progress = sessionOperationProgress({
    submittingKind: operate.isPending ? operate.variables : null,
    currentKind: data?.currentOperation?.kind ?? operation.data?.kind,
    currentStatus: data?.currentOperation?.status ?? operation.data?.status,
  })

  const statusPrimary =
    data?.status === 'unprepared'
      ? 'PREPARE'
      : data?.status === 'needs_check'
        ? 'VERIFY_AUTH'
        : data?.status === 'needs_login' || data?.status === 'identity_mismatch'
          ? 'LOGIN'
          : data?.status === 'lost'
            ? 'dispose'
            : 'VERIFY_AUTH'
  const claimKinds = ['PREPARE', 'VERIFY_AUTH', 'LOGIN', 'RENEW_AUTH'] as const
  const statusClaim = data?.actions.find((action) => action.kind === statusPrimary)
  const enabledClaim = data?.actions.find(
    (action) => claimKinds.includes(action.kind as (typeof claimKinds)[number]) && action.enabled,
  )
  const primary =
    statusPrimary === 'dispose'
      ? 'dispose'
      : statusClaim?.enabled
        ? statusPrimary
        : (enabledClaim?.kind as typeof statusPrimary | undefined) ?? statusPrimary
  const primaryAction = data?.actions.find((action) => action.kind === primary)
  const primaryDisabled =
    operate.isPending ||
    data?.status === 'executing' ||
    data?.status === 'maintenance' ||
    (primary !== 'dispose' && primaryAction?.enabled === false)

  const rawItems = events.data?.items ?? []
  const filteredEvents = useMemo(() => {
    if (eventFilter === 'all') return rawItems
    if (eventFilter === 'operation') {
      return rawItems.filter((e) => e.type.startsWith('operation.') || e.type.startsWith('auth.attempt'))
    }
    if (eventFilter === 'signal') {
      return rawItems.filter((e) => e.type.startsWith('auth.') && !e.type.startsWith('auth.attempt'))
    }
    if (eventFilter === 'retention') {
      return rawItems.filter((e) => e.type.startsWith('retention.') || e.type.startsWith('session.'))
    }
    return rawItems
  }, [rawItems, eventFilter])

  const activityGroups = useMemo(() => groupSessionEventsByActivity(filteredEvents), [filteredEvents])

  const isActivityExpanded = (groupId: string, index: number) => {
    if (expandedActivities[groupId] !== undefined) {
      return expandedActivities[groupId]
    }
    return index === 0
  }

  const toggleActivityExpand = (groupId: string, index: number) => {
    setExpandedActivities((prev) => ({
      ...prev,
      [groupId]: !isActivityExpanded(groupId, index),
    }))
  }

  const setAllActivitiesExpanded = (expand: boolean) => {
    const next: Record<string, boolean> = {}
    for (const g of activityGroups) {
      next[g.id] = expand
    }
    setExpandedActivities(next)
  }

  const toggleSubSignalExpand = (stepId: string) => {
    setExpandedSubSignals((prev) => ({ ...prev, [stepId]: !prev[stepId] }))
  }

  const handleCopySessionId = (id: string) => {
    void navigator.clipboard.writeText(id).then(() => {
      setCopiedId(true)
      toast.success('已复制会话实例 ID')
      setTimeout(() => setCopiedId(false), 2000)
    })
  }

  return (
    <>
      <Main className="flex min-w-0 flex-1 flex-col gap-5">
        <PageHeader
          parent={
            <Link
              to="/sessions/$targetId"
              params={{ targetId }}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              返回系统会话
            </Link>
          }
          title={data ? `${data.targetName} / ${data.accountDisplayName}` : '账号会话'}
          description={data ? `登录名 ${data.accountUsername}` : '查看该账号当前实例、核验与保留。'}
        />

        {detail.isPending ? (
          <PageSkeleton />
        ) : detail.isError ? (
          <QueryErrorState title="无法加载账号会话" onRetry={() => void detail.refetch()} />
        ) : !data ? (
          <EmptyState title="账号不存在" description="它可能已被删除，或你没有查看权限。" />
        ) : (
          <>
            {!observation.connected ? (
              <p role="status" className="text-small text-muted-foreground">
                连接已断开，正在恢复。最后状态：{new Date(data.asOf).toLocaleString()}；输入已暂停。
              </p>
            ) : null}

            {/* 紧凑型顶部全局健康状态条 */}
            <section className="rounded-lg border border-border-card bg-card p-4 shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[data.status]}>
                    {ACCOUNT_SESSION_STATUS_LABELS[data.status]}
                  </StatusBadge>
                  <StatusBadge tone="neutral">
                    {
                      AUTH_CAPABILITY_LABELS[
                        (data.authCapability as keyof typeof AUTH_CAPABILITY_LABELS) ?? 'LEGACY'
                      ]
                    }
                  </StatusBadge>
                  {data.retained ? <StatusBadge tone="info">保留中</StatusBadge> : null}
                  {data.session?.reclaimMode === 'AUTH_DRIVEN' ? (
                    <StatusBadge tone="info">认证保活</StatusBadge>
                  ) : null}
                  <span className="hidden h-4 w-px bg-border sm:inline-block" />
                  <span className="text-label text-muted-foreground">
                    节点: {data.session ? `${data.session.ownerWorkerId} · 代次 ${data.session.generation}` : '—'}
                  </span>
                  <span className="hidden h-4 w-px bg-border sm:inline-block" />
                  <span className="text-label text-muted-foreground">
                    占用:{' '}
                    {data.occupancy?.occupyingRunId ? (
                      <Link
                        className="font-medium text-foreground underline hover:text-link"
                        to="/runs/$runId"
                        params={{ runId: data.occupancy.occupyingRunId }}
                      >
                        运行 {data.occupancy.occupyingRunId.slice(0, 8)}
                      </Link>
                    ) : data.occupancy?.occupyingOperationId ? (
                      `操作 ${data.occupancy.occupyingOperationId.slice(0, 8)}`
                    ) : (
                      '空闲'
                    )}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {primary === 'dispose' ? (
                    <Can permission="session:dispose">
                      <Button disabled={!data.session || dispose.isPending} onClick={() => dispose.mutate()}>
                        处置失联
                      </Button>
                    </Can>
                  ) : (
                    <Can permission="session:control">
                      <Button
                        disabled={primaryDisabled}
                        title={primaryAction?.disabledReason ?? undefined}
                        onClick={() => operate.mutate(primary)}
                      >
                        {PRIMARY_ACTION_LABELS[primary]}
                      </Button>
                    </Can>
                  )}
                  <Can permission="session:manage">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline">更多</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canCloseAccountSession({
                          status: data.status,
                          sessionId: data.session?.id ?? null,
                        }) ? (
                          <DropdownMenuItem
                            disabled={
                              operate.isPending ||
                              !data.actions.find((action) => action.kind === 'CLOSE')?.enabled
                            }
                            onClick={() => setConfirmKind('CLOSE')}
                          >
                            关闭会话
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          disabled={
                            operate.isPending ||
                            !data.actions.find((action) => action.kind === 'RESTART')?.enabled
                          }
                          onClick={() => setConfirmKind('RESTART')}
                        >
                          重启会话
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={
                            operate.isPending ||
                            !data.actions.find((action) => action.kind === 'RESET_PROFILE')?.enabled
                          }
                          onClick={() => setConfirmKind('RESET_PROFILE')}
                        >
                          清除登录数据
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Can>
                </div>
              </div>
            </section>

            {/* 核心双栏工作台布局 */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
              {/* 左主栏 (~62% 宽度)：浏览器画面控制台 + 语义化使用记录时间线 */}
              <div className="space-y-5 lg:col-span-7 xl:col-span-8">
                {/* 操作进度横幅（高优先级操作情境） */}
                {progress ? (
                  <section
                    aria-label="操作进度"
                    className="rounded-lg border border-status-warning-border bg-status-warning-surface p-4 shadow-card"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <AlertCircle className="size-4 text-status-warning-foreground" />
                          <h2 className="text-title-small font-semibold">操作进度</h2>
                        </div>
                        <p role="status" className="mt-1 text-body">
                          {OPERATION_KIND_LABELS[progress.kind] ?? '会话操作'} ·{' '}
                          {operationStatusLabels[progress.status] ?? progress.status}
                        </p>
                        {operation.data?.errorCode ? (
                          <p className="mt-1 text-small text-status-warning-foreground">
                            {SESSION_MAINTENANCE_ERROR_MESSAGES[
                              operation.data.errorCode as keyof typeof SESSION_MAINTENANCE_ERROR_MESSAGES
                            ] ?? operation.data.errorCode}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {['QUEUED', 'WAITING_FOR_AUTH'].includes(
                          operation.data?.status ?? data.currentOperation?.status ?? '',
                        ) ? (
                          <Can permission="session:control">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={cancel.isPending}
                              onClick={() => cancel.mutate()}
                            >
                              取消操作
                            </Button>
                          </Can>
                        ) : null}
                        {data.currentOperation?.reusedRunId ? (
                          <Link
                            className="text-small font-medium text-link underline"
                            to="/runs/$runId"
                            params={{ runId: data.currentOperation.reusedRunId }}
                          >
                            前往运行处理认证
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </section>
                ) : null}

                {/* 受管浏览器画面控制台 */}
                {data.session?.status === 'OPEN' && !data.occupancy?.occupyingRunId ? (
                  <BrowserView
                    key={data.session.id}
                    runId={data.currentOperation?.id ?? data.session.id}
                    runStatus={data.currentOperation?.status ?? 'RUNNING'}
                    sessionMode
                    transport={data.currentOperation ? operationTransport : instanceTransport}
                    onRefreshLogin={(pageRef) =>
                      requestAccountSessionOperation(targetId, accountId, {
                        kind: 'REFRESH_LOGIN_PAGE',
                        idempotencyKey: newSessionIdempotencyKey('REFRESH_LOGIN_PAGE'),
                        expectedSessionId: pageRef.sessionId,
                        expectedGeneration: pageRef.sessionGeneration,
                        pageRef,
                      })
                    }
                    eventSeq={observation.eventSeq}
                    observationConnected={observation.connected}
                    onRunChanged={() => {
                      void detail.refetch()
                      void operation.refetch()
                    }}
                  />
                ) : null}

                {/* 使用记录与审计时间线（阶梯式活动分组） */}
                <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-card pb-3">
                    <div className="flex items-center gap-2">
                      <Clock className="size-4 text-muted-foreground" />
                      <h2 className="text-title-small font-semibold">使用记录</h2>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-small text-muted-foreground">
                        {filteredEvents.length}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {/* 一键全部展开/折叠 */}
                      {activityGroups.length > 1 ? (
                        <div className="flex items-center gap-1 text-small text-muted-foreground mr-2">
                          <button
                            type="button"
                            onClick={() => setAllActivitiesExpanded(true)}
                            className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                          >
                            全部展开
                          </button>
                          <span>/</span>
                          <button
                            type="button"
                            onClick={() => setAllActivitiesExpanded(false)}
                            className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                          >
                            全部折叠
                          </button>
                        </div>
                      ) : null}

                      {/* 分类筛选工具栏 */}
                      <div className="flex items-center gap-1 text-small">
                        {(
                          [
                            { id: 'all', label: '全部' },
                            { id: 'operation', label: '操作' },
                            { id: 'signal', label: '信号' },
                            { id: 'retention', label: '保留' },
                          ] as const
                        ).map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setEventFilter(tab.id)}
                            className={`rounded px-2 py-1 ${
                              eventFilter === tab.id
                                ? 'bg-primary text-primary-foreground font-medium'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                            }`}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {events.isError ? (
                    <div className="py-4">
                      <QueryErrorState title="无法加载使用记录" onRetry={() => void events.refetch()} />
                    </div>
                  ) : activityGroups.length === 0 ? (
                    <p className="py-6 text-center text-body text-muted-foreground">
                      {rawItems.length === 0 ? '还没有会话事件。' : '该筛选下暂无记录。'}
                    </p>
                  ) : (
                    /* 阶梯式分组操作流容器：合理限高与平滑滚动 */
                    <div className="mt-4 max-h-[460px] space-y-3 overflow-y-auto pr-1">
                      {activityGroups.map((group, groupIdx) => {
                        const isExpanded = isActivityExpanded(group.id, groupIdx)

                        return (
                          <div
                            key={group.id}
                            className="overflow-hidden rounded-md border border-border-card bg-card shadow-xs"
                          >
                            {/* 操作父级卡片 Header */}
                            <button
                              type="button"
                              onClick={() => toggleActivityExpand(group.id, groupIdx)}
                              className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-surface-page/70"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-muted-foreground">
                                  {isExpanded ? (
                                    <ChevronDown className="size-4" />
                                  ) : (
                                    <ChevronRight className="size-4" />
                                  )}
                                </span>
                                <span
                                  className={`size-2 shrink-0 rounded-full ${
                                    group.tone === 'success'
                                      ? 'bg-status-success'
                                      : group.tone === 'warning'
                                        ? 'bg-status-warning'
                                        : group.tone === 'destructive'
                                          ? 'bg-status-danger'
                                          : group.tone === 'info'
                                            ? 'bg-primary'
                                            : 'bg-muted-foreground/40'
                                  }`}
                                />
                                <span className="text-body font-semibold text-foreground">
                                  {group.title}
                                </span>
                                <span
                                  className={`rounded px-1.5 py-0.5 text-small font-medium ${
                                    group.tone === 'success'
                                      ? 'bg-status-success/10 text-status-success-foreground'
                                      : group.tone === 'warning'
                                        ? 'bg-status-warning/10 text-status-warning-foreground'
                                        : group.tone === 'destructive'
                                          ? 'bg-status-danger/10 text-status-danger-foreground'
                                          : 'bg-muted text-muted-foreground'
                                  }`}
                                >
                                  {group.statusLabel}
                                </span>
                                {group.origin === 'USER' ? (
                                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-small text-primary">
                                    人工触发
                                  </span>
                                ) : group.origin === 'BACKGROUND' ? (
                                  <span className="rounded bg-muted px-1.5 py-0.5 text-small text-muted-foreground">
                                    后台巡检
                                  </span>
                                ) : null}
                                <span className="text-small text-muted-foreground">
                                  ({group.steps.length} 项步骤)
                                </span>
                              </div>

                              <div className="flex shrink-0 items-center gap-3 text-small text-muted-foreground">
                                {group.durationText ? (
                                  <span className="font-medium text-foreground/80">
                                    耗时 {group.durationText}
                                  </span>
                                ) : null}
                                <span>{new Date(group.startedAt).toLocaleTimeString()}</span>
                              </div>
                            </button>

                            {/* 楼梯形式的子步骤列表 (Staircase Stepper) */}
                            {isExpanded ? (
                              <div className="border-t border-border-card/60 bg-surface-page/40 p-3.5">
                                <div className="relative ml-2.5 border-l-2 border-border/80 pl-4 space-y-2.5">
                                  {group.steps.map((step, stepIdx) => {
                                    const isLast = stepIdx === group.steps.length - 1
                                    const hasAggregated = step.count > 1
                                    const isSubExpanded = Boolean(expandedSubSignals[step.id])

                                    return (
                                      <div key={step.id} className="relative">
                                        {/* 楼梯阶梯圆点 */}
                                        <span
                                          className={`absolute -left-[21px] top-2 size-2.5 rounded-full border-2 border-card ${
                                            isLast && group.tone === 'success'
                                              ? 'bg-status-success'
                                              : step.tone === 'warning'
                                                ? 'bg-status-warning'
                                                : step.tone === 'destructive'
                                                  ? 'bg-status-danger'
                                                  : 'bg-primary/80'
                                          }`}
                                        />

                                        <div className="rounded-md border border-border-card/60 bg-card p-2.5 shadow-xs">
                                          <div className="flex items-start justify-between gap-2">
                                            <div className="space-y-0.5">
                                              <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-small font-medium text-foreground">
                                                  {sessionEventLabel(
                                                    step.type,
                                                    (step.items[0] ?? {}).payload ?? {},
                                                  )}
                                                </span>
                                                {hasAggregated ? (
                                                  <span className="rounded bg-status-warning-surface px-1.5 py-0.5 text-small font-semibold text-status-warning-foreground border border-status-warning-border">
                                                    × {step.count}
                                                  </span>
                                                ) : null}
                                                {step.origin === 'USER' && stepIdx === 0 ? (
                                                  <span className="rounded bg-primary/10 px-1 py-0.5 text-small text-primary">
                                                    人工触发
                                                  </span>
                                                ) : null}
                                              </div>

                                              {/* 描述性详细文本 */}
                                              {step.summary ? (
                                                <p className="text-small text-muted-foreground">
                                                  {step.summary}
                                                </p>
                                              ) : null}

                                              {/* 关联 Run 链接 */}
                                              {step.runId ? (
                                                <div className="pt-0.5">
                                                  <Link
                                                    className="inline-flex items-center gap-1 text-small font-medium text-link underline"
                                                    to="/runs/$runId"
                                                    params={{ runId: step.runId }}
                                                  >
                                                    运行 {step.runId.slice(0, 8)}
                                                    <ExternalLink className="size-3" />
                                                  </Link>
                                                </div>
                                              ) : null}
                                            </div>

                                            <div className="flex shrink-0 items-center gap-1.5 text-small text-muted-foreground">
                                              <span>{new Date(step.createdAt).toLocaleTimeString()}</span>
                                              {hasAggregated ? (
                                                <button
                                                  type="button"
                                                  onClick={() => toggleSubSignalExpand(step.id)}
                                                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                                  title={isSubExpanded ? '收起明细' : '展开各次明细'}
                                                >
                                                  {isSubExpanded ? (
                                                    <ChevronUp className="size-3.5" />
                                                  ) : (
                                                    <ChevronDown className="size-3.5" />
                                                  )}
                                                </button>
                                              ) : null}
                                            </div>
                                          </div>

                                          {/* 折叠聚合明细展开区 */}
                                          {hasAggregated && isSubExpanded ? (
                                            <div className="mt-2 border-t border-border-card/60 pt-1.5 text-small text-muted-foreground">
                                              <ul className="space-y-1">
                                                {step.items.map((sub, sIdx) => {
                                                  const subRes = resolveSessionEvent(
                                                    sub.type,
                                                    sub.payload,
                                                    sub,
                                                  )
                                                  return (
                                                    <li
                                                      key={sub.id ?? sIdx}
                                                      className="flex items-center justify-between gap-2 py-0.5"
                                                    >
                                                      <span>
                                                        #{sIdx + 1}{' '}
                                                        {subRes.summary ? `· ${subRes.summary}` : ''}
                                                      </span>
                                                      <span className="shrink-0">
                                                        {new Date(sub.createdAt).toLocaleTimeString()}
                                                      </span>
                                                    </li>
                                                  )
                                                })}
                                              </ul>
                                            </div>
                                          ) : null}
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* 紧凑分页导航 */}
                  <div className="mt-4 flex items-center justify-between border-t border-border-card pt-3">
                    <span className="text-small text-muted-foreground">
                      第 {eventCursors.length} 页
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={eventCursors.length === 1}
                        onClick={() => setEventCursors((value) => value.slice(0, -1))}
                      >
                        较新记录
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!events.data?.nextCursor}
                        onClick={() => setEventCursors((value) => [...value, events.data?.nextCursor])}
                      >
                        更早记录
                      </Button>
                    </div>
                  </div>
                </section>
              </div>

              {/* 右侧辅助栏 (~38% 宽度)：认证诊断 + 保留配额 + 底层实例 */}
              <div className="space-y-5 lg:col-span-5 xl:col-span-4">
                {/* 卡片 1：认证与身份健康 */}
                <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
                  <div className="flex items-center justify-between border-b border-border-card pb-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="size-4 text-primary" />
                      <h2 className="text-title-small font-semibold">认证与身份</h2>
                    </div>
                    <Link
                      className="inline-flex items-center gap-1 text-small text-link underline"
                      to="/targets/$targetId"
                      params={{ targetId }}
                    >
                      目标系统
                      <ExternalLink className="size-3" />
                    </Link>
                  </div>

                  <dl className="mt-4 space-y-3 text-body">
                    <div className="flex justify-between gap-2 border-b border-border-card/40 pb-2">
                      <dt className="text-label text-muted-foreground">登录状态</dt>
                      <dd className="text-right font-medium text-foreground">
                        {sessionAuthLabel(data.session?.authState, data.session?.identityState)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-border-card/40 pb-2">
                      <dt className="text-label text-muted-foreground">期望身份</dt>
                      <dd className="text-right text-foreground">
                        {data.expectedIdentity ?? '未设置'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-border-card/40 pb-2">
                      <dt className="text-label text-muted-foreground">最近核验</dt>
                      <dd className="text-right text-foreground">
                        {data.session?.lastAuthCheckedAt
                          ? new Date(data.session.lastAuthCheckedAt).toLocaleString()
                          : '尚未核验'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 border-b border-border-card/40 pb-2">
                      <dt className="text-label text-muted-foreground">下次巡检</dt>
                      <dd className="text-right text-foreground">
                        {data.session?.nextAuthCheckAt
                          ? new Date(data.session.nextAuthCheckAt).toLocaleString()
                          : '未排期'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-label text-muted-foreground">保活截止</dt>
                      <dd className="text-right text-foreground">
                        {data.session?.keepAliveUntil
                          ? new Date(data.session.keepAliveUntil).toLocaleString()
                          : '未保活'}
                      </dd>
                    </div>
                  </dl>
                </section>

                {/* 卡片 2：保留策略与节点配额 */}
                <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
                  <div className="flex items-center gap-2 border-b border-border-card pb-3">
                    <Clock className="size-4 text-primary" />
                    <h2 className="text-title-small font-semibold">登录与保留</h2>
                  </div>

                  <p className="mt-3 text-label text-muted-foreground">
                    {sessionRetentionHint({
                      retained: data.retained,
                      retainUntil: data.session?.retainUntil ?? null,
                      quotaUsed: data.retention?.quotaUsed,
                      quotaLimit: data.retention?.quotaLimit,
                    })}
                  </p>

                  {/* 快捷时长预设 */}
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-small text-muted-foreground">快捷预设:</span>
                    {[
                      { label: '30分', seconds: 1800 },
                      { label: '1小时', seconds: 3600 },
                      { label: '4小时', seconds: 14400 },
                    ].map((item) => (
                      <button
                        key={item.seconds}
                        type="button"
                        onClick={() => setRetainSeconds(item.seconds)}
                        className={`rounded px-2 py-0.5 text-small ${
                          retainSeconds === item.seconds
                            ? 'bg-primary text-primary-foreground font-medium'
                            : 'bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="text-label text-muted-foreground" htmlFor="retain-seconds">
                        保留秒数
                      </label>
                      <Input
                        id="retain-seconds"
                        type="number"
                        min={60}
                        value={retainSeconds}
                        onChange={(event) => setRetainSeconds(Number(event.target.value))}
                        className="mt-1"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Can permission="session:control">
                        <Button
                          variant="outline"
                          disabled={
                            retain.isPending ||
                            data.session?.status !== 'OPEN' ||
                            Boolean(data.occupancy) ||
                            !Number.isFinite(retainSeconds) ||
                            retainSeconds < 60
                          }
                          onClick={() => retain.mutate(data.retained ? 'extend' : 'set')}
                        >
                          {data.retained ? '延长保留' : '设置保留'}
                        </Button>
                        {data.retained ? (
                          <Button
                            variant="ghost"
                            disabled={retain.isPending}
                            onClick={() => retain.mutate('clear')}
                          >
                            取消保留
                          </Button>
                        ) : null}
                      </Can>
                    </div>
                  </div>
                </section>

                {/* 卡片 3：底层实例与占用 */}
                <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
                  <div className="flex items-center gap-2 border-b border-border-card pb-3">
                    <Cpu className="size-4 text-muted-foreground" />
                    <h2 className="text-title-small font-semibold">实例与租约</h2>
                  </div>

                  <dl className="mt-4 space-y-3 text-body">
                    <div>
                      <dt className="text-label text-muted-foreground">实例 ID</dt>
                      <dd className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="font-mono text-small text-foreground">
                          {data.session?.id ? `${data.session.id.slice(0, 18)}...` : '尚未准备'}
                        </span>
                        {data.session?.id ? (
                          <button
                            type="button"
                            onClick={() => handleCopySessionId(data.session!.id)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-small text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="复制完整实例 ID"
                          >
                            {copiedId ? (
                              <Check className="size-3.5 text-status-success" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </button>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-label text-muted-foreground">节点 / 代次</dt>
                      <dd className="mt-0.5 text-foreground">
                        {data.session ? `${data.session.ownerWorkerId} · 代次 ${data.session.generation}` : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-label text-muted-foreground">当前占用</dt>
                      <dd className="mt-0.5 text-foreground">
                        {data.occupancy?.occupyingRunId ? (
                          <Link
                            className="font-medium text-link underline"
                            to="/runs/$runId"
                            params={{ runId: data.occupancy.occupyingRunId }}
                          >
                            运行 {data.occupancy.occupyingRunId}
                          </Link>
                        ) : data.occupancy?.occupyingOperationId ? (
                          `操作 ${data.occupancy.occupyingOperationId}`
                        ) : (
                          '空闲'
                        )}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </div>

            {hasPermission(permissions, 'session:view') && data.session?.status === 'OPEN' ? (
              <p className="text-label text-muted-foreground">
                画面按需从会话详情打开，离开页面即停止采集。
              </p>
            ) : null}
          </>
        )}
      </Main>

      <ConfirmDialog
        open={Boolean(confirmKind)}
        onOpenChange={(open) => {
          if (!open) setConfirmKind(null)
        }}
        title={confirmKind ? OPERATION_KIND_LABELS[confirmKind] : '确认'}
        desc={
          confirmKind === 'RESET_PROFILE'
            ? `将对 ${data?.targetName ?? ''} / ${data?.accountDisplayName ?? ''} 清除登录数据，并删除本机 Profile。`
            : `将对 ${data?.targetName ?? ''} / ${data?.accountDisplayName ?? ''} 执行该操作。`
        }
        confirmText="确认执行"
        destructive={confirmKind === 'RESET_PROFILE' || confirmKind === 'CLOSE'}
        isLoading={operate.isPending}
        handleConfirm={() => {
          if (confirmKind) operate.mutate(confirmKind)
          setConfirmKind(null)
        }}
      />
    </>
  )
}
