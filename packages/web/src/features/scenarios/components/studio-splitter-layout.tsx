import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type StudioViewPreset = 'balanced' | 'stage' | 'pipeline'

export interface StudioSplitterLayoutProps {
  left: React.ReactNode
  center?: React.ReactNode
  right: React.ReactNode
  preset?: StudioViewPreset
  onPresetChange?: (preset: StudioViewPreset) => void
  mobilePane?: 'steps' | 'page' | 'properties'
  className?: string
}

const STORAGE_KEY = 'cairn_studio_splitter_widths'
const DEFAULT_LEFT = 250
const DEFAULT_RIGHT = 400
const MIN_LEFT = 180
const MAX_LEFT = 360
const MIN_RIGHT = 340
const MAX_RIGHT = 520

function readStoredWidths(): { left: number; right: number } {
  if (typeof window === 'undefined') {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
    const parsed = JSON.parse(raw) as { left?: unknown; right?: unknown }
    const left =
      typeof parsed.left === 'number' && !isNaN(parsed.left)
        ? Math.min(MAX_LEFT, Math.max(MIN_LEFT, parsed.left))
        : DEFAULT_LEFT
    const right =
      typeof parsed.right === 'number' && !isNaN(parsed.right)
        ? Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, parsed.right))
        : DEFAULT_RIGHT
    return { left, right }
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
  }
}

