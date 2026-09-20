import { useState } from 'react'
import type { ModuleInputDecl, Step } from '@cairn/shared'
import { Check, Copy, Variable } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export type ScopeVariable = {
  key: string
  label: string
  type: string
  source: 'input' | 'step'
  expression: string
  description: string
}

interface ScopeVariablesBarProps {
  inputs: ModuleInputDecl[]
  priorSteps: Step[]
  className?: string
}

export function ScopeVariablesBar({
  inputs,
  priorSteps,
  className,
}: ScopeVariablesBarProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const variables: ScopeVariable[] = [
    ...inputs.map((input) => ({
      key: input.key,
      label: input.label,
      type: input.valueType,
      source: 'input' as const,
      expression: `\${inputs.${input.key}}`,
      description: `模块入参 · ${input.label || input.key} (${input.valueType})`,
    })),
    ...priorSteps
      .filter((step) => Boolean(step.outputKey))
      .map((step, idx) => ({
        key: step.outputKey!,
        label: step.name,
        type: 'output',
        source: 'step' as const,
        expression: `\${steps.${step.outputKey}}`,
        description: `前序产物 · 第 ${idx + 1} 步「${step.name}」输出`,
      })),
  ]

  const handleCopy = async (variable: ScopeVariable) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(variable.expression)
      }
      setCopiedKey(variable.key)
      toast.success(`已复制插值表达式 ${variable.expression}`)
      setTimeout(() => setCopiedKey(null), 1500)
    } catch {
      // 容错处理（部分未授权或非安全上下文环境）
      setCopiedKey(variable.key)
      setTimeout(() => setCopiedKey(null), 1500)
    }
  }

  if (variables.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-label text-muted-foreground',
          className
        )}
      >
        <Variable className='size-3.5 shrink-0 text-muted-foreground' />
        <span>当前无可用作用域变量。在左侧声明输入或在前序步骤中配置输出键后，可在此快速引用。</span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border border-border bg-muted/20 p-2.5',
        className
      )}
    >
      <div className='flex items-center justify-between text-label text-muted-foreground'>
        <div className='flex items-center gap-1.5 font-medium'>
          <Variable className='size-3.5 text-primary' />
          <span>可用作用域变量 ({variables.length})</span>
        </div>
        <span className='text-label'>点击复制插值表达式</span>
      </div>

      <div className='flex flex-wrap gap-1.5'>
        {variables.map((v) => {
          const isCopied = copiedKey === v.key
          return (
            <button
              key={`${v.source}-${v.key}`}
              type='button'
              title={`${v.description}\n点击复制 ${v.expression}`}
              aria-label={`复制变量 ${v.expression}`}
              onClick={() => handleCopy(v)}
              className={cn(
                'group inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-0.5 font-mono text-small transition-colors hover:border-primary/50 hover:bg-accent',
                isCopied && 'border-status-success-accent bg-status-success-background'
              )}
            >
              <span
                className={cn(
                  'font-medium text-label',
                  v.source === 'input'
                    ? 'text-primary'
                    : 'text-status-success-foreground'
                )}
              >
                {v.source === 'input' ? 'inputs.' : 'steps.'}
              </span>
              <span className='font-semibold text-foreground'>{v.key}</span>
              <span className='font-sans text-label text-muted-foreground'>
                ({v.type})
              </span>
              {isCopied ? (
                <Check className='ms-0.5 size-3 text-status-success-foreground' />
              ) : (
                <Copy className='ms-0.5 size-2.5 opacity-0 transition-opacity group-hover:opacity-100' />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
