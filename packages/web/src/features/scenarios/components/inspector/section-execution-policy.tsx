import { useState } from 'react'
import { ChevronDown, ShieldAlert } from 'lucide-react'
import {
  EFFECT_TYPES,
  isAiStepType,
  type EffectType,
  type Step,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FieldHelp } from '@/components/ui/field-help'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fieldElementId } from '@/features/authoring/document'
import { EFFECT_TYPE_LABELS } from '@/features/authoring/labels'

export interface SectionExecutionPolicyProps {
  step: Step
  index: number
  disabled?: boolean
  onChange: (step: Step) => void
}

export function SectionExecutionPolicy({
  step,
  index,
  disabled,
  onChange,
}: SectionExecutionPolicyProps) {
  const [open, setOpen] = useState(false)
  const aiLocked = isAiStepType(step.type)

  // 检查是否存在非默认自定义配置（用于折叠时的 Active Pill 摘要）
  const hasCustomRetry = typeof step.policy?.retryLimit === 'number' && step.policy.retryLimit > 0
  const hasCustomTimeout = typeof step.policy?.timeoutMs === 'number' && step.policy.timeoutMs > 0
  const hasCustomEffect = step.effectType && step.effectType !== 'IDEMPOTENT' && !aiLocked
  const hasNonDefaultConfig = hasCustomRetry || hasCustomTimeout || hasCustomEffect

  return (
    <div data-testid='section-execution-policy' className='border-t border-border-divider pt-3'>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='w-full justify-between px-1.5 py-1 text-label text-muted-foreground hover:text-foreground'
          >
            <div className='flex items-center gap-1.5'>
              <ShieldAlert className='size-3.5 text-muted-foreground' />
              <span className='font-medium'>执行与容错策略</span>
              {/* 《识途宪法》直达保障：非默认配置激活摘要微标 */}
              {hasNonDefaultConfig && !open && (
                <div className='flex items-center gap-1 ml-1.5' data-testid='policy-active-pills'>
                  {hasCustomRetry && (
                    <span className='rounded bg-primary/10 px-1.5 py-0.2 text-caption font-mono text-primary'>
                      重试 {step.policy?.retryLimit}次
                    </span>
                  )}
                  {hasCustomTimeout && (
                    <span className='rounded bg-muted px-1.5 py-0.2 text-caption font-mono text-muted-foreground'>
                      {step.policy?.timeoutMs}ms
                    </span>
                  )}
                  {hasCustomEffect && (
                    <span className='rounded bg-status-warning/10 px-1.5 py-0.2 text-caption text-status-warning-foreground'>
                      {EFFECT_TYPE_LABELS[step.effectType]}
                    </span>
                  )}
                </div>
              )}
            </div>
            <ChevronDown className={`size-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className='space-y-4 pt-3 px-1'>
          {/* 副作用语义 */}
          <div className='space-y-1.5'>
            <div className='flex items-center gap-1.5'>
              <Label className='text-label'>副作用（重试与幂等语义）</Label>
              <FieldHelp label='副作用'>
                {aiLocked
                  ? 'AI 步骤的副作用由模型类型锁定，不能调整为只读获得重试。'
                  : '声明该步骤是否会对业务系统产生持久副作用。只读操作可在失败时安全自动重试，写操作默认不自动重试以防产生脏数据。'}
              </FieldHelp>
            </div>
            <Select
              value={step.effectType}
              disabled={disabled || aiLocked || step.type === 'wait'}
              onValueChange={(value) => {
                if (
                  step.type === 'ai_action' ||
                  step.type === 'ai_extract' ||
                  step.type === 'ai_assert' ||
                  step.type === 'wait'
                ) {
                  return
                }
                onChange({ ...step, effectType: value as EffectType } as Step)
              }}
            >
              <SelectTrigger className='w-full' aria-label={`步骤 ${index + 1} 副作用`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFECT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {EFFECT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 超时与重试网格 */}
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor={fieldElementId(step.id, ['policy', 'timeoutMs'])} className='text-label'>
                步骤超时（毫秒）
              </Label>
              <Input
                id={fieldElementId(step.id, ['policy', 'timeoutMs'])}
                type='number'
                min={1}
                disabled={disabled}
                placeholder='默认'
                value={step.policy?.timeoutMs ?? ''}
                className='border-control focus:border-primary shadow-control-focus font-mono'
                onChange={(event) => {
                  const timeoutMs = event.target.value === '' ? undefined : Number(event.target.value)
                  onChange({
                    ...step,
                    policy: { ...step.policy, timeoutMs },
                  })
                }}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor={fieldElementId(step.id, ['policy', 'retryLimit'])} className='text-label'>
                重试上限（0~10 次）
              </Label>
              <Input
                id={fieldElementId(step.id, ['policy', 'retryLimit'])}
                type='number'
                min={0}
                max={10}
                disabled={disabled || step.type === 'ai_action'}
                placeholder='0'
                value={step.type === 'ai_action' ? 0 : (step.policy?.retryLimit ?? '')}
                className='border-control focus:border-primary shadow-control-focus font-mono'
                onChange={(event) => {
                  const retryLimit = event.target.value === '' ? undefined : Number(event.target.value)
                  onChange({
                    ...step,
                    policy: { ...step.policy, retryLimit },
                  })
                }}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
