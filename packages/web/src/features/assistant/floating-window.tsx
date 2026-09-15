import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { AssistantPanel } from './panel'

const WIDTH = 400
const HEIGHT = 600
type Position = { x: number; y: number }
type Viewport = { width: number; height: number; left: number; top: number }

function viewport(): Viewport {
  const view = window.visualViewport
  return {
    width: view?.width ?? window.innerWidth,
    height: view?.height ?? window.innerHeight,
    left: view?.offsetLeft ?? 0,
    top: view?.offsetTop ?? 0,
  }
}

function frame(view: Viewport, position: Position) {
  const edge = view.width < 640 ? 12 : 24
  const width = Math.min(WIDTH, Math.max(0, view.width - edge * 2))
  const height = Math.min(HEIGHT, Math.max(0, view.height - edge * 2))
  const rangeX = Math.max(0, view.width - width - edge * 2)
  const rangeY = Math.max(0, view.height - height - edge * 2)
  return {
    width,
    height,
    left: view.left + edge + position.x * rangeX,
    top: view.top + edge + position.y * rangeY,
    rangeX,
    rangeY,
    edge,
  }
}

function positionAt(left: number, top: number, view: Viewport): Position {
  const bounds = frame(view, { x: 1, y: 1 })
  return {
    x: bounds.rangeX
      ? Math.max(
          0,
          Math.min(1, (left - view.left - bounds.edge) / bounds.rangeX)
        )
      : 1,
    y: bounds.rangeY
      ? Math.max(0, Math.min(1, (top - view.top - bounds.edge) / bounds.rangeY))
      : 1,
  }
}

type Drag = {
  pointerId: number
  x: number
  y: number
  left: number
  top: number
  start: Position
  handle: HTMLElement
}

export function AssistantFloatingWindow({
  open,
  onClose,
  onReturnFocus,
}: {
  open: boolean
  onClose: () => void
  onReturnFocus: () => void
}) {
  const [position, setPosition] = useState<Position>({ x: 1, y: 1 })
  const [view, setView] = useState(viewport)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<Drag | null>(null)
  const windowRef = useRef<HTMLElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef(onReturnFocus)
  const bounds = frame(view, position)

  useLayoutEffect(() => {
    returnFocusRef.current = onReturnFocus
  }, [onReturnFocus])

  useLayoutEffect(() => {
    if (!open) return
    const update = () => setView(viewport())
    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const assistantWindow = windowRef.current
    const input = assistantWindow?.querySelector<HTMLTextAreaElement>(
      'textarea:not(:disabled)'
    )
    ;(input ?? windowRef.current)?.focus({ preventScroll: true })
    return () => {
      drag.current = null
      // The launcher remounts in the same commit as the window closes.
      queueMicrotask(() => {
        if (assistantWindow?.isConnected) return
        const opener = openerRef.current
        if (opener?.isConnected && opener !== document.body)
          opener.focus({ preventScroll: true })
        else returnFocusRef.current()
      })
    }
  }, [open])

  function finish(cancelled: boolean) {
    const active = drag.current
    if (!active) return
    drag.current = null
    setDragging(false)
    if (cancelled) setPosition(active.start)
    if (active.handle.hasPointerCapture(active.pointerId))
      active.handle.releasePointerCapture(active.pointerId)
  }

  const handle: HTMLAttributes<HTMLElement> = {
    tabIndex: 0,
    role: 'group',
    'aria-label': '移动助手窗口',
    'aria-description':
      '按住标题栏拖动，方向键移动，双击或 Home 键回到右下角。',
    title: '按住拖动 · 双击回到右下角',
    onPointerDown: (event) => {
      if (
        event.button !== 0 ||
        drag.current ||
        (event.target instanceof Element && event.target.closest('button'))
      )
        return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      const rect = windowRef.current!.getBoundingClientRect()
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        start: position,
        handle: event.currentTarget,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event) => {
      const active = drag.current
      if (!active || active.pointerId !== event.pointerId) return
      const dx = event.clientX - active.x
      const dy = event.clientY - active.y
      if (!dragging && Math.hypot(dx, dy) < 4) return
      event.preventDefault()
      setDragging(true)
      setPosition(positionAt(active.left + dx, active.top + dy, viewport()))
    },
    onPointerUp: (event) => {
      if (event.pointerId === drag.current?.pointerId) finish(false)
    },
    onPointerCancel: (event) => {
      if (event.pointerId === drag.current?.pointerId) finish(true)
    },
    onLostPointerCapture: (event) => {
      if (event.pointerId === drag.current?.pointerId) finish(true)
    },
    onDoubleClick: (event) => {
      if (event.target instanceof Element && event.target.closest('button'))
        return
      setPosition({ x: 1, y: 1 })
    },
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault()
        event.stopPropagation()
        finish(true)
        return
      }
      const step = event.shiftKey ? 40 : 12
      const directions: Record<string, Position> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      }
      const direction = directions[event.key]
      if (direction) {
        event.preventDefault()
        setPosition(
          positionAt(
            bounds.left + direction.x,
            bounds.top + direction.y,
            viewport()
          )
        )
      } else if (event.key === 'Home') {
        event.preventDefault()
        setPosition({ x: 1, y: 1 })
      }
    },
  }

  if (!open) return null
  return createPortal(
    <section
      ref={windowRef}
      role='dialog'
      aria-modal='false'
      aria-labelledby='assistant-window-title'
      aria-describedby='assistant-window-description'
      tabIndex={-1}
      data-dragging={dragging || undefined}
      className='fixed z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-popover outline-none'
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <AssistantPanel onClose={onClose} dragHandleProps={handle} />
    </section>,
    document.body
  )
}
