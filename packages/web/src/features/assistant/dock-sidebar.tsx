import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAssistantStore } from '@/stores/assistant-store'
import { AssistantPanel } from './panel'
import { cn } from '@/lib/utils'

export function AssistantDockSidebar({
  open,
  onClose,
  onReturnFocus,
}: {
  open: boolean
  onClose: () => void
  onReturnFocus?: () => void
}) {
  const dockWidth = useAssistantStore((s) => s.dockWidth)
  const setDockWidth = useAssistantStore((s) => s.setDockWidth)
  const [resizing, setResizing] = useState(false)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const overlayRef = useRef<HTMLElement>(null)
  const dockRef = useRef<HTMLElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const wasNarrowRef = useRef(false)

  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 1280 : false,
  )

  useEffect(() => {
    const handleResize = () => {
      setIsNarrow(window.innerWidth < 1280)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // 初始打开焦点管理
  useEffect(() => {
    if (open && isNarrow) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const input = overlayRef.current?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
      input?.focus({ preventScroll: true })
    }
  }, [open, isNarrow])

  // 视口从窄变宽时的焦点保持
  useLayoutEffect(() => {
    if (open && wasNarrowRef.current && !isNarrow) {
      const input = dockRef.current?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
      ;(input ?? dockRef.current)?.focus({ preventScroll: true })
    }
    wasNarrowRef.current = open && isNarrow
  }, [open, isNarrow])

  const handleClose = () => {
    onClose()
    queueMicrotask(() => {
      const opener = openerRef.current
      if (opener?.isConnected && opener !== document.body) {
        opener.focus({ preventScroll: true })
      } else {
        onReturnFocus?.()
      }
    })
  }

  // 键盘事件: Escape 关闭，Tab 循环约束
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      handleClose()
      return
    }

    if (e.key === 'Tab') {
      const dialog = overlayRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)

      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first || !dialog.contains(document.activeElement)) {
          e.preventDefault()
          last?.focus()
        }
      } else {
        if (document.activeElement === last || !dialog.contains(document.activeElement)) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
  }

  useEffect(() => {
    if (!resizing) return

    const handlePointerMove = (e: PointerEvent) => {
      if (!resizeRef.current) return
      const deltaX = resizeRef.current.startX - e.clientX
      const nextWidth = resizeRef.current.startWidth + deltaX
      setDockWidth(nextWidth)
    }

    const handlePointerUp = () => {
      setResizing(false)
      resizeRef.current = null
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [resizing, setDockWidth])

  const handleStartResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    setResizing(true)
    resizeRef.current = {
      startX: e.clientX,
      startWidth: dockWidth,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  if (!open) return null

  // 小于 1280px 时降级为右侧滑出抽屉 Overlay
  if (isNarrow) {
    return createPortal(
      <div
        data-assistant-sidebar='true'
        data-state='open'
        className='fixed inset-0 z-50 flex justify-end bg-scrim/30 backdrop-blur-xs transition-opacity'
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose()
        }}
      >
        <aside
          ref={overlayRef}
          role='dialog'
          aria-label='识途助手伴随侧栏'
          aria-modal='true'
          data-assistant-sidebar='true'
          onKeyDown={handleKeyDown}
          className='relative flex h-full w-[90vw] max-w-[420px] flex-col border-s border-border-default bg-surface-card shadow-2xl animate-in slide-in-from-right duration-200'
        >
          <AssistantPanel onClose={handleClose} dragHandleProps={{}} isDocked />
        </aside>
      </div>,
      document.body,
    )
  }

  // 宽屏模式：常规文档流中的右侧停靠伴随栏
  return (
    <aside
      ref={dockRef}
      data-assistant-sidebar='true'
      role='region'
      aria-label='识途助手伴随侧栏'
      style={{ width: dockWidth }}
      className={cn(
        'sticky top-0 flex h-svh shrink-0 flex-col border-s border-border-default bg-surface-card transition-[width] duration-75',
        resizing && 'transition-none select-none',
      )}
    >
      {/* 拖拽微调宽度把手 */}
      <div
        role='separator'
        aria-orientation='vertical'
        aria-label='调整助手侧栏宽度'
        tabIndex={0}
        onPointerDown={handleStartResize}
        className='group absolute top-0 bottom-0 -start-1 z-10 w-2.5 cursor-col-resize select-none touch-none hover:bg-primary-500/15 active:bg-primary-500/25'
      >
        <div className='mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary-400 group-active:bg-primary-600' />
      </div>

      <AssistantPanel onClose={onClose} dragHandleProps={{}} isDocked />
    </aside>
  )
}
