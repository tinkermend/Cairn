import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PageHeaderProps = {
  title: string
  description?: ReactNode
  actions?: ReactNode
  parent?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  description,
  actions,
  parent,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end justify-between gap-3',
        className
      )}
    >
      <div className='min-w-0 space-y-1'>
        {parent ? (
          <div className='text-small text-muted-foreground'>{parent}</div>
        ) : null}
        <h1 className='text-page font-semibold break-words'>{title}</h1>
        {description ? (
          <p className='max-w-[72ch] text-body text-muted-foreground'>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className='flex flex-wrap items-center gap-2'>{actions}</div>
      ) : null}
    </div>
  )
}
