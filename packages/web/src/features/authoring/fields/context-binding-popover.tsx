import { useState } from 'react'
import { Braces, CornerDownRight, Database, Layers } from 'lucide-react'
import { stepRunFor, type RunDetailDto } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { StatusBadge } from '@/components/status-badge'
import { stepTypeLabel } from '@/features/scenarios/labels'
import { type BindingOption } from '../document'

export function ContextBindingPopover({
  bindings = [],
  run,
  onBind,
  disabled,
}: {
  bindings?: readonly BindingOption[]
  run?: RunDetailDto
  onBind: (binding: { from: string; fromField?: string; sourceStepId?: string }) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)

  // Extract steps from run snapshot if available
  const steps = run?.snapshot.steps ?? []
  const hasBindings = bindings.length > 0
  const hasRunSteps = steps.length > 0
  const hasAnySource = hasBindings || hasRunSteps

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          className='size-7 shrink-0'
          title='从前序步骤产出中选择'
          aria-label='从前序步骤产出中选择'
          disabled={disabled || !hasAnySource}
        >
          <Braces className='size-3.5 text-primary' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-80 max-h-80 overflow-y-auto p-3 text-small'
      >
        <div className='mb-2 border-b border-border-divider pb-2'>
          <h4 className='font-semibold text-foreground'>引用数据产出</h4>
          <p className='text-label text-muted-foreground'>
            点击字段直接绑定为步骤输入（免敲 context key）
          </p>
        </div>

        <div className='space-y-3'>
          {run && steps.length > 0 ? (
            <div className='space-y-2'>
              <div className='flex items-center gap-1.5 text-label font-medium text-muted-foreground'>
                <Database className='size-3' />
                <span>运行时的实际产出</span>
              </div>
              {steps.map((step, index) => {
                const stepRun = stepRunFor(run.stepRuns, step.id)
                const latestAttempt = stepRun?.attempts.slice(-1)[0]
                const output = latestAttempt?.output
                const outputKey = step.outputKey || `step_${index + 1}_output`

                if (!output && !step.outputKey) return null

                const isObjectOutput =
                  output &&
                  typeof output === 'object' &&
                  !Array.isArray(output) &&
                  Object.keys(output).length > 0

                return (
                  <div
                    key={step.id}
                    className='space-y-1.5 rounded-md border border-border-default bg-muted/20 p-2'
                  >
                    <div className='flex items-center justify-between gap-1'>
                      <div className='flex items-center gap-1 font-medium text-foreground truncate'>
                        <Layers className='size-3 shrink-0 text-muted-foreground' />
                        <span className='truncate'>{step.name}</span>
                      </div>
                      <StatusBadge tone='neutral'>{stepTypeLabel(step.type)}</StatusBadge>
                    </div>

                    {isObjectOutput ? (
                      <div className='space-y-1 pt-1'>
                        {Object.entries(output as Record<string, unknown>).map(([field, val]) => (
                          <button
                            key={field}
                            type='button'
                            className='flex w-full items-center justify-between rounded px-1.5 py-0.5 text-left hover:bg-action-hover'
                            onClick={() => {
                              onBind({
                                from: outputKey,
                                fromField: field,
                                sourceStepId: step.id,
                              })
                              setOpen(false)
                            }}
                          >
                            <span className='flex items-center gap-1 font-mono text-label text-foreground'>
                              <CornerDownRight className='size-2.5 text-muted-foreground' />
                              {field}
                            </span>
                            <span className='max-w-[120px] truncate text-label text-muted-foreground'>
                              {typeof val === 'string' ? val : JSON.stringify(val)}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className='flex items-center justify-between pt-1'>
                        <span className='font-mono text-label text-muted-foreground'>
                          输出: {step.outputKey || '(未命名产出)'}
                          {output !== undefined ? ` = ${String(output)}` : ''}
                        </span>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-6 px-2 text-label'
                          onClick={() => {
                            onBind({
                              from: outputKey,
                              sourceStepId: step.id,
                            })
                            setOpen(false)
                          }}
                        >
                          引用
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}

          {bindings.length > 0 && (
            <div className='space-y-1.5'>
              <div className='flex items-center gap-1.5 text-label font-medium text-muted-foreground'>
                <Layers className='size-3' />
                <span>可用上下文变量</span>
              </div>
              <div className='space-y-1 ps-1'>
                {bindings.map((item) => (
                  <button
                    key={item.key}
                    type='button'
                    className='flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-action-hover'
                    onClick={() => {
                      onBind({ from: item.key })
                      setOpen(false)
                    }}
                  >
                    <span className='font-mono text-foreground'>{item.key}</span>
                    <span className='text-label text-muted-foreground'>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
