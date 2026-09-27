import { useEffect, useState, useRef } from 'react'
import {
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

function stageLabel(stage: string | null, queuePos?: number | null): string {
  if (stage === 'queued') return `排队中${queuePos ? `（第 ${queuePos} 位）` : ''}…`
  if (stage === 'routing') return '正在理解问题…'
  if (stage === 'loading_facts') return '正在查找相关事实与证据…'
  if (stage === 'generating') return '正在生成答复…'
  if (stage === 'validating') return '正在核对答复…'
  if (stage === 'persisting') return '正在保存结果…'
  return '正在处理，请稍候…'
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
  thinkingText,
  thinkingDurationMs,
  isLive = false,
  stage = null,
  queuePosition = null,
  onCancel,
  defaultOpen,
  className,
}: ThinkingProcessBlockProps) {
  // 思考中默认展开展示过程，思考完成后默认折叠
  const [isOpen, setIsOpen] = useState(() => (isLive ? true : (defaultOpen ?? false)))
  const [copied, setCopied] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  // 实时计时器
  useEffect(() => {
    if (!isLive) {
      if (thinkingDurationMs && thinkingDurationMs > 0) {
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

  // 实时思考内容流式输出时自动向下滚动（若用户手动向上滚动则尊重用户视图）
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
      // 忽略无法写入剪贴板的场景
    }
  }

  const handleScroll = () => {
    const el = contentRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    userScrolledRef.current = !isAtBottom
  }

  const displayDuration =
    thinkingDurationMs && thinkingDurationMs > 0
      ? Math.max(1, Math.round(thinkingDurationMs / 1000))
      : elapsedSeconds > 0
        ? elapsedSeconds
        : null

  // 1. 实时思考中：尚未产生思考文本（排队、理解问题、查找事实阶段）
  if (isLive && !thinkingText) {
    return (
      <div
        className={cn(
          'flex items-center justify-between gap-2 rounded-xl border border-border-default bg-surface-subtle p-3 shadow-2xs transition-colors',
          className,
        )}
      >
        <div role='status' className='flex min-w-0 items-center gap-2 text-label text-text-secondary'>
          <Loader2 className='size-3.5 shrink-0 animate-spin text-primary-600' aria-hidden='true' />
          <span>{stageLabel(stage, queuePosition)}</span>
          {elapsedSeconds > 0 ? (
            <span className='shrink-0 text-caption text-text-muted'>用时 {elapsedSeconds} 秒</span>
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

  // 2. 实时思考中：大模型流式输出思考内容（默认展开，展现思考过程）
  if (isLive && thinkingText) {
    return (
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn(
          'rounded-xl border border-primary-500/25 bg-surface-subtle/80 shadow-2xs transition-colors',
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
              <Brain className='size-3.5 shrink-0 animate-pulse text-primary-600' aria-hidden='true' />
              <span className='truncate whitespace-nowrap'>大模型正在思考分析…</span>
              {elapsedSeconds > 0 ? (
                <span className='shrink-0 text-caption text-primary-600/80 whitespace-nowrap'>
                  ({elapsedSeconds}s)
                </span>
              ) : null}
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
                className='inline-block h-3.5 w-1.5 animate-pulse bg-primary-600 align-middle ml-0.5'
                aria-hidden='true'
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  // 3. 思考完成态：无思考文本时若有耗时，展示紧凑耗时摘要
  if (!thinkingText) {
    if (displayDuration === null) return null
    return (
      <div
        className={cn(
          'flex items-center justify-between gap-2 rounded-xl border border-border-default bg-surface-subtle p-3 shadow-2xs',
          className,
        )}
      >
        <div role='status' className='flex min-w-0 items-center gap-2 text-label text-text-secondary'>
          <CheckCircle2 className='size-3.5 shrink-0 text-status-success-foreground' aria-hidden='true' />
          <span>答复已完成</span>
          <span className='shrink-0 text-text-muted'>用时 {displayDuration} 秒</span>
        </div>
      </div>
    )
  }

  // 4. 思考完成态：含有思考过程文本，默认折叠，支持点击展开与一键复制
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        'group rounded-lg border border-border-default/80 bg-surface-subtle/50 transition-colors hover:border-border-muted',
        className,
      )}
    >
      <div className='flex items-center justify-between gap-2 px-3 py-1.5'>
        <CollapsibleTrigger asChild>
          <button
            type='button'
            className='flex flex-1 items-center gap-2 text-left text-label font-medium text-text-muted select-none hover:text-text-primary'
            aria-label={isOpen ? '收起思考过程' : '展开思考过程'}
          >
            <Brain className='size-3.5 text-text-muted transition-colors group-hover:text-primary-600' aria-hidden='true' />
            <span>
              已深度思考
              {displayDuration ? ` (用时 ${displayDuration} 秒)` : ''}
            </span>
            <span className='text-caption text-text-muted/70 group-hover:text-text-muted'>
              {isOpen ? '点击折叠' : '点击展开'}
            </span>
            {isOpen ? (
              <ChevronDown className='size-3 text-text-muted transition-transform' aria-hidden='true' />
            ) : (
              <ChevronRight className='size-3 text-text-muted transition-transform' aria-hidden='true' />
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
              <Check className='size-3 text-status-success-foreground' aria-hidden='true' />
            ) : (
              <Copy className='size-3' aria-hidden='true' />
            )}
          </Button>
        ) : null}
      </div>

      <CollapsibleContent>
        <div className='px-3 pb-2.5 pt-0.5'>
          <div
            ref={contentRef}
            className='max-h-48 overflow-y-auto rounded border border-border-default/60 bg-surface-card/80 p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap text-text-secondary select-text'
          >
            {thinkingText}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
