import type { ExecutableStepType, OutputShape, Step } from '@cairn/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fieldElementId, type BindingOption } from '@/features/authoring/document'
import { StepFields } from '@/features/authoring/fields/step-fields'
import { STEP_TYPE_LABELS } from '@/features/authoring/labels'
import { StepTypeIcon } from '../../step-type-icon'

import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export interface SectionActionDefProps {
  step: Step
  index: number
  bindings: BindingOption[]
  shapes: Map<string, OutputShape>
  editableTypes: readonly ExecutableStepType[]
  disabled?: boolean
  onChange: (step: Step) => void
  onRequestTypeChange: (type: ExecutableStepType) => void
}

export function SectionActionDef({
  step,
  index,
  bindings,
  shapes,
  editableTypes,
  disabled,
  onChange,
  onRequestTypeChange,
}: SectionActionDefProps) {
  const safeTypes = editableTypes ?? [step.type]
  const typeOptions = (
    safeTypes.includes(step.type) ? safeTypes : [step.type, ...safeTypes]
  ).filter((type) => type !== 'ai_action')

  return (
    <div data-testid='section-action-def' className='space-y-4'>
      {/* 步骤名称与启用/停用开关 */}
      <div className='space-y-1.5'>
        <div className='flex items-center justify-between'>
          <Label htmlFor={fieldElementId(step.id, ['name'])} className='flex items-center gap-1 text-label'>
            <span>步骤名称</span>
            <span className='text-destructive font-semibold' aria-hidden='true'>*</span>
          </Label>
          <label className='flex items-center gap-1.5 text-label cursor-pointer text-muted-foreground select-none'>
            <Switch
              checked={!step.disabled}
              disabled={disabled}
              aria-label='步骤启用状态'
              onCheckedChange={(checked) =>
                onChange({ ...step, disabled: !checked ? true : undefined })
              }
            />
            <span
              className={cn(
                'text-caption',
                step.disabled ? 'text-muted-foreground' : 'text-foreground font-medium',
              )}
            >
              {step.disabled ? '已跳过' : '已启用'}
            </span>
          </label>
        </div>
        <Input
          id={fieldElementId(step.id, ['name'])}
          aria-label='步骤名称'
          value={step.name}
          disabled={disabled}
          aria-invalid={step.name.trim().length === 0}
          className='border-control focus:border-primary shadow-control-focus'
          onChange={(event) => onChange({ ...step, name: event.target.value })}
        />
      </div>

      {/* 视觉操作只在自身的动作类型中切换，保留 ai_action 的执行语义。 */}
      {step.type !== 'ai_action' ? (
        <div className='space-y-1.5'>
          <Label className='text-label'>动作类型</Label>
          <Select
            value={step.type}
            disabled={disabled}
            onValueChange={(value) => onRequestTypeChange(value as ExecutableStepType)}
          >
            <SelectTrigger className='w-full' aria-label={`步骤 ${index + 1} 类型`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((type) => (
                <SelectItem key={type} value={type}>
                  <div className='flex items-center gap-2'>
                    <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                    <span>{STEP_TYPE_LABELS[type] ?? type}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {/* 动作核心输入字段 */}
      <div className='pt-1'>
        <StepFields
          step={step}
          bindings={bindings}
          shapes={shapes}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    </div>
  )
}
