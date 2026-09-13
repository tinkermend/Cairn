import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type TruncatedTextProps = {
  text: string
  empty?: string
  className?: string
}

/** 单元格省略显示，悬停和聚焦用 Tooltip 看全文。 */
export function TruncatedText({ text, empty = '—', className }: TruncatedTextProps) {
  if (!text) {
    return <span className={cn('text-label text-muted-foreground', className)}>{empty}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          className={cn(
            'block w-full truncate text-left text-label text-muted-foreground',
            className,
          )}
        >
          {text}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side='top'
        className='max-w-lg whitespace-pre-wrap break-all text-left'
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
