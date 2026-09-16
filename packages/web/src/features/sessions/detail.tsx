import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import { BrowserView } from '@/features/runs/browser-view'
import { useSessionObservation } from './use-session-observation'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { hasPermission } from '@cairn/shared'
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
import { AppHeader } from '@/components/layout/app-header'
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
import {
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
  OPERATION_KIND_LABELS,
  PRIMARY_ACTION_LABELS,
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
  const primary =
    data?.status === 'unprepared'
      ? 'PREPARE'
      : data?.status === 'needs_check'
        ? 'VERIFY_AUTH'
        : data?.status === 'needs_login' || data?.status === 'identity_mismatch'
          ? 'LOGIN'
          : data?.status === 'lost'
            ? 'dispose'
            : 'VERIFY_AUTH'

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
          title={data ? `${data.targetName} / ${data.accountDisplayName}` : '账号会话'}
          description={data ? `登录名 ${data.accountUsername}` : '查看该账号当前实例、核验与保留。'}
          actions={
            <Button variant="outline" asChild>
              <Link to="/sessions">
                <ArrowLeft />
                返回总览
              </Link>
            </Button>
          }
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
            <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
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
                </div>
                <div className="flex flex-wrap gap-2">
                  {primary === 'dispose' ? (
                    <Can permission="session:dispose">
                      <Button disabled={!data.session || dispose.isPending} onClick={() => dispose.mutate()}>
                        处置失联
                      </Button>
                    </Can>
                  ) : (
                    <Can permission="session:control">
                      <Button
                        disabled={
                          operate.isPending || data.status === 'executing' || data.status === 'maintenance'
                        }
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
                        <DropdownMenuItem
                          disabled={
                            operate.isPending ||
                            !data.actions.find((action) => action.kind === 'CLOSE')?.enabled
                          }
                          onClick={() => setConfirmKind('CLOSE')}
                        >
                          关闭会话
                        </DropdownMenuItem>
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
              <dl className="mt-4 grid gap-3 text-body sm:grid-cols-2">
                <div>
                  <dt className="text-label text-muted-foreground">实例</dt>
                  <dd>{data.session?.id ?? '尚未准备'}</dd>
                </div>
                <div>
                  <dt className="text-label text-muted-foreground">节点 / 代次</dt>
                  <dd>{data.session ? `${data.session.ownerWorkerId} · ${data.session.generation}` : '—'}</dd>
                </div>
                <div>
                  <dt className="text-label text-muted-foreground">登录状态</dt>
                  <dd>
                    {sessionAuthLabel(data.session?.authState, data.session?.identityState)}
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-muted-foreground">最近核验</dt>
                  <dd>
                    {data.session?.lastAuthCheckedAt
                      ? new Date(data.session.lastAuthCheckedAt).toLocaleString()
                      : '尚未核验'}
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-muted-foreground">期望身份</dt>
                  <dd>{data.expectedIdentity ?? '未设置'}</dd>
                </div>
                <div>
                  <dt className="text-label text-muted-foreground">占用</dt>
                  <dd>
                    {data.occupancy?.occupyingRunId ? (
                      <Link
                        className="underline"
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

            {operationId ? (
              <section
                aria-label="操作进度"
                className="rounded-lg border border-border-card bg-card p-5 shadow-card"
              >
                <h2 className="text-title-small">操作进度</h2>
                <p role="status" className="mt-2 text-body">
                  {OPERATION_KIND_LABELS[operation.data?.kind ?? data.currentOperation?.kind ?? ''] ??
                    '会话操作'}{' '}
                  ·{' '}
                  {operationStatusLabels[operation.data?.status ?? data.currentOperation?.status ?? 'QUEUED']}
                </p>
                {operation.data?.errorCode ? (
                  <p className="mt-2 text-small text-status-warning-foreground">{operation.data.errorCode}</p>
                ) : null}
                {['QUEUED', 'WAITING_FOR_AUTH'].includes(
                  operation.data?.status ?? data.currentOperation?.status ?? '',
                ) ? (
                  <Can permission="session:control">
                    <Button
                      className="mt-3"
                      variant="outline"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      取消操作
                    </Button>
                  </Can>
                ) : null}
                {data.currentOperation?.reusedRunId ? (
                  <Link
                    className="ms-3 underline"
                    to="/runs/$runId"
                    params={{ runId: data.currentOperation.reusedRunId }}
                  >
                    前往运行处理认证
                  </Link>
                ) : null}
              </section>
            ) : null}
            {data.session?.status === 'OPEN' && !data.occupancy?.occupyingRunId ? (
              <BrowserView
                key={data.currentOperation?.id ?? data.session.id}
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
            <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
              <h2 className="text-title-small">登录与保留</h2>
              <p className="mt-2 text-body text-muted-foreground">
                认证规则在目标系统中维护。
                <Link className="ms-2 underline" to="/targets/$targetId" params={{ targetId }}>
                  前往目标系统
                </Link>
              </p>
              <div className="mt-4 flex flex-wrap items-end gap-3">
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
                  />
                </div>
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
              <p className="mt-3 text-label text-muted-foreground">
                {data.retention
                  ? `截止 ${new Date(data.retention.retainUntil).toLocaleString()} · 配额 ${data.retention.quotaUsed}/${data.retention.quotaLimit}`
                  : '未设置保留。只有打开的实例可以占用节点配额。'}
              </p>
            </section>

            <section className="rounded-lg border border-border-card bg-card p-5 shadow-card">
              <h2 className="text-title-small">使用记录</h2>
              {events.isError ? (
                <QueryErrorState title="无法加载使用记录" onRetry={() => void events.refetch()} />
              ) : (events.data?.items ?? []).length === 0 ? (
                <p className="mt-3 text-body text-muted-foreground">还没有会话事件。</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {events.data?.items.map((event) => (
                    <li key={event.id} className="text-body">
                      <span className="text-muted-foreground">
                        {new Date(event.createdAt).toLocaleString()}
                      </span>
                      {' · '}
                      {sessionEventLabel(event.type, event.payload)}
                      {event.runId ? (
                        <>
                          {' · '}
                          <Link className="underline" to="/runs/$runId" params={{ runId: event.runId }}>
                            运行
                          </Link>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  disabled={eventCursors.length === 1}
                  onClick={() => setEventCursors((value) => value.slice(0, -1))}
                >
                  较新记录
                </Button>
                <Button
                  variant="outline"
                  disabled={!events.data?.nextCursor}
                  onClick={() => setEventCursors((value) => [...value, events.data?.nextCursor])}
                >
                  更早记录
                </Button>
              </div>
            </section>
            {hasPermission(permissions, 'session:view') && data.session?.status === 'OPEN' ? (
              <p className="text-label text-muted-foreground">画面按需从会话详情打开，离开页面即停止采集。</p>
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
        desc={`将对 ${data?.targetName ?? ''} / ${data?.accountDisplayName ?? ''} 执行该操作。清除登录数据会删除本机 Profile。`}
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
