import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  // Kept for compatibility with turns saved before reasoning output was retired.
  // Provider reasoning must never be shown or copied in the assistant UI.
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
  thinkingDurationMs,
  isLive = false,
  stage = null,
  queuePosition = null,
  onCancel,
  className,
}: ThinkingProcessBlockProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!isLive) return
    const startTime = Date.now()
    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.floor((Date.now() - startTime) / 1000)))
    }, 1000)
    return () => clearInterval(timer)
  }, [isLive])

  const durationSeconds = thinkingDurationMs && thinkingDurationMs > 0
    ? Math.max(1, Math.round(thinkingDurationMs / 1000))
    : elapsedSeconds > 0 ? elapsedSeconds : null

  if (!isLive && durationSeconds === null) return null

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-xl border border-border-default bg-surface-subtle p-3 shadow-2xs',
        className,
      )}
    >
      <div role='status' className='flex min-w-0 items-center gap-2 text-label text-text-secondary'>
        {isLive ? (
          <Loader2 className='size-3.5 shrink-0 animate-spin text-primary-600' aria-hidden='true' />
        ) : (
          <CheckCircle2 className='size-3.5 shrink-0 text-status-success-foreground' aria-hidden='true' />
        )}
        <span>{isLive ? stageLabel(stage, queuePosition) : '答复已完成'}</span>
        {durationSeconds !== null ? (
          <span className='shrink-0 text-text-muted'>用时 {durationSeconds} 秒</span>
        ) : null}
      </div>
      {isLive && onCancel ? (
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
