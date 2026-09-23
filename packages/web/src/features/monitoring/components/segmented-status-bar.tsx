import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export type SegmentItem = {
  key: string
  label: string
  count: number
  color: string
}

export function SegmentedStatusBar({
  segments,
  total,
  className,
}: {
  segments: SegmentItem[]
  total?: number
  className?: string
}) {
  const sum = total ?? segments.reduce((acc, curr) => acc + Math.max(0, curr.count), 0)

  return (
    <div className={cn('space-y-2', className)}>
      {/* 胶囊条主体 */}
      <TooltipProvider delayDuration={150}>
        <div className="relative flex h-2.5 w-full overflow-hidden rounded-full bg-surface-subtle">
          {sum === 0 ? (
            <div className="h-full w-full bg-muted/40" />
          ) : (
            segments
              .filter((seg) => seg.count > 0)
              .map((seg) => {
                const percent = Math.max(0, (seg.count / sum) * 100)
                return (
                  <Tooltip key={seg.key}>
                    <TooltipTrigger asChild>
                      <div
                        className="h-full transition-[width] duration-300 ease-out hover:opacity-90 cursor-default"
                        style={{
                          width: `${percent}%`,
                          backgroundColor: seg.color,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-label">
                      <span>{seg.label}: </span>
                      <span className="font-semibold tabular-nums">{seg.count}</span>
                      <span className="text-muted-foreground"> ({Math.round(percent)}%)</span>
                    </TooltipContent>
                  </Tooltip>
                )
              })
          )}
        </div>
      </TooltipProvider>

      {/* 底部紧凑图例 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: seg.color }}
              aria-hidden
            />
            <span className="text-muted-foreground">{seg.label}</span>
            <span className="font-semibold tabular-nums text-foreground">{seg.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
