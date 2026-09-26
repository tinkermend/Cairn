import { useState } from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { SessionWorkbenchView } from './detail'

export interface SessionWorkbenchSheetProps {
  targetId?: string | null
  accountId?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SessionWorkbenchSheet({
  targetId,
  accountId,
  open,
  onOpenChange,
}: SessionWorkbenchSheetProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'flex flex-col gap-0 p-0 overflow-hidden transition-[max-width,width] duration-200 border-s border-border-default bg-card shadow-2xl',
          isFullscreen
            ? 'w-full max-w-full sm:max-w-full md:max-w-full lg:max-w-full xl:max-w-full'
            : 'w-full sm:max-w-2xl md:max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl',
        )}
      >
        {targetId && accountId ? (
          <SessionWorkbenchView
            targetId={targetId}
            accountId={accountId}
            isSheet={true}
            isFullscreen={isFullscreen}
            onFullscreenToggle={() => setIsFullscreen((prev) => !prev)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
