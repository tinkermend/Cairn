import * as React from 'react'
import { cn } from '@/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot='textarea'
      className={cn(
        'control-focus flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-surface-control px-3 py-2 text-base shadow-control transition-[background-color,border-color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-border-control-hover disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
