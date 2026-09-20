import { useEffect, useId, useRef, useState } from 'react'
import {
  AUTH_CONTROL_HEARTBEAT_SECONDS,
  hasAllPermissions,
  type BrowserAuthInputCommand,
  type ManagedBrowserFrame,
  type ManagedBrowserMeta,
  type PageRef,
} from '@cairn/shared'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import {
  acquireAuthControl as runAcquireAuthControl,
  fetchManagedBrowser as runFetchManagedBrowser,
  heartbeatAuthControl as runHeartbeatAuthControl,
  inputAuthControl as runInputAuthControl,
  releaseAuthControl as runReleaseAuthControl,
  resumeRunAuth as runResumeRunAuth,
  subscribeBrowserFrames as runSubscribeBrowserFrames,
} from '@/lib/runs-api'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { useAuthoringObserve } from '@/features/authoring'

const LIVE_VIEW_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'RECOVERING',
  'WAITING_FOR_AUTH',
  'HOLDING',
])

function isLiveViewRun(status: string) {
  return LIVE_VIEW_STATUSES.has(status)
}

function viewPlaceholder(input: {
  runStatus: string
  waiting: boolean
  controlling: boolean
  framesAvailable: boolean
  degradedReason: ManagedBrowserMeta['degradedReason']
  streamError: string | null
  connecting: boolean
}) {
  if (input.streamError) return input.streamError
  if (!isLiveViewRun(input.runStatus))
    return '运行已结束，实时画面已关闭。本次录像与步骤截图在结果里。'
  if (input.waiting && !input.controlling)
    return '取得登录权后才会显示认证画面，避免把验证码广播给其他观察者。'
  if (input.degradedReason === 'worker_generation_mismatch')
    return '执行面已更换，不能继续看这一轮画面。'
  if (input.degradedReason === 'worker_unreachable')
    return '执行面暂时不可达，仍显示会话所有权。'
  if (input.connecting) return '正在连接受管浏览器画面…'
  if (!input.framesAvailable)
    return '等待执行面就绪。会话建立后会自动开始抓取画面。'
  return '运行已结束，实时画面已关闭。本次录像与步骤截图在结果里。'
}

/** 展开后还没有帧时是加载中，不能写成「没有页面」。 */
export function isBrowserViewConnecting(input: {
  open: boolean
  hasFrame: boolean
  waitingWithoutControl: boolean
  degradedReason: ManagedBrowserMeta['degradedReason']
}) {
  return (
    input.open &&
    !input.hasFrame &&
    !input.waitingWithoutControl &&
    input.degradedReason !== 'worker_generation_mismatch'
  )
}

/** 画面是 object-contain，按整块按钮比例换算会点到留白而不是登录框。 */
function framePointFromClick(
  event: { currentTarget: HTMLElement; clientX: number; clientY: number },
  frame: { width: number; height: number }
): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect()
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  const x =
    (event.clientX - rect.left - (rect.width - frame.width * scale) / 2) / scale
  const y =
    (event.clientY - rect.top - (rect.height - frame.height * scale) / 2) /
    scale
  return { x, y }
}

export type BrowserTransport = {
  fetchManagedBrowser: typeof runFetchManagedBrowser
  acquireAuthControl: typeof runAcquireAuthControl
  heartbeatAuthControl: typeof runHeartbeatAuthControl
  inputAuthControl: typeof runInputAuthControl
  releaseAuthControl: typeof runReleaseAuthControl
  resumeRunAuth: (id: string, body: { token?: string }) => Promise<unknown>
  subscribeBrowserFrames: typeof runSubscribeBrowserFrames
}
const runTransport: BrowserTransport = {
  fetchManagedBrowser: runFetchManagedBrowser,
  acquireAuthControl: runAcquireAuthControl,
  heartbeatAuthControl: runHeartbeatAuthControl,
  inputAuthControl: runInputAuthControl,
  releaseAuthControl: runReleaseAuthControl,
  resumeRunAuth: runResumeRunAuth,
  subscribeBrowserFrames: runSubscribeBrowserFrames,
}

type Props = {
  runId: string
  runStatus: string
  eventSeq?: number
  onRunChanged?: () => void
  transport?: BrowserTransport
  sessionMode?: boolean
  observationConnected?: boolean
  onRefreshLogin?: (pageRef: PageRef) => Promise<unknown>
}

