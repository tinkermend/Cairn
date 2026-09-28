import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertCircle,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react'
import { describeAuthIssue, hasPermission, isFinishedRunStatus } from '@cairn/shared'
import { toast } from 'sonner'
import {
  classifyStudioSessionConnect,
  deriveSessionPreparationStage,
  formatOperationTimeout,
  PREPARATION_STEPS,
  resolveLatestEventSummary,
  resolveStudioConnectAction,
  studioDisconnectedCopy,
} from './studio-connect'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import {
  cancelSessionOperation,
  fetchAccountSession,
  fetchAccountSessionEvents,
  fetchSessionOperation,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
  sessionBrowserTransport,
} from '@/lib/sessions-api'
import { useSessionObservation } from '@/features/sessions/use-session-observation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatusBadge } from '@/components/status-badge'
import { BrowserView } from '@/features/runs/browser-view'
import { RunVideoSection } from '@/features/runs/run-video'
import { PlacementHint } from '@/features/runs/placement-hint'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { RUN_STATUS_LABELS, runStatusTone } from '@/features/runs/labels'
import { computeScreenAlignment } from '@/features/authoring/observe'
import { cn } from '@/lib/utils'

const LIVE_RUN_STATUSES = ['SCHEDULED', 'QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'HOLDING']
const sessionTransport = sessionBrowserTransport('session')
const operationTransport = sessionBrowserTransport('operation')

export type StudioScreenProps = {
  runId?: string
  scenarioId?: string
  targetId?: string
  targetAccountId?: string
  onStartTrial?: () => void
  selectedStepId?: string
  selectedStepName?: string
  selectedIsFirst?: boolean
  stepOrder?: string[]
  onRunToStep?: (targetStepId: string) => void
  trialDisabledReason?: string
}

export function StudioScreen({
  runId,
  scenarioId: _scenarioId,
  targetId,
  targetAccountId,
  onStartTrial,
  selectedStepId,
  selectedStepName,
  selectedIsFirst,
  stepOrder = [],
  onRunToStep,
  trialDisabledReason,
}: StudioScreenProps) {
  const user = useAuthStore((state) => state.auth.user)
  const canRead = Boolean(user && hasPermission(user.permissions, 'run:read'))
  const canExecute = Boolean(user && hasPermission(user.permissions, 'run:execute'))
  const canReadSession = Boolean(user && hasPermission(user.permissions, 'session:read'))
  const canControlSession = Boolean(user && hasPermission(user.permissions, 'session:control'))
  const { run, evidence, refresh, eventSeq, query } = useRunObservation(
    runId ?? '',
    Boolean(runId && canRead),
  )

  // 接入会话 SSE 订阅：后端事件实时触发缓存失效
  useSessionObservation(targetId, targetAccountId)

  const [videoOpen, setVideoOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [prepareFailed, setPrepareFailed] = useState(false)
  const [abandoning, setAbandoning] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // 目标或账号切换时及时重置连接与失败状态，防止历史状态泄漏
  useEffect(() => {
    setConnecting(false)
    setPrepareFailed(false)
    setPendingOperationId(null)
    setConnectError(null)
  }, [targetId, targetAccountId])

  const sessionQuery = useQuery({
    queryKey: ['account-session', targetId, targetAccountId],
    queryFn: () => fetchAccountSession(targetId!, targetAccountId!),
    enabled: Boolean(targetId && targetAccountId && canReadSession),
  })
  const session = sessionQuery.data

  const activeOpId = session?.currentOperation?.id ?? pendingOperationId
  const operationQuery = useQuery({
    queryKey: ['session-operation', activeOpId],
    queryFn: () => fetchSessionOperation(activeOpId!),
    enabled: Boolean(activeOpId && canReadSession && (connecting || prepareFailed)),
  })

  const eventsQuery = useQuery({
    queryKey: ['account-session-events', targetId, targetAccountId],
    queryFn: () => fetchAccountSessionEvents(targetId!, targetAccountId!),
    enabled: Boolean(targetId && targetAccountId && canReadSession && (connecting || prepareFailed)),
  })

  // 当处于 connecting 时每秒更新计时；每 3 秒兜底刷新一次，防范 SSE 瞬时断线或延迟。
  // 依赖只取稳定的 refetch：查询结果对象每次渲染都会变，放进依赖会让计时器每秒重建、计数永远到不了 3。
  const refetchSession = sessionQuery.refetch
  const refetchOperation = operationQuery.refetch
  useEffect(() => {
    if (!connecting) return
    let timer: ReturnType<typeof setTimeout>
    let counter = 0
    const tick = () => {
      setNowMs(Date.now())
      counter++
      if (counter % 3 === 0) {
        void refetchSession()
        void refetchOperation()
      }
      timer = setTimeout(tick, 1000)
    }
    timer = setTimeout(tick, 1000)
    return () => clearTimeout(timer)
  }, [connecting, refetchSession, refetchOperation])

  const sessionOpen = session?.session?.status === 'OPEN'
  const occupyingRunId = session?.occupancy?.occupyingRunId ?? null
  const occupyingOperationId = session?.occupancy?.occupyingOperationId ?? null
  const sessionViewId = occupyingOperationId ?? session?.session?.id
  const isLiveState = Boolean(run && LIVE_RUN_STATUSES.includes(run.status))
  const isFinished = Boolean(run && isFinishedRunStatus(run.status))
  const showRunLive = isLiveState

  const connectState = classifyStudioSessionConnect(session, pendingOperationId, operationQuery.data)
  const isWaitingForAuth = Boolean(
    !showRunLive &&
      (connectState === 'waiting_for_auth' ||
        session?.currentOperation?.status === 'WAITING_FOR_AUTH' ||
        operationQuery.data?.status === 'WAITING_FOR_AUTH'),
  )

  const showSessionLive = Boolean(
    !showRunLive && (sessionOpen || isWaitingForAuth) && sessionViewId && !occupyingRunId,
  )
  const sessionPending = Boolean(
    targetId && targetAccountId && canReadSession && sessionQuery.isPending,
  )
  const showVideoFallback = Boolean(isFinished && !showSessionLive && !sessionPending)
  const disconnected = studioDisconnectedCopy({
    connecting,
    lastAuthError: session?.lastAuthError,
  })

  const selectedStepRun = run?.stepRuns?.find((sr) => sr.stepId === selectedStepId)
  const selectedScreenshotEvidence = evidence?.items?.find(
    (item) =>
      item.type === 'screenshot' &&
      item.status === 'available' &&
      (selectedStepRun ? item.stepRunId === selectedStepRun.id : true),
  )

  const liveRunForAlignment = isLiveState && run
    ? {
        status: run.status,
        checkpoint: run.checkpoint,
        stepRuns: run.stepRuns,
      }
    : null

  const alignmentStatus = computeScreenAlignment({
    sessionOpen: Boolean(sessionOpen),
    liveRun: liveRunForAlignment,
    selectedStepId,
    stepOrder,
    hasOfflineScreenshot: Boolean(selectedScreenshotEvidence),
  })

  const alignmentBanner =
    (alignmentStatus === 'behind' || alignmentStatus === 'session_initial') && selectedStepId ? (
      <div className='mx-3 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-small'>
        <div className='flex items-center gap-2'>
          <span className='size-2 rounded-full bg-status-warning' />
          <span className='text-foreground'>
            当前画面处于【{alignmentStatus === 'session_initial' ? '系统初始页' : '前序步骤'}】，选中的步骤是【{selectedStepName || '当前步骤'}】
          </span>
        </div>
        <div className='flex items-center gap-2'>
          {canExecute ? (
            <Button
              size='sm'
              className='h-7 px-2.5 text-label'
              disabled={Boolean(trialDisabledReason)}
              onClick={() => onRunToStep?.(selectedStepId)}
            >
              <Play className='size-3.5 mr-1' />
              运行到此步前置
            </Button>
          ) : null}
          {trialDisabledReason ? (
            <span className='text-label text-muted-foreground'>试跑不可用：{trialDisabledReason}。</span>
          ) : null}
        </div>
      </div>
    ) : alignmentStatus === 'aligned' && selectedStepId ? (
      <div className='mx-3 mt-2 flex items-center gap-2 rounded-md border border-status-success/30 bg-status-success/10 px-3 py-1.5 text-label text-status-success-foreground'>
        <span className='size-2 rounded-full bg-status-success' />
        <span>画面已对齐至步骤「{selectedStepName || '当前步骤'}」前置，可在画面上精准指认目标</span>
      </div>
    ) : !selectedStepId && selectedIsFirst === false && showSessionLive ? (
      <Alert variant='info' className='mx-3 mt-2'>
        <AlertDescription>
          <p>
            现在看到的是会话停放的当前页面，不是执行到「{selectedStepName || '当前步骤'}」之后的页面。您可以点击上方「手动操作」在受管画面中切到对应菜单或弹窗后再点「拾取对象」；也可以保存并试跑已保存的步骤。
          </p>
          <div className='mt-2 flex flex-wrap items-center gap-2'>
            <Button size='sm' disabled={Boolean(trialDisabledReason)} onClick={onStartTrial}>
              试跑
            </Button>
            {trialDisabledReason ? (
              <span className='text-label'>试跑不可用：{trialDisabledReason}。</span>
            ) : null}
          </div>
        </AlertDescription>
      </Alert>
    ) : null

  const currentOpStatus = session?.currentOperation?.status ?? operationQuery.data?.status
  const currentErrorCode = operationQuery.data?.errorCode ?? session?.lastAuthError

  const currentAction = resolveStudioConnectAction({
    sessionDetail: session,
    activeOpStatus: currentOpStatus,
    activeOpErrorCode: currentErrorCode,
    isFailed: prepareFailed,
  })

  const stageInfo = deriveSessionPreparationStage({
    operationStatus: currentOpStatus,
    events: eventsQuery.data?.items,
    sessionOpen,
    lastAuthError: session?.lastAuthError,
    errorCode: currentErrorCode,
    prepareFailed,
    errorMessage: connectError,
  })

  const latestEventSummary = resolveLatestEventSummary(eventsQuery.data?.items, activeOpId)

  const timeoutInfo = formatOperationTimeout({
    status: currentOpStatus,
    queueDeadlineAt: operationQuery.data?.queueDeadlineAt,
    createdAt: operationQuery.data?.createdAt,
    nowMs,
  })

  useEffect(() => {
    if (!connecting) return
    if (connectState === 'open') {
      setConnecting(false)
      setPrepareFailed(false)
      setPendingOperationId(null)
      setConnectError(null)
      return
    }
    if (connectState === 'failed') {
      setConnecting(false)
      setPrepareFailed(true)
      const errorMsg =
        stageInfo.detail || describeAuthIssue(session?.lastAuthError) || '无法连接受管会话'
      toast.error(errorMsg)
    }
  }, [connecting, connectState, session, stageInfo.detail])

  // 兜底安全上限：300 秒（对齐平台默认排队与调度上限）
  useEffect(() => {
    if (!connecting) return
    const timer = window.setTimeout(() => {
      setConnecting(false)
      setPrepareFailed(true)
      setPendingOperationId(null)
      const msg = '会话准备已超时。可到会话页查看详细排障信息，或稍后重试。'
      setConnectError(msg)
      toast.error(msg)
    }, 300_000)
    return () => window.clearTimeout(timer)
  }, [connecting])

  async function connectSession() {
    if (!targetId || !targetAccountId || !canControlSession) {
      onStartTrial?.()
      return
    }
    setConnecting(true)
    setPrepareFailed(false)
    setConnectError(null)
    setPendingOperationId(null)
    try {
      const action = resolveStudioConnectAction({
        sessionDetail: session,
        activeOpStatus: currentOpStatus,
        activeOpErrorCode: currentErrorCode,
        isFailed: prepareFailed,
      })

      if (sessionOpen && action.kind === 'PREPARE' && !prepareFailed) {
        await sessionQuery.refetch()
        setConnecting(false)
        return
      }

      const accepted = await requestAccountSessionOperation(targetId, targetAccountId, {
        kind: action.kind,
        idempotencyKey: newSessionIdempotencyKey(action.kind),
        force: action.kind === 'RESTART',
      })
      setPendingOperationId(accepted.operationId)
      await sessionQuery.refetch()
    } catch (error) {
      setConnecting(false)
      setPrepareFailed(true)
      setPendingOperationId(null)
      const message =
        error instanceof ApiRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : '无法连接受管会话'
      setConnectError(message)
      toast.error(message)
    }
  }

  async function abandonTakeover() {
    if (!targetId || !targetAccountId) return
    setAbandoning(true)
    try {
      await requestAccountSessionOperation(targetId, targetAccountId, {
        kind: 'CLOSE',
        idempotencyKey: newSessionIdempotencyKey('CLOSE'),
        force: true,
      })
      toast.info('已放弃人工接管，受管浏览器会话已关闭')
      setConnecting(false)
      setPrepareFailed(false)
      setPendingOperationId(null)
      setConnectError(null)
      await sessionQuery.refetch()
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '关闭会话失败')
    } finally {
      setAbandoning(false)
    }
  }

  async function cancelConnecting() {
    const opId = activeOpId
    if (opId) {
      try {
        await cancelSessionOperation(opId)
        toast.success('已取消会话准备')
      } catch (err) {
        toast.error(err instanceof ApiRequestError ? err.message : '取消失败')
      }
    }
    setConnecting(false)
    setPrepareFailed(false)
    setPendingOperationId(null)
    setConnectError(null)
    void sessionQuery.refetch()
  }

  const headerAction = showRunLive ? (
    canExecute ? (
      <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={onStartTrial}>
        <Play className='size-3.5 mr-1' />
        重连环境
      </Button>
    ) : null
  ) : showSessionLive ? (
    <Button
      size='sm'
      variant='outline'
      className='h-7 px-2 text-label'
      disabled={sessionQuery.isFetching}
      onClick={() => void sessionQuery.refetch()}
    >
      <RefreshCw className='size-3.5 mr-1' />
      同步画面
    </Button>
  ) : canControlSession && targetId && targetAccountId ? (
    <Button
      size='sm'
      variant='outline'
      className='h-7 px-2 text-label'
      disabled={(connecting && !prepareFailed) || abandoning}
      onClick={() => void connectSession()}
    >
      <Play className='size-3.5 mr-1' />
      {connecting && !prepareFailed ? '准备中…' : currentAction.label}
    </Button>
  ) : canExecute ? (
    <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={onStartTrial}>
      <Play className='size-3.5 mr-1' />
      唤起环境
    </Button>
  ) : null

  return (
    <section
      aria-label='受管画面'
      className='flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card'
    >
      <div className='flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border-divider px-3 bg-surface-header'>
        <div className='flex items-center gap-2 shrink-0'>
          <Monitor className='size-4 text-primary shrink-0' />
          <h2 className='text-body font-semibold shrink-0'>受管画面</h2>
          {showRunLive && run ? (
            <StatusBadge tone={runStatusTone(run.status)} className='shrink-0'>
              {RUN_STATUS_LABELS[run.status]}
            </StatusBadge>
          ) : isWaitingForAuth ? (
            <StatusBadge tone='warning' className='shrink-0'>
              需要人工验证
            </StatusBadge>
          ) : showSessionLive ? (
            <StatusBadge tone='success' className='shrink-0'>
              会话已连接
            </StatusBadge>
          ) : prepareFailed ? (
            <StatusBadge tone='error' className='shrink-0'>
              {stageInfo.title}
            </StatusBadge>
          ) : connecting ? (
            <StatusBadge tone={stageInfo.statusTone} className='shrink-0'>
              {stageInfo.title}
            </StatusBadge>
          ) : run ? (
            <StatusBadge tone={runStatusTone(run.status)} className='shrink-0'>
              {RUN_STATUS_LABELS[run.status]}
            </StatusBadge>
          ) : (
            <StatusBadge tone='neutral' className='shrink-0'>
              未连接
            </StatusBadge>
          )}
        </div>
        <div className='flex items-center gap-1.5 shrink-0'>
          {runId ? (
            <Button
              size='sm'
              variant='ghost'
              className='size-7 p-0'
              title='同步试跑'
              aria-label='同步试跑'
              onClick={() => void refresh()}
            >
              <RefreshCw className='size-3.5' />
            </Button>
          ) : null}
          {runId ? (
            <Button size='sm' variant='ghost' className='size-7 p-0' asChild title='查看完整运行详情'>
              <Link to='/runs/$runId' params={{ runId }}>
                <ExternalLink className='size-3.5' />
              </Link>
            </Button>
          ) : null}
          {headerAction}
        </div>
      </div>

      <div className='flex min-h-0 flex-1 flex-col justify-start overflow-y-auto'>
        {showRunLive && run ? (
          <div className='space-y-2'>
            {alignmentBanner}
            {run.authCheckpoint ? (
              <div className='mx-3 mt-2 space-y-1 rounded-md border border-border-card bg-muted/40 p-3 text-small'>
                <p className='font-medium text-foreground'>
                  {run.authCheckpoint.status === 'recovering'
                    ? '正在等待登录恢复…'
                    : run.authCheckpoint.status === 'recovered'
                      ? '登录已恢复，已通过续跑校验'
                      : '需要完成认证'}
                </p>
                <p className='text-muted-foreground'>{run.authCheckpoint.trigger.summary}</p>
              </div>
            ) : null}
            <BrowserView
              runId={run.id}
              runStatus={run.status}
              eventSeq={eventSeq}
              onRunChanged={refresh}
              waitReason={session?.lastAuthError}
              defaultOpen
              embedded
            />
          </div>
        ) : showSessionLive && sessionViewId ? (
          <div className='space-y-2'>
            {isWaitingForAuth ? (
              <Alert variant='warning' className='mx-3 mt-2 border-warning/40 bg-warning/10 text-foreground'>
                <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                  <div className='text-small'>
                    <span className='font-semibold text-warning-foreground'>需要人工辅助验证：</span>
                    {describeAuthIssue(session?.lastAuthError) ?? '目标系统需要完成人机验证（滑块/验证码）或登录'}。请在下方画面中点击「取得控制权」完成操作。
                  </div>
                  <div className='flex items-center gap-2'>
                    {activeOpId ? (
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 text-label'
                        onClick={() => void cancelConnecting()}
                      >
                        取消准备
                      </Button>
                    ) : null}
                    <Button
                      size='sm'
                      variant='destructive'
                      className='h-7 text-label'
                      disabled={abandoning}
                      onClick={() => void abandonTakeover()}
                    >
                      {abandoning ? '正在关闭…' : '放弃接管并关闭'}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {alignmentBanner}
            <BrowserView
              runId={sessionViewId}
              runStatus={occupyingOperationId ? (session?.currentOperation?.status ?? 'RUNNING') : 'RUNNING'}
              sessionMode
              defaultOpen
              transport={occupyingOperationId ? operationTransport : sessionTransport}
              onRunChanged={() => void sessionQuery.refetch()}
              waitReason={session?.lastAuthError}
              embedded
            />
            {isFinished && run ? (
              <div className='px-3 pt-1'>
                <Collapsible open={videoOpen} onOpenChange={setVideoOpen}>
                  <CollapsibleTrigger asChild>
                    <Button variant='ghost' size='sm' className='w-full justify-between'>
                      本次试跑录像
                      <ChevronDown className={videoOpen ? 'size-3.5 rotate-180' : 'size-3.5'} />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className='pt-2'>
                    <RunVideoSection run={run} items={evidence?.items ?? []} />
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ) : null}
          </div>
        ) : alignmentStatus === 'offline_snapshot' && selectedScreenshotEvidence && runId ? (
          <div className='flex flex-col flex-1 p-3 space-y-2'>
            <div className='flex items-center justify-between rounded-md border border-border-card bg-muted/40 px-3 py-1.5 text-label text-muted-foreground'>
              <span>📷 正在展示历史试跑留存现场截图（离线参考）</span>
              {run?.finishedAt ? <span>执行于 {new Date(run.finishedAt).toLocaleTimeString()}</span> : null}
            </div>
            <div className='flex-1 overflow-auto rounded-md border border-border-default bg-black/5 flex items-center justify-center p-2 min-h-[300px]'>
              <img
                src={`/api/runs/${runId}/evidences/${selectedScreenshotEvidence.id}/content`}
                alt='离线步骤历史截图'
                className='max-w-full max-h-[480px] object-contain shadow-sm rounded border border-border-card'
              />
            </div>
            <p className='text-center text-caption text-muted-foreground'>
              当前受管会话未连接。连接会话或发起试跑后可启用实时指认与单步调试。
            </p>
          </div>
        ) : showVideoFallback && run ? (
          <div className='space-y-3 p-3'>
            <RunVideoSection run={run} items={evidence?.items ?? []} />
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-default bg-muted/20 p-3'>
              <div className='space-y-0.5 text-small'>
                <p className='font-medium'>运行已结束 · {RUN_STATUS_LABELS[run.status]}</p>
                <p className='text-label text-muted-foreground'>
                  版本 {run.scenarioVersionId}
                  {run.finishedAt ? ` · 结束于 ${new Date(run.finishedAt).toLocaleTimeString()}` : ''}
                </p>
              </div>
              {headerAction}
            </div>
          </div>
        ) : sessionPending ? (
          <p className='p-6 text-center text-small text-muted-foreground'>正在连接受管浏览器…</p>
        ) : connecting || prepareFailed ? (
          <div className='flex flex-col items-center justify-center p-8 text-center max-w-lg mx-auto w-full'>
            <div
              className={cn(
                'mb-3 flex size-12 items-center justify-center rounded-full',
                prepareFailed
                  ? stageInfo.statusTone === 'warning'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-destructive/10 text-destructive'
                  : 'bg-primary/10 text-primary',
              )}
            >
              {prepareFailed ? (
                <AlertCircle className='size-6' />
              ) : (
                <Loader2 className='size-6 animate-spin' />
              )}
            </div>
            <div className='flex items-center gap-2'>
              <h3 className='text-body font-semibold'>{stageInfo.title}</h3>
              <StatusBadge tone={stageInfo.statusTone}>{stageInfo.stageBadge}</StatusBadge>
            </div>
            <p
              className={cn(
                'mt-1 text-small max-w-sm',
                prepareFailed ? 'text-destructive font-medium' : 'text-muted-foreground',
              )}
            >
              {stageInfo.detail}
            </p>

            {/* 四阶段 Stepper 进度条 */}
            <div className='my-5 flex items-center justify-between w-full px-2'>
              {PREPARATION_STEPS.map((step, idx) => {
                const isFailed = prepareFailed && stageInfo.failedStepIndex === idx
                const isDone = !isFailed && stageInfo.stepIndex > idx
                const isCurrent = !prepareFailed && stageInfo.stepIndex === idx
                return (
                  <div key={step.key} className='flex items-center flex-1 last:flex-none'>
                    <div className='flex flex-col items-center gap-1'>
                      <div
                        className={cn(
                          'flex size-7 items-center justify-center rounded-full text-caption font-semibold transition-colors',
                          isFailed
                            ? 'bg-destructive text-destructive-foreground ring-4 ring-destructive/20'
                            : isDone
                              ? 'bg-success text-success-foreground'
                              : isCurrent
                                ? 'bg-primary text-primary-foreground ring-4 ring-primary/20 animate-pulse'
                                : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {isFailed ? <X className='size-3.5' /> : isDone ? <Check className='size-3.5' /> : idx + 1}
                      </div>
                      <span
                        className={cn(
                          'text-caption font-medium whitespace-nowrap',
                          isFailed
                            ? 'text-destructive font-semibold'
                            : isCurrent
                              ? 'text-foreground font-semibold'
                              : 'text-muted-foreground',
                        )}
                      >
                        {step.title}
                      </span>
                    </div>
                    {idx < PREPARATION_STEPS.length - 1 ? (
                      <div
                        className={cn(
                          'h-0.5 flex-1 mx-2 transition-colors',
                          isDone ? 'bg-success' : 'bg-border-divider',
                        )}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>

            {/* 最新动态展示 */}
            {latestEventSummary ? (
              <div className='w-full flex items-center gap-1.5 rounded-md border border-border-card bg-muted/40 px-3 py-2 text-label text-muted-foreground'>
                <Activity
                  className={cn(
                    'size-3.5 shrink-0',
                    prepareFailed ? 'text-destructive' : 'text-primary animate-pulse',
                  )}
                />
                <span className='truncate text-left'>最新动态：{latestEventSummary}</span>
              </div>
            ) : null}

            {/* 倒计时与超时预估 */}
            <div className='mt-3 flex items-center justify-center gap-1.5 text-label text-muted-foreground'>
              <Clock className='size-3.5 shrink-0' />
              <span>{timeoutInfo.hint}</span>
            </div>

            {/* 操作与逃生按钮 */}
            <div className='mt-5 flex flex-wrap items-center justify-center gap-3'>
              {prepareFailed ? (
                <>
                  <Button size='sm' onClick={() => void connectSession()}>
                    <Play className='size-3.5 mr-1' />
                    {currentAction.label}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => {
                      setPrepareFailed(false)
                      setPendingOperationId(null)
                      setConnectError(null)
                    }}
                  >
                    关闭
                  </Button>
                  <Button
                    size='sm'
                    variant='destructive'
                    disabled={abandoning}
                    onClick={() => void abandonTakeover()}
                  >
                    {abandoning ? '正在关闭…' : '彻底重置会话'}
                  </Button>
                </>
              ) : (
                <Button size='sm' variant='outline' onClick={() => void cancelConnecting()}>
                  <XCircle className='size-3.5 mr-1 text-destructive' />
                  取消准备
                </Button>
              )}
              <Link
                to='/sessions/$targetId/$accountId'
                params={{ targetId: targetId!, accountId: targetAccountId! }}
                className='text-small font-medium text-link underline'
              >
                查看会话详情
              </Link>
            </div>
          </div>
        ) : !runId || !run || isFinished || sessionQuery.isFetched ? (
          <div className='flex flex-col items-center justify-center p-8 text-center'>
            <div className='mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground'>
               <Monitor className='size-6' />
            </div>
            <h3 className='text-body font-medium'>{disconnected.title}</h3>
            <p className='mt-1 max-w-sm text-small text-muted-foreground'>{disconnected.body}</p>
            {canControlSession && targetId && targetAccountId ? (
              <div className='mt-4 flex flex-wrap items-center justify-center gap-2'>
                <Button disabled={connecting || abandoning} onClick={() => void connectSession()}>
                  <Play />
                  {connecting
                    ? '准备中…'
                    : currentAction.kind === 'PREPARE'
                      ? session?.lastAuthError
                        ? '再试一次'
                        : '连接受管会话'
                      : currentAction.label}
                </Button>
                <Link
                  to='/sessions/$targetId/$accountId'
                  params={{ targetId, accountId: targetAccountId }}
                  className='text-small font-medium text-link underline'
                >
                  查看会话
                </Link>
              </div>
            ) : canExecute ? (
              <Button className='mt-4' onClick={onStartTrial}>
                <Play />
                唤起受管环境
              </Button>
            ) : null}
          </div>
        ) : (
          <p className='p-6 text-center text-small text-muted-foreground'>
            {query.isError ? '无法加载运行数据。草稿不受影响。' : '正在加载受管浏览器…'}
          </p>
        )}
      </div>

      {run?.placement ? (
        <div className='border-t border-border-divider bg-surface-header px-4 py-2 text-label text-muted-foreground'>
          <PlacementHint placement={run.placement} />
        </div>
      ) : null}
    </section>
  )
}
