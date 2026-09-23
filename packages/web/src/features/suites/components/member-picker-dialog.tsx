import { useMemo, useState } from 'react'
import { Check, Layers, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function MemberPickerDialog({
  open,
  onOpenChange,
  availableScenarios,
  title = '选择场景加入流水线',
  onSelectScenario,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableScenarios: Array<{ id: string; name: string; latestVersionId?: string }>
  title?: string
  onSelectScenario: (scenarioId: string) => void
}) {
  const [keyword, setKeyword] = useState('')

  const filteredScenarios = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return availableScenarios
    return availableScenarios.filter((item) => item.name.toLowerCase().includes(q))
  }, [availableScenarios, keyword])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-lg'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            选择已发布的目标系统场景加入当前编排，同一个场景支持在不同阶段重复引用。
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-3 py-1'>
          {/* Search bar */}
          <div className='relative'>
            <Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
            <Input
              value={keyword}
              placeholder='搜索场景名称...'
              className='pl-9 text-body'
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>

          {/* Scenario list */}
          <div className='max-h-72 overflow-y-auto space-y-1.5 pr-1'>
            {filteredScenarios.length === 0 ? (
              <div className='py-8 text-center text-label text-muted-foreground'>
                未找到匹配的场景。
              </div>
            ) : (
              filteredScenarios.map((sc) => (
                <div
                  key={sc.id}
                  className='flex items-center justify-between gap-2.5 rounded-lg border border-border-card bg-card p-2.5 transition-colors hover:border-border hover:bg-muted/30'
                >
                  <div className='flex items-center gap-2 min-w-0'>
                    <div className='flex size-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground shrink-0'>
                      <Layers className='size-3.5' />
                    </div>
                    <div className='min-w-0'>
                      <p className='text-body font-medium truncate'>{sc.name}</p>
                      {sc.latestVersionId ? (
                        <p className='text-label text-muted-foreground font-mono'>
                          版本: {sc.latestVersionId}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-label shrink-0'
                    onClick={() => {
                      onSelectScenario(sc.id)
                      onOpenChange(false)
                    }}
                  >
                    <Check className='size-3 mr-1' />
                    添加
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
