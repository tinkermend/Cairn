import { SearchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSearch } from '@/context/search-provider'
import { Button } from './ui/button'
import { formatAriaShortcut, formatShortcut } from '@/lib/platform'
import { useKeybindingsStore } from '@/stores/keybindings-store'

export function Search({
  className = '',
  placeholder = '搜索或跳转',
  ...props
}: React.ComponentProps<'button'> & { placeholder?: string }) {
  const { setOpen } = useSearch()
  const openKey = useKeybindingsStore((state) => state.getEffectiveKey('palette.open'))
  const shortcutHint = formatShortcut(openKey)

  return (
    <Button
      {...props}
      variant='outline'
      aria-label='搜索或跳转'
      aria-keyshortcuts={formatAriaShortcut(openKey)}
      onClick={() => setOpen(true)}
      className={cn(
        'group relative flex h-8 items-center rounded-md border border-border-default bg-surface-control px-2.5 font-normal text-muted-foreground shadow-none hover:bg-accent hover:text-foreground',
        'max-sm:size-9 max-sm:justify-center max-sm:p-0 sm:w-44 sm:max-w-[240px] sm:justify-start',
        className
      )}
    >
      <SearchIcon
        aria-hidden='true'
        className='size-4 shrink-0 text-muted-foreground group-hover:text-foreground sm:me-2'
      />
      <span className='hidden truncate text-small sm:inline'>{placeholder}</span>
      <kbd className='pointer-events-none ms-auto hidden h-5 items-center gap-0.5 rounded border border-border-default bg-muted px-1.5 font-mono text-caption text-muted-foreground select-none group-hover:bg-accent md:inline-flex'>
        {shortcutHint}
      </kbd>
    </Button>
  )
}
