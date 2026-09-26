import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export function stageLabel(stage: string | null, queuePos?: number | null): string {
  if (stage === 'queued') return `排队中${queuePos ? `（第 ${queuePos} 位）` : ''}...`
  if (stage === 'routing') return '正在理解意图与准入检查...'
  if (stage === 'loading_facts') return '正在检索上下文事实与证据...'
  if (stage === 'generating') return '大模型正在思考分析...'
  if (stage === 'validating') return '正在进行事实引用与编译验证...'
  if (stage === 'persisting') return '正在保存处理结果...'
  return '正在分析，请稍候…'
}

export interface ThinkingProcessBlockProps {
  thinkingText?: string
  thinkingDurationMs?: number
  isLive?: boolean
  stage?: string | null
  queuePosition?: number | null
  onCancel?: () => void
  defaultOpen?: boolean
  className?: string
}

export function ThinkingProcessBlock({
  thinkingText = '',
  thinkingDurationMs,
  isLive = false,
  stage = null,
  queuePosition = null,
  onCancel,
  defaultOpen,
  className,
}: ThinkingProcessBlockProps) {
  // During live generation, expand by default; when completed, collapse by default
  const [isOpen, setIsOpen] = useState(() => {
    if (defaultOpen !== undefined) return defaultOpen
    return isLive
  })

  const [copied, setCopied] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  // Live timer when generating
  useEffect(() => {
    if (!isLive) {
      if (thinkingDurationMs) {
        setElapsedSeconds(Math.max(1, Math.round(thinkingDurationMs / 1000)))
      }
      return
    }

    const startTime = Date.now()
    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.floor((Date.now() - startTime) / 1000)))
    }, 1000)

    return () => clearInterval(timer)
  }, [isLive, thinkingDurationMs])

  // Auto-scroll to bottom as thinking chunks arrive if user hasn't scrolled up
  useEffect(() => {
    if (!isLive || !isOpen || userScrolledRef.current) return
    const el = contentRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [thinkingText, isLive, isOpen])

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!thinkingText) return
    try {
      await navigator.clipboard.writeText(thinkingText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  const handleScroll = () => {
    const el = contentRef.current
    if (!el) return
    // If within 24px of bottom, consider user is at bottom
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    userScrolledRef.current = !isAtBottom
  }

  // 1. Live status banner without thinking text yet (e.g. routing, loading_facts, or initial generating)
  if (isLive && !thinkingText) {
    return (
      <div
        className={cn(
          'flex items-center justify-between gap-2 rounded-xl border border-border-default bg-surface-subtle p-3 shadow-2xs transition-colors',
          className,
        )}
      >
        <div role='status' className='flex items-center gap-2 text-label text-text-secondary'>
          <Loader2 className='size-3.5 animate-spin text-primary-600' />
          <span>{stageLabel(stage, queuePosition)}</span>
          {stage === 'generating' && elapsedSeconds > 0 ? (
            <span className='text-caption text-text-muted'>({elapsedSeconds}s)</span>
          ) : null}
        </div>
        {onCancel ? (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-2 text-label text-text-muted hover:text-status-error-foreground'
            onClick={onCancel}
          >
            取消
          </Button>
        ) : null}
      </div>
    )
  }

  // 2. Active live streaming thinking process
  if (isLive && thinkingText) {
    return (
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn(
          'rounded-xl border border-primary-500/20 bg-surface-subtle/80 shadow-2xs transition-colors duration-200',
          className,
        )}
      >
        <div className='flex items-center justify-between gap-2 p-3'>
          <CollapsibleTrigger asChild>
            <button
              type='button'
              className='group flex flex-1 items-center gap-2 min-w-0 text-left text-label font-medium text-text-secondary select-none hover:text-text-primary'
              aria-label={isOpen ? '收起思考过程' : '展开思考过程'}
            >
              <Brain className='size-3.5 shrink-0 animate-pulse text-primary-600' />
              <span className='truncate whitespace-nowrap'>大模型正在思考分析...</span>
              <span className='shrink-0 text-caption text-primary-600/80 whitespace-nowrap'>({elapsedSeconds}s)</span>
              {isOpen ? (
                <ChevronDown className='size-3.5 shrink-0 text-text-muted transition-transform group-hover:text-text-secondary' />
              ) : (
                <ChevronRight className='size-3.5 shrink-0 text-text-muted transition-transform group-hover:text-text-secondary' />
              )}
            </button>
          </CollapsibleTrigger>

          <div className='flex items-center gap-1'>
            {onCancel ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='h-6 px-2 text-label text-text-muted hover:text-status-error-foreground'
                onClick={onCancel}
              >
                取消
              </Button>
            ) : null}
          </div>
        </div>

        <CollapsibleContent>
          <div className='px-3 pb-3'>
            <div
              ref={contentRef}
              onScroll={handleScroll}
              className='max-h-48 overflow-y-auto rounded-lg border border-border-default/60 bg-surface-card/90 p-2.5 font-mono text-label leading-relaxed whitespace-pre-wrap text-text-primary/90 select-text'
            >
              {thinkingText}
              <span
                className='inline-block h-3.5 w-1.5 animate-pulse bg-primary-600 align-middle'
                aria-hidden='true'
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  // 3. Completed turn with thinking process (collapsed by default, click to expand)
  if (!thinkingText) return null

  const displayDuration =
    thinkingDurationMs && thinkingDurationMs > 0
      ? Math.max(1, Math.round(thinkingDurationMs / 1000))
      : elapsedSeconds > 0
        ? elapsedSeconds
        : null

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        'group rounded-lg border border-border-subtle bg-surface-subtle/50 transition-colors hover:border-border-default',
        className,
      )}
    >
      <div className='flex items-center justify-between gap-2 px-3 py-1.5'>
        <CollapsibleTrigger asChild>
          <button
            type='button'
            className='flex flex-1 items-center gap-2 text-left text-caption font-medium text-text-muted select-none hover:text-text-primary'
            aria-label={isOpen ? '收起思考过程' : '展开思考过程'}
          >
            <Brain className='size-3.5 text-text-muted transition-colors group-hover:text-primary-600' />
            <span>
              已深度思考
              {displayDuration ? ` (用时 ${displayDuration} 秒)` : ''}
            </span>
            <span className='text-caption text-text-muted/70 group-hover:text-text-muted'>
              {isOpen ? '点击折叠' : '点击展开'}
            </span>
            {isOpen ? (
              <ChevronDown className='size-3 text-text-muted transition-transform' />
            ) : (
              <ChevronRight className='size-3 text-text-muted transition-transform' />
            )}
          </button>
        </CollapsibleTrigger>

        {isOpen ? (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1.5 text-caption text-text-muted hover:text-text-primary'
            title='复制思考过程'
            onClick={handleCopy}
          >
            {copied ? (
              <Check className='size-3 text-status-success' />
            ) : (
              <Copy className='size-3' />
            )}
          </Button>
        ) : null}
      </div>

      <CollapsibleContent>
        <div className='px-3 pb-2.5 pt-0.5'>
          <div
            ref={contentRef}
            className='max-h-48 overflow-y-auto rounded border border-border-subtle bg-surface-card/60 p-2 font-mono text-caption leading-relaxed whitespace-pre-wrap text-text-secondary select-text'
          >
            {thinkingText}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
