import type { ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface FieldHelpProps {
  label?: string
  children: ReactNode
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
}

export function FieldHelp({
  label,
  children,
  className,
  side = 'top',
  align = 'center',
}: FieldHelpProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none cursor-help transition-colors',
            className
          )}
          aria-label='查看说明'
          title={label ? `${label}说明` : '说明'}
        >
          <CircleHelp className='size-3.5' aria-hidden='true' />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        className='max-w-xs text-left text-label leading-relaxed font-normal'
        style={{ textWrap: 'wrap' }}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  )
}
