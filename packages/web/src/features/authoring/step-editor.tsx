import {
  EFFECT_TYPES,
  isAiStepType,
  type CompileDiagnostic,
  type EffectType,
  type ExecutableStepType,
  type OutcomeContract,
  type OutputShape,
  type ScenarioInputDecl,
  type Step,
} from '@cairn/shared'
import { OutcomeListEditor } from './outcome-editor'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fieldElementId, type BindingOption } from './document'
import { StepFields } from './fields/step-fields'
import { GeneratorConfigEditor } from './generator-editor'
import { EFFECT_TYPE_LABELS, STEP_TYPE_LABELS } from './labels'

type StepEditorProps = {
  step: Step
  index: number
  bindings: BindingOption[]
  shapes: Map<string, OutputShape>
  editableTypes: readonly ExecutableStepType[]
  diagnostics: CompileDiagnostic[]
  disabled?: boolean
  outcomes?: OutcomeContract[]
  onChange: (step: Step) => void
  onOutcomesChange?: (outcomes: OutcomeContract[]) => void
  onRequestTypeChange: (type: ExecutableStepType) => void
}

export function StepEditor({
  step,
  index,
  bindings,
  shapes,
  editableTypes,
  diagnostics,
  disabled,
  outcomes,
  onChange,
  onOutcomesChange,
  onRequestTypeChange,
}: StepEditorProps) {
  const own = diagnostics.filter((item) => item.stepId === step.id)
  const aiLocked = isAiStepType(step.type)
  const typeOptions = editableTypes.includes(step.type)
    ? editableTypes
    : [step.type, ...editableTypes]

  function replace(next: Step) {
    onChange(next)
  }

  return (
    <div className='space-y-6 pb-12'>
      <section className='space-y-4' aria-label='操作'>
        <div className='space-y-1.5'>
          <Label htmlFor={fieldElementId(step.id, ['name'])}>步骤名称</Label>
          <Input
            id={fieldElementId(step.id, ['name'])}
            value={step.name}
            disabled={disabled}
            aria-invalid={step.name.trim().length === 0}
            onChange={(event) => replace({ ...step, name: event.target.value })}
          />
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label>类型</Label>
            <Select
              value={step.type}
              disabled={disabled}
              onValueChange={(value) =>
                onRequestTypeChange(value as ExecutableStepType)
              }
            >
              <SelectTrigger
                className='w-full'
                aria-label={`步骤 ${index + 1} 类型`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((type) => (
                  <SelectItem key={type} value={type}>
                    {STEP_TYPE_LABELS[type] ?? type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label>副作用</Label>
            <Select
              value={step.effectType}
              disabled={disabled || aiLocked || step.type === 'wait'}
              onValueChange={(value) => {
                if (
                  step.type === 'ai_action' ||
                  step.type === 'ai_extract' ||
                  step.type === 'ai_assert' ||
                  step.type === 'wait'
                )
                  return
                replace({ ...step, effectType: value as EffectType } as Step)
              }}
            >
              <SelectTrigger
                className='w-full'
                aria-label={`步骤 ${index + 1} 副作用`}
              >
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
            {aiLocked ? (
              <p className='text-label text-muted-foreground'>
                AI 步骤的副作用由类型锁定，不能改成只读来获得重试。
              </p>
            ) : null}
          </div>
        </div>
        <div className='border-t border-border-divider pt-4'>
          <StepFields
            step={step}
            bindings={bindings}
            shapes={shapes}
            disabled={disabled}
            onChange={replace}
          />
        </div>
        {step.type === 'extract' ||
        step.type === 'echo' ||
        step.type === 'ai_extract' ||
        step.type === 'ai_assert' ||
        step.type === 'download' ? (
          <div className='border-t border-border-divider pt-4 space-y-1.5'>
            <Label htmlFor={fieldElementId(step.id, ['outputKey'])}>
              {step.type === 'extract' || step.type === 'ai_extract' || step.type === 'download'
                ? '输出名称（建议填写）'
                : '输出名称（可选）'}
            </Label>
            <Input
              id={fieldElementId(step.id, ['outputKey'])}
              value={step.outputKey ?? ''}
              disabled={disabled}
              onChange={(event) =>
                replace({
                  ...step,
                  outputKey: event.target.value.trim() || undefined,
                })
              }
            />
          </div>
        ) : null}
      </section>
      {onOutcomesChange ? (
        <div className='border-t border-border-divider pt-4'>
          <OutcomeListEditor
            outcomes={outcomes ?? []}
            scope='step'
            disabled={disabled}
            onChange={onOutcomesChange}
          />
        </div>
      ) : null}
      <div className='border-t border-border-divider pt-2'>
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type='button' variant='ghost' size='sm' className='gap-1 text-muted-foreground hover:text-foreground'>
              高级选项
              <ChevronDown className='size-3.5' />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className='space-y-4 pt-3'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor={fieldElementId(step.id, ['policy', 'timeoutMs'])}>
            超时（毫秒，可选）
          </Label>
          <Input
            id={fieldElementId(step.id, ['policy', 'timeoutMs'])}
            type='number'
            min={1}
            disabled={disabled}
            value={step.policy?.timeoutMs ?? ''}
            onChange={(event) => {
              const timeoutMs =
                event.target.value === ''
                  ? undefined
                  : Number(event.target.value)
              replace({
                ...step,
                policy: {
                  ...step.policy,
                  timeoutMs,
                },
              })
            }}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor={fieldElementId(step.id, ['policy', 'retryLimit'])}>
            重试上限（可选）
          </Label>
          <Input
            id={fieldElementId(step.id, ['policy', 'retryLimit'])}
            type='number'
            min={0}
            max={10}
            disabled={disabled || step.type === 'ai_action'}
            value={
              step.type === 'ai_action' ? 0 : (step.policy?.retryLimit ?? '')
            }
            onChange={(event) => {
              const retryLimit =
                event.target.value === ''
                  ? undefined
                  : Number(event.target.value)
              replace({
                ...step,
                policy: {
                  ...step.policy,
                  retryLimit,
                },
              })
            }}
          />
        </div>
      </div>
        </CollapsibleContent>
      </Collapsible>
      </div>
      {own.length > 0 ? (
        <ul
          id={`studio-step-diagnostics-${step.id}`}
          tabIndex={-1}
          className='space-y-2'
          aria-label='该步骤的编译诊断'
        >
          {own.map((item) => (
            <li
              key={`${item.code}-${item.message}`}
              className={
                item.severity === 'error'
                  ? 'rounded-md bg-status-error-background p-3 text-small text-status-error-foreground'
                  : 'rounded-md bg-status-warning-background p-3 text-small text-status-warning-foreground'
              }
            >
              {item.message}
            </li>
          ))}
        </ul>
      ) : (
        <div
          id={`studio-step-diagnostics-${step.id}`}
          tabIndex={-1}
          className='sr-only'
        >
          该步骤没有编译诊断
        </div>
      )}
    </div>
  )
}

export function InputsEditor({
  inputs,
  disabled,
  onChange,
}: {
  inputs: ScenarioInputDecl[]
  disabled?: boolean
  onChange: (inputs: ScenarioInputDecl[]) => void
}) {
  return (
    <div className='space-y-4'>
      <div className='flex items-center justify-between'>
        <div>
          <h3 className='text-small font-semibold'>场景输入参数</h3>
          <p className='text-xs text-muted-foreground'>
            定义场景运行时接收的输入参数及 Mock 数据生成规则
          </p>
        </div>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled}
          onClick={() =>
            onChange([
              ...inputs,
              {
                key: `input${inputs.length + 1}`,
                label: `输入项 ${inputs.length + 1}`,
                type: 'string',
              },
            ])
          }
        >
          添加输入
        </Button>
      </div>
      {inputs.length === 0 ? (
        <div className='rounded-lg border border-dashed border-border-divider p-6 text-center space-y-3 bg-muted/20'>
          <p className='text-sm font-medium text-foreground'>尚未配置场景输入参数</p>
          <p className='text-xs text-muted-foreground max-w-xs mx-auto'>
            输入参数可在场景执行时由数据集、批量任务或外部传入，并支持 Mock 自动生成。没有声明输入时，步骤若引用未声明的键将产生警告。
          </p>
          <Button
            type='button'
            size='sm'
            variant='secondary'
            disabled={disabled}
            onClick={() =>
              onChange([
                ...inputs,
                {
                  key: `input${inputs.length + 1}`,
                  label: `输入项 ${inputs.length + 1}`,
                  type: 'string',
                },
              ])
            }
          >
            <Plus className='size-3.5 mr-1' />
            添加首个输入参数
          </Button>
        </div>
      ) : (
        inputs.map((input, index) => (
          <div
            key={`${input.key}-${index}`}
            className='p-3 border rounded-lg bg-card space-y-3'
          >
            <div className='grid gap-2 sm:grid-cols-12 items-center'>
              <div className='sm:col-span-4'>
                <Label className='text-xs text-muted-foreground mb-1 block'>参数标识 (Key)</Label>
                <Input
                  id={`studio-input-${input.key}`}
                  aria-label={`输入键 ${index + 1}`}
                  value={input.key}
                  disabled={disabled}
                  placeholder='如: phone, idCard'
                  onChange={(event) =>
                    onChange(
                      inputs.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, key: event.target.value }
                          : item
                      )
                    )
                  }
                />
              </div>
              <div className='sm:col-span-4'>
                <Label className='text-xs text-muted-foreground mb-1 block'>参数名称 (Label)</Label>
                <Input
                  aria-label={`输入名称 ${index + 1}`}
                  value={input.label}
                  disabled={disabled}
                  placeholder='如: 手机号'
                  onChange={(event) =>
                    onChange(
                      inputs.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, label: event.target.value }
                          : item
                      )
                    )
                  }
                />
              </div>
              <div className='sm:col-span-3'>
                <Label className='text-xs text-muted-foreground mb-1 block'>类型</Label>
                <Select
                  value={input.type ?? 'string'}
                  disabled={disabled}
                  onValueChange={(val: any) =>
                    onChange(
                      inputs.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, type: val }
                          : item
                      )
                    )
                  }
                >
                  <SelectTrigger className='w-full text-xs h-9'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='string'>文本 (string)</SelectItem>
                    <SelectItem value='number'>数值 (number)</SelectItem>
                    <SelectItem value='boolean'>布尔 (boolean)</SelectItem>
                    <SelectItem value='date'>日期 (date)</SelectItem>
                    <SelectItem value='file'>文件 (file)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className='sm:col-span-1 flex justify-end pt-5'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  disabled={disabled}
                  className='h-9 text-muted-foreground hover:text-destructive'
                  onClick={() =>
                    onChange(inputs.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  移除
                </Button>
              </div>
            </div>

            <GeneratorConfigEditor
              generator={input.defaultGenerator}
              disabled={disabled}
              onChange={(spec) =>
                onChange(
                  inputs.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, defaultGenerator: spec }
                      : item
                  )
                )
              }
            />
          </div>
        ))
      )}
    </div>
  )
}
