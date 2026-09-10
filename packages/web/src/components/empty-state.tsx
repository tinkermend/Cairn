import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'

type EmptyStateProps = {
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className
      )}
    >
      <Inbox className='size-8 text-muted-foreground' aria-hidden />
      <h2 className='text-base font-semibold text-text-primary'>{title}</h2>
      {description ? (
        <p className='max-w-md text-sm text-muted-foreground'>{description}</p>
      ) : null}
      {action ? <div className='mt-2'>{action}</div> : null}
    </div>
  )
}
