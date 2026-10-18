import { useMemo, useState } from 'react'
import { Check, Layers, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTruncated } from '@/features/scenarios/list/use-is-truncated'

function ScenarioName({ name }: { name: string }) {
  const [ref, truncated] = useIsTruncated<HTMLSpanElement>(name)
  // Tooltip 常驻保持节点稳定，避免截断态被 RO 的死节点回调清掉（同场景编排列表页）。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={ref} className='truncate font-medium text-foreground'>{name}</span>
      </TooltipTrigger>
      {truncated ? (
        <TooltipContent side='top' className='max-w-sm text-left'>
          {name}
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}

export interface ScenarioQuickPickerProps {
  availableScenarios: Array<{ id: string; name: string; latestVersionId?: string }>
  currentMemberScenarioIds?: string[]
  onSelectScenario: (scenarioId: string) => void
  onOpenSearchDialog?: () => void
  disabled?: boolean
  stageName?: string
  triggerText?: string
  className?: string
  size?: 'sm' | 'default'
}

export function ScenarioQuickPicker({
  availableScenarios,
  currentMemberScenarioIds = [],
  onSelectScenario,
  onOpenSearchDialog,
  disabled = false,
  stageName,
  triggerText,
  className,
  size = 'sm',
}: ScenarioQuickPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Map of scenario frequency in current suite
  const scenarioCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const id of currentMemberScenarioIds) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [currentMemberScenarioIds])

  // Filtered scenarios based on query
  const filteredScenarios = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return availableScenarios
    return availableScenarios.filter((item) => item.name.toLowerCase().includes(q))
  }, [availableScenarios, search])

  // Recent / frequent list (first 3 scenarios as suggested)
  const suggestedScenarios = useMemo(() => {
    return availableScenarios.slice(0, 3)
  }, [availableScenarios])

  function handleSelect(scenarioId: string) {
    onSelectScenario(scenarioId)
    setOpen(false)
    setSearch('')
  }

  const defaultTrigger = triggerText ?? (stageName ? `添加场景至 ${stageName}` : '添加已发布场景')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size={size}
          disabled={disabled}
          className={className ?? 'h-8 text-label gap-1.5 shadow-2xs hover:bg-accent'}
          aria-label={defaultTrigger}
        >
          <Plus className='size-3.5 text-primary' />
          <span>{defaultTrigger}</span>
          <kbd className='ml-1 hidden sm:inline-flex items-center px-1.5 py-0.2 text-3xs font-mono text-muted-foreground/80 bg-muted rounded border border-border/40'>
            ⌘K
          </kbd>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align='start'
        sideOffset={6}
        className='w-[380px] p-0 rounded-xl shadow-card-hover border-border-card bg-popover/95 backdrop-blur-md overflow-hidden'
      >
        <Command shouldFilter={false} className='rounded-xl'>
          <CommandInput
            placeholder='搜索场景名称、关键词...'
            value={search}
            onValueChange={setSearch}
            className='text-label'
          />

          <CommandList className='max-h-72 p-1.5'>
            <CommandEmpty className='py-6 text-center text-label text-muted-foreground'>
              未找到匹配的场景
            </CommandEmpty>

            {/* Suggested / Recent Group when search query is empty */}
            {!search.trim() && suggestedScenarios.length > 0 ? (
              <CommandGroup heading='推荐 / 常用场景'>
                {suggestedScenarios.map((item) => {
                  const count = scenarioCounts.get(item.id) ?? 0
                  return (
                    <CommandItem
                      key={`suggested-${item.id}`}
                      value={item.id}
                      onSelect={() => handleSelect(item.id)}
                      className='flex items-center justify-between py-2 px-2.5 rounded-lg text-label cursor-pointer'
                    >
                      <div className='flex items-center gap-2 min-w-0 flex-1 mr-2'>
                        <Layers className='size-3.5 shrink-0 text-primary' />
                        <ScenarioName name={item.name} />
                      </div>
                      <div className='flex items-center gap-1.5 shrink-0'>
                        {count > 0 ? (
                          <Badge variant='secondary' className='text-3xs font-normal py-0 h-4 px-1.5 bg-muted text-muted-foreground'>
                            已在集合 ({count})
                          </Badge>
                        ) : null}
                        <Plus className='size-3 text-muted-foreground/60' />
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null}

            {/* All Available Scenarios */}
            <CommandGroup heading={search.trim() ? `搜索结果 (${filteredScenarios.length})` : `全部可用场景 (${availableScenarios.length})`}>
              {filteredScenarios.map((item) => {
                const count = scenarioCounts.get(item.id) ?? 0
                return (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => handleSelect(item.id)}
                    className='flex items-center justify-between py-2 px-2.5 rounded-lg text-label cursor-pointer'
                  >
                    <div className='flex items-center gap-2 min-w-0 flex-1 mr-2'>
                      <Layers className='size-3.5 shrink-0 text-muted-foreground' />
                      <ScenarioName name={item.name} />
                    </div>
                    <div className='flex items-center gap-1.5 shrink-0'>
                      {count > 0 ? (
                        <Badge variant='secondary' className='text-3xs font-normal py-0 h-4 px-1.5 bg-muted text-muted-foreground'>
                          <Check className='size-2.5 mr-0.5' />已加 {count}
                        </Badge>
                      ) : null}
                      <Plus className='size-3 text-muted-foreground/60' />
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>

          {/* Footer Escape Hatch */}
          {onOpenSearchDialog ? (
            <>
              <CommandSeparator />
              <div className='flex items-center justify-between p-2 bg-muted/30 text-3xs text-muted-foreground'>
                <span>回车即可加入</span>
                <button
                  type='button'
                  onClick={() => {
                    setOpen(false)
                    onOpenSearchDialog()
                  }}
                  className='inline-flex items-center gap-1 text-primary hover:underline hover:text-primary-600 transition-colors'
                >
                  <Search className='size-3' />
                  浏览场景库大面板 ↗
                </button>
              </div>
            </>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
