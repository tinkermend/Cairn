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
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import {
  acquireAuthControl,
  fetchManagedBrowser,
  heartbeatAuthControl,
  inputAuthControl,
  releaseAuthControl,
  resumeRunAuth,
  subscribeBrowserFrames,
} from '@/lib/runs-api'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'

/** 画面是 object-contain，按整块按钮比例换算会点到留白而不是登录框。 */
function framePointFromClick(
  event: { currentTarget: HTMLElement; clientX: number; clientY: number },
  frame: { width: number; height: number },
): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect()
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  const x = (event.clientX - rect.left - (rect.width - frame.width * scale) / 2) / scale
  const y = (event.clientY - rect.top - (rect.height - frame.height * scale) / 2) / scale
  return { x, y }
}

type Props = {
  runId: string
  runStatus: string
  eventSeq?: number
  onRunChanged?: () => void
}

export function BrowserView({ runId, runStatus, eventSeq = 0, onRunChanged }: Props) {
  const user = useAuthStore((state) => state.auth.user)
  const canView = Boolean(user && hasAllPermissions(user.permissions, ['run:read', 'session:view']))
  const canControl = Boolean(user && hasAllPermissions(user.permissions, ['session:control', 'run:execute']))
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<ManagedBrowserMeta | null>(null)
  const [frame, setFrame] = useState<ManagedBrowserFrame | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [pageRef, setPageRef] = useState<PageRef | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [viewPageId, setViewPageId] = useState<string | undefined>()
  const seq = useRef(0)
  const composing = useRef(false)
  const tokenRef = useRef<string | null>(null)
  const inputId = useId()
  tokenRef.current = token

  useEffect(() => {
    if (!canView) return
    if (!open && runStatus !== 'WAITING_FOR_AUTH') return
    let cancelled = false
    void fetchManagedBrowser(runId, viewPageId)
      .then((next) => {
        if (!cancelled) setMeta(next)
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof ApiRequestError ? error.message : '无法读取浏览器状态')
      })
    return () => {
      cancelled = true
    }
  }, [open, canView, runId, runStatus, eventSeq, viewPageId])

  useEffect(() => {
    return () => {
      const held = tokenRef.current
      if (held) void releaseAuthControl(runId, { token: held }).catch(() => undefined)
    }
  }, [runId])

  useEffect(() => {
    if (!open || !canView || !meta?.framesAvailable) {
      setFrame(null)
      return
    }
    const controller = new AbortController()
    void subscribeBrowserFrames(runId, {
      signal: controller.signal,
      pageId: viewPageId,
      onFrame: (next) => setFrame(next),
    }).catch(() => undefined)
    return () => controller.abort()
  }, [open, canView, runId, viewPageId, meta?.framesAvailable, meta?.authControl?.epoch])

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
          if (!cancelled) timer = window.setTimeout(beat, AUTH_CONTROL_HEARTBEAT_SECONDS * 1000)
        })
    }
    timer = window.setTimeout(beat, AUTH_CONTROL_HEARTBEAT_SECONDS * 1000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [token, canControl, runId])

  if (!canView) return null

  const waiting = runStatus === 'WAITING_FOR_AUTH'
  const controlling = Boolean(token)
  const remain =
    expiresAt && Date.parse(expiresAt)
      ? Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))
      : null

  const sendCommand = (partial: Omit<BrowserAuthInputCommand, 'pageRef' | 'commandId' | 'seq' | 'frameId' | 'viewport'>) => {
    if (!token || !pageRef || !frame) return
    seq.current += 1
    const command = {
      ...partial,
      pageRef,
      commandId: crypto.randomUUID(),
      seq: seq.current,
      frameId: frame.frameId,
      viewport: { width: frame.width, height: frame.height },
    } as BrowserAuthInputCommand
    void inputAuthControl(runId, { token, command }).catch((error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '输入被拒绝')
    })
  }

  return (
    <section aria-label='受管浏览器' className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h2 className='text-section font-semibold'>受管浏览器</h2>
          <p className='mt-1 text-label text-muted-foreground'>
            {waiting ? '需要目标系统登录。画面只发给当前控制者。' : '只读跟随当前执行页。展开后才抓取画面。'}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          {meta?.degradedReason ? <StatusBadge tone='warning'>画面不可用</StatusBadge> : null}
          {controlling ? <StatusBadge tone='warning'>正在输入</StatusBadge> : null}
          <Button variant='outline' onClick={() => setOpen((value) => !value)}>
            {open ? '收起画面' : '展开画面'}
          </Button>
        </div>
      </div>
      {waiting && canControl && !controlling ? (
        <div className='mt-4 flex flex-wrap gap-2'>
          <Button
            disabled={busy || Boolean(meta?.authControl?.actorId && !meta.authControl.heldByViewer)}
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
                  toast.error(error instanceof ApiRequestError ? error.message : '无法取得输入权')
                })
                .finally(() => setBusy(false))
            }}
          >
            处理登录
          </Button>
          {meta?.authControl?.actorId && !meta.authControl.heldByViewer ? (
            <p className='self-center text-small text-muted-foreground'>由其他用户处理登录</p>
          ) : null}
        </div>
      ) : null}
      {controlling ? (
        <div className='mt-4 flex flex-wrap gap-2'>
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void resumeRunAuth(runId, { token: token ?? undefined })
                .then(() => {
                  setToken(null)
                  toast.success('已确认目标系统登录，等待再次领取')
                  onRunChanged?.()
                })
                .catch((error) => {
                  toast.error(error instanceof ApiRequestError ? error.message : '仍未登录，请继续处理')
                })
                .finally(() => setBusy(false))
            }}
          >
            登录完成，继续运行
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
                  toast.error(error instanceof ApiRequestError ? error.message : '撤权失败')
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
              <p className='text-label text-muted-foreground'>查看其他受管页不会改变执行当前页。</p>
              <div className='flex flex-wrap gap-2'>
                {meta.pages.map((page) => {
                  const selected = (viewPageId ?? meta.currentPage?.pageRef.pageId) === page.pageRef.pageId
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
            <p className='text-small text-status-warning-foreground'>正在查看其他页面，不会改变执行当前页。</p>
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
                : '还没有可观察的受管页面。'}
            </p>
          )}
          {frame && meta?.capabilities.screencast !== 'closed' ? (
            <button
              type='button'
              className='relative block w-full overflow-hidden rounded-md border border-border-default bg-muted'
              disabled={!controlling}
              onClick={(event) => {
                if (!controlling) return
                sendCommand({ type: 'mouse_click', ...framePointFromClick(event, frame), button: 'left' })
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
              <img src={frame.image} alt='受管浏览器当前画面' className='max-h-[28rem] w-full object-contain' />
            </button>
          ) : null}
          {controlling && meta?.capabilities.authInput !== 'closed' ? (
            <div className='space-y-2'>
              <label className='text-label text-muted-foreground' htmlFor={inputId}>
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
                  if (text && meta.capabilities.chineseInsertText !== 'closed') {
                    sendCommand({ type: 'insert_text', text })
                  }
                  event.currentTarget.value = ''
                }}
                onKeyDown={(event) => {
                  if (composing.current) return
                  if (event.key === 'Enter' && event.currentTarget.value.trim()) {
                    sendCommand({ type: 'insert_text', text: event.currentTarget.value })
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
              {remain !== null ? <p className='text-label text-muted-foreground'>控制权剩余 {remain} 秒</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
