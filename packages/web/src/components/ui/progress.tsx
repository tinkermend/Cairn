import * as React from 'react'
import { cn } from '@/lib/utils'

export interface ProgressProps extends React.ComponentProps<'div'> {
  value?: number
  indicatorClassName?: string
}

export function Progress({
  className,
  value = 0,
  indicatorClassName,
  ...props
}: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value ?? 0))

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-surface-subtle',
        className
      )}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-300 ease-out',
          indicatorClassName
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
