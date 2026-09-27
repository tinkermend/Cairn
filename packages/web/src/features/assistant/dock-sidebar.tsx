import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAssistantStore } from '@/stores/assistant-store'
import { AssistantPanel } from './panel'
import { cn } from '@/lib/utils'

export function AssistantDockSidebar({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const dockWidth = useAssistantStore((s) => s.dockWidth)
  const setDockWidth = useAssistantStore((s) => s.setDockWidth)
  const [resizing, setResizing] = useState(false)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
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
        className='fixed inset-0 z-50 flex justify-end bg-scrim/30 backdrop-blur-xs transition-opacity'
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <aside
          role='dialog'
          aria-label='识途助手伴随侧栏'
          aria-modal='true'
          className='relative flex h-full w-[90vw] max-w-[420px] flex-col border-s border-border-default bg-surface-card shadow-2xl animate-in slide-in-from-right duration-200'
        >
          <AssistantPanel onClose={onClose} dragHandleProps={{}} isDocked />
        </aside>
      </div>,
      document.body,
    )
  }

  // 宽屏模式：常规文档流中的右侧停靠伴随栏
  return (
    <aside
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
