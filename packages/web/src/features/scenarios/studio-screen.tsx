import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Monitor, Play, RefreshCw } from 'lucide-react'
import { describeAuthIssue, hasPermission, isFinishedRunStatus } from '@cairn/shared'
import { toast } from 'sonner'
import { classifyStudioSessionConnect, studioDisconnectedCopy } from './studio-connect'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import {
  fetchAccountSession,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
  sessionBrowserTransport,
} from '@/lib/sessions-api'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatusBadge } from '@/components/status-badge'
import { BrowserView } from '@/features/runs/browser-view'
import { RunVideoSection } from '@/features/runs/run-video'
import { PlacementHint } from '@/features/runs/placement-hint'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { RUN_STATUS_LABELS, runStatusTone } from '@/features/runs/labels'

const LIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH', 'HOLDING', 'RECOVERING']
const sessionTransport = sessionBrowserTransport('session')
const operationTransport = sessionBrowserTransport('operation')

export function StudioScreen({
  runId,
  scenarioId: _scenarioId,
  targetId,
  targetAccountId,
  onStartTrial,
  selectedStepName,
  selectedIsFirst,
  trialDisabledReason,
}: {
  runId?: string
  scenarioId: string
  targetId?: string
  targetAccountId?: string
  onStartTrial: () => void
  selectedStepName?: string
  selectedIsFirst?: boolean
  trialDisabledReason?: string
}) {
  const user = useAuthStore((state) => state.auth.user)
  const canRead = Boolean(user && hasPermission(user.permissions, 'run:read'))
  const canExecute = Boolean(user && hasPermission(user.permissions, 'run:execute'))
  const canReadSession = Boolean(user && hasPermission(user.permissions, 'session:read'))
  const canControlSession = Boolean(user && hasPermission(user.permissions, 'session:control'))
  const { run, evidence, refresh, eventSeq, query } = useRunObservation(
    runId ?? '',
    Boolean(runId && canRead),
  )
  const [videoOpen, setVideoOpen] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null)
  const sessionQuery = useQuery({
    queryKey: ['account-session', targetId, targetAccountId],
    queryFn: () => fetchAccountSession(targetId!, targetAccountId!),
    enabled: Boolean(targetId && targetAccountId && canReadSession),
  })
  const session = sessionQuery.data
  const sessionOpen = session?.session?.status === 'OPEN'
  const occupyingRunId = session?.occupancy?.occupyingRunId ?? null
  const occupyingOperationId = session?.occupancy?.occupyingOperationId ?? null
  const sessionViewId = occupyingOperationId ?? session?.session?.id
  const isLiveState = Boolean(run && LIVE_RUN_STATUSES.includes(run.status))
  const isFinished = Boolean(run && isFinishedRunStatus(run.status))
  const showRunLive = isLiveState
  const showSessionLive = Boolean(
    !showRunLive && sessionOpen && sessionViewId && !occupyingRunId,
  )
  const sessionPending = Boolean(
    targetId && targetAccountId && canReadSession && sessionQuery.isPending,
  )
  const showVideoFallback = Boolean(isFinished && !showSessionLive && !sessionPending)
  const disconnected = studioDisconnectedCopy({
    connecting,
    lastAuthError: session?.lastAuthError,
  })

  useEffect(() => {
    if (!connecting) return
    const state = classifyStudioSessionConnect(session, pendingOperationId)
    if (state === 'open') {
      setConnecting(false)
      setPendingOperationId(null)
      return
    }
    if (state === 'failed') {
      setConnecting(false)
      setPendingOperationId(null)
      toast.error(describeAuthIssue(session?.lastAuthError) ?? '无法连接受管会话')
    }
  }, [connecting, pendingOperationId, session])

  useEffect(() => {
    if (!connecting) return
    const timer = window.setTimeout(() => {
      setConnecting(false)
      setPendingOperationId(null)
      toast.error('还在准备会话。可到浏览器页查看进度，或稍后重试。')
    }, 90_000)
    return () => window.clearTimeout(timer)
  }, [connecting])

  async function connectSession() {
    if (!targetId || !targetAccountId || !canControlSession) {
      onStartTrial()
      return
    }
    setConnecting(true)
    try {
      if (!sessionOpen) {
        const accepted = await requestAccountSessionOperation(targetId, targetAccountId, {
          kind: 'PREPARE',
          idempotencyKey: newSessionIdempotencyKey('PREPARE'),
        })
        setPendingOperationId(accepted.operationId)
      }
      await sessionQuery.refetch()
    } catch (error) {
      setConnecting(false)
      setPendingOperationId(null)
      toast.error(error instanceof ApiRequestError ? error.message : '无法连接受管会话')
    }
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
    <Button size='sm' variant='outline' className='h-7 px-2 text-label' disabled={connecting} onClick={() => void connectSession()}>
      <Play className='size-3.5 mr-1' />
      {connecting ? '连接中…' : '连接会话'}
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
          ) : showSessionLive ? (
            <StatusBadge tone='success' className='shrink-0'>会话已连接</StatusBadge>
          ) : run ? (
            <StatusBadge tone={runStatusTone(run.status)} className='shrink-0'>
              {RUN_STATUS_LABELS[run.status]}
            </StatusBadge>
          ) : (
            <StatusBadge tone='neutral' className='shrink-0'>未连接</StatusBadge>
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
            {selectedIsFirst === false ? (
              <Alert variant='info' className='mx-3 mt-2'>
                <AlertDescription>
                  <p>
                    现在看到的是会话停着的这一页，不是执行到「{selectedStepName || '当前步骤'}」之后的页面。在这里点选只会记住要点哪里，不会打开菜单。要翻到下一页，请先保存并试跑已经保存的步骤。
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
            ) : null}
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
        ) : !runId || !run || isFinished || sessionQuery.isFetched ? (
          <div className='flex flex-col items-center justify-center p-8 text-center'>
            <div className='mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground'>
              <Monitor className='size-6' />
            </div>
            <h3 className='text-body font-medium'>{disconnected.title}</h3>
            <p className='mt-1 max-w-sm text-small text-muted-foreground'>{disconnected.body}</p>
            {canControlSession && targetId && targetAccountId ? (
              <div className='mt-4 flex flex-wrap items-center justify-center gap-2'>
                <Button disabled={connecting} onClick={() => void connectSession()}>
                  <Play />
                  {connecting ? '连接中…' : session?.lastAuthError ? '再试一次' : '连接受管会话'}
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
