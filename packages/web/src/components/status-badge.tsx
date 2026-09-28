import type { HTMLAttributes, ReactNode } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleHelp,
  Clock,
  Info,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type StatusTone =
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'waiting'
  | 'blocked'
  | 'neutral'
  | 'ai'

const toneClass: Record<StatusTone, string> = {
  success:
    'border-transparent bg-status-success-background text-status-success-foreground',
  warning:
    'border-transparent bg-status-warning-background text-status-warning-foreground',
  error:
    'border-transparent bg-status-error-background text-status-error-foreground',
  info: 'border-transparent bg-status-info-background text-status-info-foreground',
  waiting:
    'border-transparent bg-status-waiting-background text-status-waiting-foreground',
  blocked:
    'border-transparent bg-status-blocked-background text-status-blocked-foreground',
  neutral:
    'border-transparent bg-status-neutral-background text-status-neutral-foreground',
  ai: 'border-transparent bg-ai-background text-ai-foreground',
}

const toneIcon: Record<StatusTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
  waiting: Clock,
  blocked: Ban,
  neutral: CircleHelp,
  ai: Sparkles,
}

type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone: StatusTone
  children: ReactNode
  className?: string
  hideIcon?: boolean
}

export function StatusBadge({
  tone,
  children,
  className,
  hideIcon = false,
  ...rest
}: StatusBadgeProps) {
  const Icon = toneIcon[tone]
  return (
    <Badge
      variant='outline'
      data-slot='status-badge'
      className={cn(toneClass[tone], className)}
      {...rest}
    >
      {hideIcon ? null : <Icon className='size-3 shrink-0' aria-hidden />}
      {children}
    </Badge>
  )
}
