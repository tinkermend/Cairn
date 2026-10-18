import { useMemo, useState } from 'react'
import { Layers, Search, X } from 'lucide-react'
import { matchPublishedScenarioName, toggleCurrentListSelection } from './member-picker-selection'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTruncated } from '@/features/scenarios/list/use-is-truncated'
import { cn } from '@/lib/utils'

function ScenarioName({ name }: { name: string }) {
  const [ref, truncated] = useIsTruncated<HTMLSpanElement>(name)
  // Tooltip 常驻保持节点稳定，避免截断态被 RO 的死节点回调清掉（同场景编排列表页）。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={ref} className='block truncate text-body font-medium text-foreground'>
          {name}
        </span>
      </TooltipTrigger>
      {truncated ? (
        <TooltipContent side='top' className='max-w-sm text-left'>
          {name}
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}

export type PickerScenario = {
  id: string
  name: string
  latestVersionId?: string
  latestVersionNo?: number | null
}

export function MemberPickerDialog({
  open,
  onOpenChange,
  availableScenarios,
  currentMemberScenarioIds = [],
  title = '选择场景加入流水线',
  onSelectScenarios,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableScenarios: PickerScenario[]
  currentMemberScenarioIds?: string[]
  title?: string
  onSelectScenarios: (scenarioIds: string[]) => void
}) {
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  function closePicker() {
    setKeyword('')
    setSelectedIds([])
    onOpenChange(false)
  }

  const filteredScenarios = useMemo(
    () => availableScenarios.filter((item) => matchPublishedScenarioName(item.name, keyword)),
    [availableScenarios, keyword],
  )

  const scenarioById = useMemo(() => {
    const map = new Map(availableScenarios.map((item) => [item.id, item]))
    return map
  }, [availableScenarios])

  const alreadyInSuite = useMemo(() => new Set(currentMemberScenarioIds), [currentMemberScenarioIds])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const visibleIds = useMemo(() => filteredScenarios.map((item) => item.id), [filteredScenarios])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id))

  function toggle(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function handleConfirm() {
    if (selectedIds.length === 0) return
    onSelectScenarios(selectedIds)
    closePicker()
  }

  const selectedCount = selectedIds.length

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : closePicker())}>
      <DialogContent className='flex max-h-[85vh] flex-col gap-3 p-5 sm:max-w-2xl'>
        <DialogHeader className='shrink-0 space-y-1.5 pr-8'>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            搜索并勾选已发布场景。换关键词不会丢掉已选，确认后一次加入。
          </DialogDescription>
        </DialogHeader>

        <div className='relative shrink-0'>
          <Search className='pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
          <Input
            value={keyword}
            placeholder='搜索场景名称，空格分词'
            className='ps-9 text-body'
            onChange={(event) => setKeyword(event.target.value)}
            autoComplete='off'
          />
        </div>

        <div className='flex shrink-0 items-center justify-between gap-2 px-0.5'>
          <p className='text-label text-muted-foreground'>
            {keyword.trim()
              ? `搜索结果 (${filteredScenarios.length})`
              : `全部可用场景 (${availableScenarios.length})`}
          </p>
          {filteredScenarios.length > 0 ? (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-7 px-2 text-label'
              onClick={() => setSelectedIds((current) => toggleCurrentListSelection(current, visibleIds))}
            >
              {allVisibleSelected ? `取消当前 (${visibleIds.length})` : `全选当前 (${visibleIds.length})`}
            </Button>
          ) : null}
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-card bg-muted/20 p-1.5'>
          {filteredScenarios.length === 0 ? (
            <div className='flex flex-col items-center justify-center gap-2 px-4 py-10 text-center'>
              <p className='text-label text-muted-foreground'>未找到匹配的场景</p>
              {keyword.trim() ? (
                <Button type='button' variant='ghost' size='sm' onClick={() => setKeyword('')}>
                  清空搜索
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className='space-y-0.5'>
              {filteredScenarios.map((scenario) => {
                const checked = selectedSet.has(scenario.id)
                const alreadyAdded = alreadyInSuite.has(scenario.id)
                return (
                  <li key={scenario.id}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2',
                        'hover:bg-accent/70 active:bg-accent',
                        checked && 'bg-accent text-accent-foreground',
                      )}
                    >
                      <Checkbox
                        className='mt-0.5 shrink-0'
                        checked={checked}
                        onCheckedChange={() => toggle(scenario.id)}
                        aria-label={`选择 ${scenario.name}`}
                      />
                      <span className='flex min-w-0 flex-1 items-start gap-2'>
                        <span className='mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground'>
                          <Layers className='size-3.5' />
                        </span>
                        <span className='min-w-0 flex-1'>
                          <ScenarioName name={scenario.name} />
                          <span className='mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                            {scenario.latestVersionNo ? <span>已发布 v{scenario.latestVersionNo}</span> : <span>已发布</span>}
                            {alreadyAdded ? (
                              <Badge
                                variant='secondary'
                                className='h-4 px-1.5 text-3xs font-normal text-muted-foreground'
                              >
                                已在集合
                              </Badge>
                            ) : null}
                          </span>
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {selectedCount > 0 ? (
          <div className='shrink-0 space-y-1.5'>
            <p className='text-label text-muted-foreground' aria-live='polite'>
              已选 {selectedCount} 个
            </p>
            <div className='flex max-h-20 flex-wrap gap-1.5 overflow-y-auto'>
              {selectedIds.map((id) => {
                const name = scenarioById.get(id)?.name ?? id
                return (
                  <button
                    key={id}
                    type='button'
                    title={name}
                    className='inline-flex h-7 max-w-[11rem] min-w-0 items-center gap-1 rounded-full border border-border bg-muted/70 px-2.5 text-label text-foreground transition-transform duration-100 active:scale-[0.97]'
                    onClick={() => toggle(id)}
                    aria-label={`取消选择 ${name}`}
                  >
                    <span className='truncate'>{name}</span>
                    <X className='size-3 shrink-0 text-muted-foreground' />
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

        <DialogFooter className='shrink-0 gap-2 border-t border-border/50 bg-card/80 pt-3 backdrop-blur-md sm:items-center sm:justify-between'>
          <p className='text-label text-muted-foreground sm:text-start'>
            {selectedCount > 0 ? '换关键词可继续勾选，已选不会丢失' : '勾选要加入的场景'}
          </p>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={closePicker}>
              取消
            </Button>
            <Button type='button' disabled={selectedCount === 0} onClick={handleConfirm}>
              加入所选 ({selectedCount})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