export function BrowserView({
  runId,
  runStatus,
  eventSeq = 0,
  onRunChanged,
  transport = runTransport,
  sessionMode = false,
  observationConnected = true,
  onRefreshLogin,
}: Props) {
  const {
    fetchManagedBrowser,
    acquireAuthControl,
    heartbeatAuthControl,
    inputAuthControl,
    releaseAuthControl,
    resumeRunAuth,
    subscribeBrowserFrames,
  } = transport
  const observe = useAuthoringObserve()
  const user = useAuthStore((state) => state.auth.user)
  const canView = Boolean(
    user &&
    hasAllPermissions(user.permissions, [
      sessionMode ? 'session:read' : 'run:read',
      'session:view',
    ])
  )
  const canControl = Boolean(
    user &&
    hasAllPermissions(
      user.permissions,
      sessionMode ? ['session:control'] : ['session:control', 'run:execute']
    )
  )
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<ManagedBrowserMeta | null>(null)
  const [frame, setFrame] = useState<ManagedBrowserFrame | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [pageRef, setPageRef] = useState<PageRef | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [viewPageId, setViewPageId] = useState<string | undefined>()
  const [streamError, setStreamError] = useState<string | null>(null)
  const seq = useRef(0)
  const composing = useRef(false)
  const tokenRef = useRef<string | null>(null)
  const inputId = useId()
  tokenRef.current = token

  useEffect(() => {
    if (!sessionMode && isLiveViewRun(runStatus)) setOpen(true)
  }, [runId, runStatus, sessionMode])

  useEffect(() => {
    if (!canView) return
    if (!open && (sessionMode || !isLiveViewRun(runStatus))) return
    let cancelled = false
    let timer = 0
    const load = () => {
      void fetchManagedBrowser(runId, viewPageId)
        .then((next) => {
          if (cancelled) return
          setMeta(next)
          const waitingAuthGate =
            next.runStatus === 'WAITING_FOR_AUTH' && !tokenRef.current
          const needRetry =
            open &&
            isLiveViewRun(runStatus) &&
            !next.framesAvailable &&
            next.degradedReason !== 'worker_generation_mismatch' &&
            !waitingAuthGate
          if (needRetry) timer = window.setTimeout(load, 800)
        })
        .catch((error) => {
          if (cancelled) return
          toast.error(
            error instanceof ApiRequestError
              ? error.message
              : '无法读取浏览器状态'
          )
          if (open && isLiveViewRun(runStatus))
            timer = window.setTimeout(load, 1600)
        })
    }
    load()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    open,
    canView,
    runId,
    runStatus,
    viewPageId,
    token,
    fetchManagedBrowser,
    sessionMode,
  ])

  useEffect(() => {
    if (!canView || !open || !eventSeq) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void fetchManagedBrowser(runId, viewPageId)
        .then((next) => {
          if (!cancelled) setMeta(next)
        })
        .catch(() => undefined)
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [eventSeq, open, canView, runId, viewPageId, fetchManagedBrowser])

  useEffect(() => {
    return () => {
      const held = tokenRef.current
      if (held)
        void releaseAuthControl(runId, { token: held }).catch(() => undefined)
    }
  }, [runId, releaseAuthControl])

  useEffect(() => {
    if (!open || !canView || !meta?.framesAvailable) {
      setFrame(null)
      setStreamError(null)
      return
    }
    let cancelled = false
    let retryTimer = 0
    let controller: AbortController | null = null
    const connect = () => {
      if (cancelled) return
      controller = new AbortController()
      setStreamError(null)
      void subscribeBrowserFrames(runId, {
        signal: controller.signal,
        pageId: viewPageId,
        onFrame: (next) => {
          setStreamError(null)
          setFrame(next)
        },
      })
        .then(() => {
          if (cancelled || controller?.signal.aborted) return
          if (!isLiveViewRun(runStatus)) return
          const held = tokenRef.current
          if (held)
            void releaseAuthControl(runId, { token: held }).catch(
              () => undefined
            )
          setToken(null)
          setFrame(null)
          setStreamError('画面流已中断，正在重连…')
          retryTimer = window.setTimeout(connect, 800)
        })
        .catch((error) => {
          if (cancelled || controller?.signal.aborted) return
          const message =
            error instanceof ApiRequestError
              ? error.message
              : '无法订阅受管浏览器画面'
          const held = tokenRef.current
          if (held)
            void releaseAuthControl(runId, { token: held }).catch(
              () => undefined
            )
          setToken(null)
          setFrame(null)
          setStreamError(message)
          toast.error(message)
          if (isLiveViewRun(runStatus))
            retryTimer = window.setTimeout(connect, 1600)
        })
    }
    connect()
    return () => {
      cancelled = true
      controller?.abort()
      window.clearTimeout(retryTimer)
    }
  }, [
    open,
    canView,
    runId,
    runStatus,
    viewPageId,
    meta?.framesAvailable,
    meta?.authControl?.epoch,
    subscribeBrowserFrames,
    releaseAuthControl,
  ])

  useEffect(() => {
    if (!token || !canControl) return
    let cancelled = false
    let timer = 0
    const beat = () => {
      if (cancelled || !token) return
      void Promise.resolve(heartbeatAuthControl(runId, { token }))
        .then((next) => {
          if (!cancelled && next) setExpiresAt(next.expiresAt)
        })
        .catch(() => {
          if (!cancelled) {
            setToken(null)
            toast.error('登录控制权已失效')
          }
        })
        .finally(() => {
          if (!cancelled)
            timer = window.setTimeout(
              beat,
              AUTH_CONTROL_HEARTBEAT_SECONDS * 1000
            )
        })
    }
    timer = window.setTimeout(beat, AUTH_CONTROL_HEARTBEAT_SECONDS * 1000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [token, canControl, runId, heartbeatAuthControl])

  useEffect(() => {
    if (
      !observationConnected ||
      !canControl ||
      !open ||
      runStatus !== 'WAITING_FOR_AUTH'
    ) {
      const held = tokenRef.current
      tokenRef.current = null
      setToken(null)
      if (held)
        void releaseAuthControl(runId, { token: held }).catch(() => undefined)
    }
  }, [
    observationConnected,
    canControl,
    open,
    runStatus,
    runId,
    releaseAuthControl,
  ])

  if (!canView) return null

  const waiting = runStatus === 'WAITING_FOR_AUTH'
  const holding = runStatus === 'HOLDING'
  const picking = holding && observe.pickMode
  const highlightBox = observe.highlight?.preview?.box
  const controlling = Boolean(token && observationConnected && canControl)
  const connecting = isBrowserViewConnecting({
    open,
    hasFrame: Boolean(frame),
    waitingWithoutControl: waiting && !controlling,
    degradedReason: meta?.degradedReason ?? null,
  })
  const remain =
    expiresAt && Date.parse(expiresAt)
      ? Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))
      : null

  type DistributiveOmit<T, K extends keyof any> = T extends any
    ? Omit<T, K>
    : never
  type BrowserAuthInputPayload = DistributiveOmit<
    BrowserAuthInputCommand,
    'pageRef' | 'commandId' | 'seq' | 'frameId' | 'viewport'
  >

  const sendCommand = (partial: BrowserAuthInputPayload) => {
    if (!token || !pageRef || !frame || !observationConnected || !canControl)
      return
    seq.current += 1
    const command = {
      ...partial,
      pageRef: frame.pageRef,
      commandId: crypto.randomUUID(),
      seq: seq.current,
      frameId: frame.frameId,
      viewport: { width: frame.width, height: frame.height },
    } as BrowserAuthInputCommand
    void inputAuthControl(runId, { token, command }).catch((error) => {
      if (
        error instanceof ApiRequestError &&
        (error.status === 401 ||
          error.status === 403 ||
          error.payload.code.startsWith('AUTH_'))
      )
        setToken(null)
      toast.error(
        error instanceof ApiRequestError ? error.message : '输入被拒绝'
      )
    })
  }

  return (
    <section
      aria-label='受管浏览器'
      className='rounded-lg border border-border-card bg-card p-5 shadow-card'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h2 className='text-section font-semibold'>受管浏览器</h2>
          <p className='mt-1 text-label text-muted-foreground'>
            {waiting
              ? '需要目标系统登录。画面只发给当前控制者。'
              : holding
                ? '调试挂起中。指认在画面上点选，校验框画在叠加层，不会改目标页。'
                : sessionMode
                  ? '按需查看会话画面，离开或收起后停止采集。'
                  : isLiveViewRun(runStatus)
                    ? '只读跟随当前执行页。在途运行会自动展开画面。'
                    : '只读跟随当前执行页。运行结束后不再抓取实时画面。'}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          {meta?.degradedReason ? (
            <StatusBadge tone='warning'>画面不可用</StatusBadge>
          ) : null}
          {frame ? <StatusBadge tone='success'>画面已连接</StatusBadge> : null}
          {controlling ? (
            <StatusBadge tone='warning'>正在输入</StatusBadge>
          ) : null}
          <Button variant='outline' onClick={() => setOpen((value) => !value)}>
            {open ? '收起画面' : '展开画面'}
          </Button>
        </div>
      </div>
      {waiting && canControl && !controlling ? (
        <div className='mt-4 flex flex-wrap gap-2'>
          <Button
            disabled={
              busy ||
              !observationConnected ||
              Boolean(
                meta?.authControl?.actorId && !meta.authControl.heldByViewer
              )
            }
            onClick={() => {
              setBusy(true)
              void acquireAuthControl(runId)
                .then((granted) => {
                  setToken(granted.token)
                  setPageRef(granted.pageRef)
                  setExpiresAt(granted.expiresAt)
                  setMeta(granted.meta)
                  setOpen(true)
                  toast.success('已取得登录输入权')
                })
                .catch((error) => {
                  toast.error(
                    error instanceof ApiRequestError
                      ? error.message
                      : '无法取得输入权'
                  )
                })
                .finally(() => setBusy(false))
            }}
          >
            处理登录
          </Button>
          {meta?.authControl?.actorId && !meta.authControl.heldByViewer ? (
            <p className='self-center text-small text-muted-foreground'>
              由其他用户处理登录
            </p>
          ) : null}
        </div>
      ) : null}
      {controlling ? (
        <div className='mt-4 flex flex-wrap gap-2'>
          {onRefreshLogin ? (
            <Button
              variant='outline'
              disabled={busy || !pageRef}
              onClick={() => {
                const ref = frame?.pageRef ?? pageRef
                if (!ref) return
                setBusy(true)
                void onRefreshLogin(ref)
                  .catch((error) => toast.error(error.message))
                  .finally(() => setBusy(false))
              }}
            >
              刷新登录页
            </Button>
          ) : null}
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void resumeRunAuth(runId, { token: token ?? undefined })
                .then(() => {
                  setToken(null)
                  toast.success(
                    sessionMode
                      ? '已完成认证'
                      : '已确认目标系统登录，等待再次领取'
                  )
                  onRunChanged?.()
                })
                .catch((error) => {
                  toast.error(
                    error instanceof ApiRequestError
                      ? error.message
                      : '仍未登录，请继续处理'
                  )
                })
                .finally(() => setBusy(false))
            }}
          >
            {sessionMode ? '完成认证' : '登录完成，继续运行'}
          </Button>
          <Button
            variant='outline'
            disabled={busy || !token}
            onClick={() => {
              if (!token) return
              setBusy(true)
              void releaseAuthControl(runId, { token })
                .then(() => {
                  setToken(null)
                  toast.success('已放弃控制')
                  onRunChanged?.()
                })
                .catch((error) => {
                  toast.error(
                    error instanceof ApiRequestError
                      ? error.message
                      : '撤权失败'
                  )
                })
                .finally(() => setBusy(false))
            }}
          >
            放弃控制
          </Button>
        </div>
      ) : null}
      {open ? (
        <div className='mt-4 space-y-4'>
          {meta && meta.pages.length > 1 ? (
            <div className='space-y-2'>
              <p className='text-label text-muted-foreground'>
                查看其他受管页不会改变执行当前页。
              </p>
              <div className='flex flex-wrap gap-2'>
                {meta.pages.map((page) => {
                  const selected =
                    (viewPageId ?? meta.currentPage?.pageRef.pageId) ===
                    page.pageRef.pageId
                  return (
                    <Button
                      key={page.pageRef.pageId}
                      size='sm'
                      variant={selected ? 'secondary' : 'outline'}
                      onClick={() => setViewPageId(page.pageRef.pageId)}
                    >
                      {page.kind}
                      {page.currentExecution ? ' · 执行页' : ''}
                    </Button>
                  )
                })}
              </div>
            </div>
          ) : null}
          {meta?.viewingOtherPage ? (
            <p className='text-small text-status-warning-foreground'>
              正在查看其他页面，不会改变执行当前页。
            </p>
          ) : null}
          {meta?.currentPage ? (
            <p className='text-label text-muted-foreground'>
              当前执行页 {meta.currentPage.kind}
              {frame ? ` · ${frame.width}×${frame.height}` : ''}
            </p>
          ) : (
            <p className='text-small text-muted-foreground'>
              {meta?.degradedReason === 'worker_unreachable'
                ? '执行面暂时不可达，仍显示会话所有权。'
                : connecting
                  ? '正在连接受管浏览器画面…'
                  : '还没有可观察的受管页面。'}
            </p>
          )}
          {frame && meta?.capabilities.screencast !== 'closed' ? (
            <button
              type='button'
              className='relative block w-full overflow-hidden rounded-md border border-border-default bg-muted'
              disabled={!controlling && !picking}
              onClick={(event) => {
                if (picking) {
                  const point = framePointFromClick(event, frame)
                  observe.pickAt(point.x, point.y)
                  return
                }
                if (!controlling) return
                sendCommand({
                  type: 'mouse_click',
                  ...framePointFromClick(event, frame),
                  button: 'left',
                })
              }}
              onWheel={(event) => {
                if (!controlling) return
                event.preventDefault()
                sendCommand({
                  type: 'mouse_wheel',
                  x: 0,
                  y: 0,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                })
              }}
            >
              <img
                src={frame.image}
                alt='受管浏览器当前画面'
                className='max-h-[28rem] w-full object-contain'
              />
              {highlightBox ? (
                <svg
                  className='pointer-events-none absolute inset-0 h-full w-full'
                  viewBox={`0 0 ${frame.width} ${frame.height}`}
                  preserveAspectRatio='xMidYMid meet'
                  aria-hidden
                >
                  <rect
                    x={highlightBox.x}
                    y={highlightBox.y}
                    width={highlightBox.width}
                    height={highlightBox.height}
                    fill='none'
                    stroke='var(--action-primary)'
                    strokeWidth={2}
                  />
                </svg>
              ) : null}
            </button>
          ) : (
            <div
              role='status'
              className='flex min-h-56 items-center justify-center rounded-md border border-dashed border-border-default bg-muted px-4 py-8 text-center text-small text-muted-foreground'
            >
              {viewPlaceholder({
                runStatus,
                waiting,
                controlling,
                framesAvailable: Boolean(meta?.framesAvailable),
                degradedReason: meta?.degradedReason ?? null,
                streamError,
                connecting,
              })}
            </div>
          )}
          {controlling && meta?.capabilities.authInput !== 'closed' ? (
            <div className='space-y-2'>
              <label
                className='text-label text-muted-foreground'
                htmlFor={inputId}
              >
                输入将作用于目标系统。中文请先组字再发送。
              </label>
              <input
                id={inputId}
                className='w-full rounded-md border border-border-default bg-background px-3 py-2 text-body'
                placeholder='输入文本后按回车发送'
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={(event) => {
                  composing.current = false
                  const text = event.currentTarget.value.trim()
                  if (
                    text &&
                    meta?.capabilities.chineseInsertText !== 'closed'
                  ) {
                    sendCommand({ type: 'insert_text', text })
                  }
                  event.currentTarget.value = ''
                }}
                onKeyDown={(event) => {
                  if (composing.current) return
                  if (
                    event.key === 'Enter' &&
                    event.currentTarget.value.trim()
                  ) {
                    sendCommand({
                      type: 'insert_text',
                      text: event.currentTarget.value,
                    })
                    event.currentTarget.value = ''
                    event.preventDefault()
                    return
                  }
                  if (
                    event.key === 'Enter' ||
                    event.key === 'Tab' ||
                    event.key === 'Escape' ||
                    event.key === 'Backspace'
                  ) {
                    sendCommand({ type: 'key', key: event.key })
                  }
                }}
              />
              {remain !== null ? (
                <p className='text-label text-muted-foreground'>
                  控制权剩余 {remain} 秒
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