export function StudioSplitterLayout({
  left,
  center,
  right,
  preset = 'balanced',
  onPresetChange: _onPresetChange,
  mobilePane,
  className,
}: StudioSplitterLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<{ left: number; right: number }>(() => readStoredWidths())
  const [containerWidth, setContainerWidth] = useState<number>(1280)
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null)
  const dragStartXRef = useRef<number>(0)
  const dragStartWidthRef = useRef<number>(0)

  // 监听容器真实可用宽度 (用于小屏与侧栏助手防挤压防御)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (el.getBoundingClientRect().width > 0) {
      setContainerWidth(el.getBoundingClientRect().width)
    }
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.width > 0) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 持久化存储
  const persistWidths = useCallback((next: { left: number; right: number }) => {
    setWidths(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore
    }
  }, [])

  // 开始拖拽
  const startDrag = useCallback((side: 'left' | 'right', clientX: number) => {
    setDragging(side)
    dragStartXRef.current = clientX
    dragStartWidthRef.current = side === 'left' ? widths.left : widths.right
  }, [widths])

  // 拖拽中与结束处理
  useEffect(() => {
    if (!dragging) return

    function handleMouseMove(e: MouseEvent) {
      const delta = e.clientX - dragStartXRef.current
      if (dragging === 'left') {
        const nextLeft = Math.min(MAX_LEFT, Math.max(MIN_LEFT, dragStartWidthRef.current + delta))
        setWidths((prev) => ({ ...prev, left: nextLeft }))
      } else if (dragging === 'right') {
        const nextRight = Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, dragStartWidthRef.current - delta))
        setWidths((prev) => ({ ...prev, right: nextRight }))
      }
    }

    function handleMouseUp() {
      setDragging(null)
      setWidths((current) => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
        } catch {
          // ignore
        }
        return current
      })
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging])

  // 双击重置为默认值
  const handleReset = useCallback(() => {
    persistWidths({ left: DEFAULT_LEFT, right: DEFAULT_RIGHT })
  }, [persistWidths])

  // 键盘快捷调节
  const handleKeyDown = useCallback(
    (side: 'left' | 'right', e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.key === 'ArrowRight' ? 15 : -15
        if (side === 'left') {
          const next = Math.min(MAX_LEFT, Math.max(MIN_LEFT, widths.left + step))
          persistWidths({ ...widths, left: next })
        } else {
          const next = Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, widths.right - step))
          persistWidths({ ...widths, right: next })
        }
      }
    },
    [widths, persistWidths],
  )

  // 容器狭窄（< 768px）时的自适应降级：自动将左栏压缩
  const isNarrowContainer = containerWidth < 768
  const effectiveLeftWidth =
    preset === 'stage'
      ? 48
      : isNarrowContainer
        ? Math.min(widths.left, 180)
        : widths.left
  const showCenter = preset !== 'pipeline' && Boolean(center)
  const showRight = preset !== 'stage'

  return (
    <div
      ref={containerRef}
      data-testid='studio-splitter-layout'
      data-preset={preset}
      className={cn('relative flex h-full w-full flex-1 min-h-0 min-w-0 overflow-hidden bg-surface-page', className)}
    >
      {/* 拖拽全屏透明防穿透遮罩 */}
      {dragging ? (
        <div
          data-testid='splitter-drag-overlay'
          className='fixed inset-0 z-50 cursor-col-resize select-none bg-transparent'
        />
      ) : null}

      {/* 左栏：步骤管线 */}
      <div
        data-testid='splitter-left-pane'
        style={{ width: `${effectiveLeftWidth}px` }}
        className={cn(
          'flex flex-col min-h-0 shrink-0 overflow-hidden bg-card transition-[width] duration-150',
          preset === 'stage' && 'items-center px-1',
          mobilePane && mobilePane !== 'steps' && 'max-lg:hidden',
          mobilePane === 'steps' && 'max-lg:!w-full max-lg:flex-1',
        )}
      >
        {left}
      </div>

      {/* 左侧可拖拽分割条 */}
      {preset !== 'stage' && (
        <div
          role='separator'
          aria-orientation='vertical'
          aria-label='调整步骤管线宽度'
          aria-valuenow={effectiveLeftWidth}
          aria-valuemin={MIN_LEFT}
          aria-valuemax={MAX_LEFT}
          tabIndex={0}
          data-testid='splitter-handle-left'
          onMouseDown={(e) => startDrag('left', e.clientX)}
          onDoubleClick={handleReset}
          onKeyDown={(e) => handleKeyDown('left', e)}
          className={cn(
            'group relative flex h-full w-2.5 shrink-0 self-stretch cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none',
            mobilePane && 'max-lg:hidden',
          )}
          title='拖拽调整宽度，双击恢复默认'
        >
          <div className='h-8 w-0.5 rounded-full bg-border-divider transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary' />
        </div>
      )}

      {/* 中栏：受管视口舞台 */}
      {showCenter && (
        <div
          data-testid='splitter-center-pane'
          className={cn(
            'flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-card',
            mobilePane && mobilePane !== 'page' && 'max-lg:hidden',
            mobilePane === 'page' && 'max-lg:!w-full max-lg:flex-1',
          )}
        >
          {center}
        </div>
      )}

      {/* 右侧可拖拽分割条 */}
      {showCenter && showRight && (
        <div
          role='separator'
          aria-orientation='vertical'
          aria-label='调整属性检查器宽度'
          aria-valuenow={widths.right}
          aria-valuemin={MIN_RIGHT}
          aria-valuemax={MAX_RIGHT}
          tabIndex={0}
          data-testid='splitter-handle-right'
          onMouseDown={(e) => startDrag('right', e.clientX)}
          onDoubleClick={handleReset}
          onKeyDown={(e) => handleKeyDown('right', e)}
          className={cn(
            'group relative flex h-full w-2.5 shrink-0 self-stretch cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none',
            mobilePane && 'max-lg:hidden',
          )}
          title='拖拽调整宽度，双击恢复默认'
        >
          <div className='h-8 w-0.5 rounded-full bg-border-divider transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary' />
        </div>
      )}

      {/* 右栏：属性检查器宿主 */}
      {showRight && (
        <div
          data-testid='splitter-right-pane'
          style={{ width: preset === 'pipeline' ? 'auto' : `${widths.right}px` }}
          className={cn(
            'flex flex-col min-h-0 overflow-hidden bg-card',
            preset === 'pipeline' ? 'flex-1 min-w-0' : 'shrink-0',
            mobilePane && mobilePane !== 'properties' && 'max-lg:hidden',
            mobilePane === 'properties' && 'max-lg:!w-full max-lg:flex-1',
          )}
        >
          {right}
        </div>
      )}
    </div>
  )
}
