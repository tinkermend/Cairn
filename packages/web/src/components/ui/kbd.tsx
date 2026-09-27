import * as React from 'react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'

export interface KbdProps extends React.ComponentProps<'kbd'> {
  /** 快捷键组合定义，如 'mod+j', 'mod+k', 'ctrl+alt+j' */
  shortcut?: string
  /** 尺寸风格 */
  size?: 'sm' | 'default' | 'lg'
}

export function Kbd({
  shortcut,
  size = 'default',
  className,
  children,
  ...props
}: KbdProps) {
  const content = shortcut ? formatShortcut(shortcut) : children

  return (
    <kbd
      data-slot='kbd'
      className={cn(
        'pointer-events-none inline-flex items-center gap-0.5 rounded border border-border-default bg-surface-base font-mono font-medium text-muted-foreground select-none shadow-xs',
        size === 'sm' && 'px-1 py-0.2 text-[10px]',
        size === 'default' && 'px-1.5 py-0.5 text-xs',
        size === 'lg' && 'px-3 py-1.5 text-sm font-semibold tracking-wider text-foreground shadow-sm',
        className
      )}
      {...props}
    >
      {content}
    </kbd>
  )
}
