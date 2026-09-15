import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { assistantIcon } from './icon'

const POSITION_KEY = 'cairn:assistant-launcher-position:v1'
const SIZE = 56
const EDGE = 8
const DRAG_THRESHOLD = 6
type Point = { x: number; y: number }
type Viewport = { width: number; height: number }

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

function limits(view: Viewport) {
  const right = Math.max(0, view.width - SIZE - EDGE)
  const bottom = Math.max(0, view.height - SIZE - EDGE)
  return {
    left: Math.min(EDGE, right),
    top: Math.min(EDGE, bottom),
    right,
    bottom,
  }
}

function readPosition(): Point | null {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(POSITION_KEY) ?? 'null'
    )
    if (saved && typeof saved === 'object' && 'x' in saved && 'y' in saved) {
      const { x, y } = saved
      if (
        typeof x === 'number' &&
        typeof y === 'number' &&
        Number.isFinite(x) &&
        Number.isFinite(y)
      ) {
        return {
          x: Math.min(1, Math.max(0, x)),
          y: Math.min(1, Math.max(0, y)),
        }
      }
    }
  } catch {
    // A browser preference must never prevent the assistant from opening.
  }
  return null
}

function savePosition(position: Point | null) {
  try {
    if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    else localStorage.removeItem(POSITION_KEY)
  } catch {
    // The current position remains usable even if storage is unavailable.
  }
}

function pixels(position: Point | null, view: Viewport): Point {
  const b = limits(view)
  return position
    ? {
        x: b.left + position.x * (b.right - b.left),
        y: b.top + position.y * (b.bottom - b.top),
      }
    : { x: Math.max(b.left, b.right - 16), y: Math.max(b.top, b.bottom - 16) }
}

function relative(point: Point): Point {
  const b = limits(viewport())
  return {
    x:
      b.right > b.left
        ? Math.max(0, Math.min(1, (point.x - b.left) / (b.right - b.left)))
        : 0,
    y:
      b.bottom > b.top
        ? Math.max(0, Math.min(1, (point.y - b.top) / (b.bottom - b.top)))
        : 0,
  }
}

type Drag = {
  pointerId: number
  start: Point
  origin: Point
  saved: Point | null
  last: Point | null
  moved: boolean
}

export function AssistantLauncher({
  onOpen,
  buttonRef,
}: {
  onOpen: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}) {
  const [position, setPosition] = useState(readPosition)
  const [view, setView] = useState(viewport)
  const [dragging, setDragging] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const point = pixels(position, view)

  useEffect(() => {
    const resize = () => setView(viewport())
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  function finishDrag(cancelled: boolean) {
    const active = drag.current
    if (!active) return
    drag.current = null
    setDragging(false)
    suppressClick.current = active.moved || cancelled
    if (cancelled) setPosition(active.saved)
    else if (active.moved) savePosition(active.last)
    if (buttonRef.current?.hasPointerCapture(active.pointerId))
      buttonRef.current.releasePointerCapture(active.pointerId)
  }

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current) return
    suppressClick.current = false
    setControlsOpen(false)
    const rect = event.currentTarget.getBoundingClientRect()
    drag.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { x: rect.left, y: rect.top },
      saved: position,
      last: position,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    const dx = event.clientX - active.start.x
    const dy = event.clientY - active.start.y
    if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    event.preventDefault()
    active.moved = true
    active.last = relative({ x: active.origin.x + dx, y: active.origin.y + dy })
    setPosition(active.last)
    setDragging(true)
  }

  function move(dx: number, dy: number) {
    const next = relative({ x: point.x + dx, y: point.y + dy })
    setPosition(next)
    savePosition(next)
  }

  function reset() {
    setPosition(null)
    savePosition(null)
  }

  return (
    <Popover open={controlsOpen} onOpenChange={setControlsOpen}>
      <PopoverAnchor asChild>
        <Button
          ref={buttonRef}
          type='button'
          variant='ghost'
          size='icon'
          className='fixed z-30 size-14 cursor-grab touch-none rounded-full border-0 bg-transparent p-0 shadow-none select-none hover:bg-transparent active:bg-transparent data-[dragging=true]:cursor-grabbing'
          style={{ left: point.x, top: point.y }}
          data-dragging={dragging || undefined}
          aria-label='打开识途助手'
          aria-description='点击打开，按住可拖动。右键打开位置控件，也可用方向键移动，Home 键重置位置。'
          title='识途助手 · 按住拖动，右键调整位置'
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={(event) => {
            if (event.pointerId === drag.current?.pointerId) finishDrag(false)
          }}
          onPointerCancel={(event) => {
            if (event.pointerId === drag.current?.pointerId) finishDrag(true)
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerId === drag.current?.pointerId) finishDrag(true)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            finishDrag(true)
            setControlsOpen(true)
          }}
          onClick={(event) => {
            if (suppressClick.current && event.detail > 0) {
              suppressClick.current = false
              event.preventDefault()
              return
            }
            onOpen()
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 40 : 12
            const directions: Record<string, Point> = {
              ArrowLeft: { x: -step, y: 0 },
              ArrowRight: { x: step, y: 0 },
              ArrowUp: { x: 0, y: -step },
              ArrowDown: { x: 0, y: step },
            }
            if (directions[event.key]) {
              event.preventDefault()
              move(directions[event.key].x, directions[event.key].y)
            } else if (event.key === 'Home') {
              event.preventDefault()
              reset()
            } else if (event.key === 'Escape' && drag.current) {
              event.preventDefault()
              finishDrag(true)
            } else if (
              event.key === 'ContextMenu' ||
              (event.shiftKey && event.key === 'F10')
            ) {
              event.preventDefault()
              setControlsOpen(true)
            }
          }}
        >
          <img
            {...assistantIcon}
            sizes='70px'
            alt=''
            draggable={false}
            className='pointer-events-none size-full object-cover select-none'
            width={SIZE}
            height={SIZE}
          />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        aria-label='调整助手位置'
        className='w-auto space-y-2 p-3'
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          buttonRef.current?.focus({ preventScroll: true })
        }}
      >
        <p className='text-label text-muted-foreground'>移动助手</p>
        <div className='grid grid-cols-3 gap-1'>
          <Button
            variant='ghost'
            size='icon'
            className='col-start-2 size-11'
            aria-label='向上移动助手'
            onClick={() => move(0, -24)}
          >
            <ArrowUp />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='col-start-1 size-11'
            aria-label='向左移动助手'
            onClick={() => move(-24, 0)}
          >
            <ArrowLeft />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='size-11'
            aria-label='重置助手位置'
            onClick={reset}
          >
            <RotateCcw />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='size-11'
            aria-label='向右移动助手'
            onClick={() => move(24, 0)}
          >
            <ArrowRight />
          </Button>
          <Button
            variant='ghost'
            size='icon'
            className='col-start-2 size-11'
            aria-label='向下移动助手'
            onClick={() => move(0, 24)}
          >
            <ArrowDown />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
