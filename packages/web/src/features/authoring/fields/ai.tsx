import {
  OUTPUT_FIELD_TYPES,
  type AiOutputSchema,
  type OutputFieldType,
  type Step,
  type OutputShape,
  type ContextBinding,
} from '@cairn/shared'
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
import { Textarea } from '@/components/ui/textarea'
import { Plus, Trash2 } from 'lucide-react'
import { FieldHelp } from '@/components/ui/field-help'
import { fieldElementId, type BindingOption } from '../document'
import { BindingFields } from './binding'

const TYPE_LABELS: Record<OutputFieldType, string> = {
  string: '文本',
  number: '数字',
  boolean: '布尔',
}

export function AiStepFields({
  step,
  disabled,
  onChange,
  bindings = [],
  shapes = new Map(),
}: {
  step: Extract<Step, { type: 'ai_action' | 'ai_extract' | 'ai_assert' }>
  disabled?: boolean
  onChange: (step: Step) => void
  bindings?: BindingOption[]
  shapes?: Map<string, OutputShape>
}) {
  return (
    <div className='space-y-4'>
      {step.type === 'ai_action' ? (
        <div className='space-y-3'>
          <div className='flex items-center gap-1.5'>
            <Label>视觉动作类型</Label>
            <span className='text-destructive font-semibold' aria-hidden='true'>*</span>
          </div>
          <Select value={'operation' in step.input ? step.input.operation : 'intent'} disabled={disabled} onValueChange={(operation) => {
            const input = operation === 'intent' ? { instruction: '完成指定的页面操作' }
              : operation === 'tap' ? { operation: 'tap' as const, targetDescription: '' }
              : operation === 'input' ? { operation: 'input' as const, mode: 'replace' as const, targetDescription: '', value: '' }
              : operation === 'keyboard' ? { operation: 'keyboard' as const, key: 'Enter' }
              : { operation: 'scroll' as const, direction: 'down' as const, distance: 300 }
            onChange({ ...step, input, policy: { ...step.policy, retryLimit: 0 } })
          }}>
            <SelectTrigger className='w-full' aria-label='视觉操作动作类型'><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value='intent'>业务意图</SelectItem><SelectItem value='tap'>点击目标</SelectItem><SelectItem value='input'>输入文字</SelectItem><SelectItem value='keyboard'>按键</SelectItem><SelectItem value='scroll'>相对滚动</SelectItem></SelectContent>
          </Select>
          {'operation' in step.input ? <AtomicActionFields step={step} disabled={disabled} bindings={bindings} shapes={shapes} onChange={onChange} /> : <InstructionFields step={step} disabled={disabled} onChange={onChange} />}
        </div>
      ) : (
        <InstructionFields step={step} disabled={disabled} onChange={onChange} />
      )}
      <ContextBindingsField
        stepId={step.id}
        bindings={step.contextBindings ?? []}
        disabled={disabled}
        onChange={(contextBindings) => onChange({ ...step, contextBindings })}
      />
    </div>
  )
}

export function ContextBindingsField({
  stepId: _stepId,
  bindings = [],
  disabled,
  onChange,
}: {
  stepId: string
  bindings: ContextBinding[]
  disabled?: boolean
  onChange: (bindings: ContextBinding[]) => void
}) {
  const addBinding = () => {
    onChange([
      ...bindings,
      {
        name: `param_${bindings.length + 1}`,
        source: 'inputs',
        path: 'key',
        required: true,
      },
    ])
  }

  const updateBinding = (index: number, patch: Partial<ContextBinding>) => {
    const next = [...bindings]
    next[index] = { ...next[index]!, ...patch }
    onChange(next)
  }

  const removeBinding = (index: number) => {
    onChange(bindings.filter((_, i) => i !== index))
  }

  return (
    <div className='space-y-2 rounded-md border p-3 bg-muted/20'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-1.5'>
          <Label className='text-label font-medium'>显式运行上下文绑定 (Context Bindings)</Label>
          <FieldHelp label='运行上下文绑定'>
            仅显式声明的输入或步骤输出才会注入大模型决策上下文，杜绝全量上下文与凭据泄露。
          </FieldHelp>
        </div>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled || bindings.length >= 16}
          className='gap-1 text-label h-7'
          onClick={addBinding}
        >
          <Plus className='h-3 w-3' />
          添加绑定
        </Button>
      </div>

      {bindings.length === 0 ? (
        <p className='text-label text-muted-foreground italic py-1'>暂无显式绑定参数</p>
      ) : (
        <div className='space-y-2 pt-1'>
          {bindings.map((binding, idx) => (
            <div key={idx} className='flex items-center gap-2'>
              <Input
                placeholder='变量名 (如 orderAmount)'
                value={binding.name}
                disabled={disabled}
                className='h-8 text-label w-1/3'
                onChange={(e) => updateBinding(idx, { name: e.target.value })}
              />
              <Select
                value={binding.source}
                disabled={disabled}
                onValueChange={(val: 'inputs' | 'steps') => updateBinding(idx, { source: val })}
              >
                <SelectTrigger className='h-8 text-label w-28'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='inputs'>场景输入</SelectItem>
                  <SelectItem value='steps'>步骤输出</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder='字段路径 (如 amount 或 step_1.token)'
                value={binding.path}
                disabled={disabled}
                className='h-8 text-label flex-1 font-mono'
                onChange={(e) => updateBinding(idx, { path: e.target.value })}
              />
              <Button
                type='button'
                size='sm'
                variant='ghost'
                disabled={disabled}
                className='h-8 w-8 p-0 text-muted-foreground hover:text-destructive'
                onClick={() => removeBinding(idx)}
              >
                <Trash2 className='h-4 w-4' />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AtomicActionFields({ step, disabled, bindings, shapes, onChange }: { step: Extract<Step, { type: 'ai_action' }>; disabled?: boolean; bindings: BindingOption[]; shapes: Map<string, OutputShape>; onChange: (step: Step) => void }) {
  const input = step.input
  if (!('operation' in input)) return null
  const update = (patch: Record<string, unknown>) => onChange({ ...step, input: { ...input, ...patch } } as Step)
  return <div className='space-y-3'>
    <div className='space-y-2'>
      <div className='flex items-center gap-1.5'>
        <Label htmlFor={`atom-target-${step.id}`}>目标描述{input.operation === 'keyboard' || input.operation === 'scroll' ? '（可选）' : ''}</Label>
        <FieldHelp label='目标描述'>
          {input.operation === 'keyboard'
            ? '不填写目标时，在当前焦点上发送按键。'
            : '描述要操作的页面元素，供视觉模型识别定位。每次执行一个明确动作；属于页面变更操作，不会自动盲目重试。'}
        </FieldHelp>
      </div>
      <Textarea id={`atom-target-${step.id}`} value={input.targetDescription ?? ''} disabled={disabled} onChange={(e) => update({ targetDescription: e.target.value || undefined })} />
    </div>
    {input.operation === 'input' && <>
      <Label>输入模式</Label><Select value={input.mode} disabled={disabled} onValueChange={(mode) => onChange({ ...step, input: mode === 'clear' ? { operation: 'input', mode, targetDescription: input.targetDescription } : { ...input, mode: mode as 'replace' | 'type_only', ...(input.from ? {} : { value: input.value ?? '' }) } })}>
        <SelectTrigger className='w-full' aria-label='输入模式'><SelectValue /></SelectTrigger><SelectContent><SelectItem value='replace'>替换内容</SelectItem><SelectItem value='type_only'>仅输入（保留原内容）</SelectItem><SelectItem value='clear'>清空</SelectItem></SelectContent>
      </Select>
      {input.mode !== 'clear' && <BindingFields id={step.id} from={input.from ?? ''} fromField={input.fromField} value={input.value ?? ''} bindings={bindings} shape={shapes.get(input.from ?? '')} disabled={disabled} onBinding={(from, value, fromField) => {
        const { value: _v, from: _f, fromField: _ff, ...base } = input
        onChange({ ...step, input: { ...base, ...(from ? { from, fromField } : { value }) } })
      }} />}
      {input.mode !== 'clear' && !input.from && !input.value && <p role='alert' className='text-label text-destructive'>输入不能为空；如需删除内容，请选择清空。</p>}
    </>}
    {input.operation === 'keyboard' && <div className='space-y-2'><Label htmlFor={`atom-key-${step.id}`}>按键组合</Label><Input id={`atom-key-${step.id}`} disabled={disabled} value={input.key} placeholder='Control+a / Enter' onChange={(e) => update({ key: e.target.value })} /></div>}
    {input.operation === 'scroll' && <div className='grid gap-3 sm:grid-cols-2'><div className='space-y-2'><Label>滚动方向</Label><Select disabled={disabled} value={input.direction} onValueChange={(direction) => update({ direction })}><SelectTrigger aria-label='滚动方向'><SelectValue /></SelectTrigger><SelectContent>{([['up', '向上'], ['down', '向下'], ['left', '向左'], ['right', '向右']] as const).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select></div><div className='space-y-2'><Label htmlFor={`atom-distance-${step.id}`}>距离（CSS 像素）</Label><Input id={`atom-distance-${step.id}`} type='number' min={1} max={10000} value={input.distance} disabled={disabled} onChange={(e) => update({ distance: Number(e.target.value) })} /></div></div>}
  </div>
}

function InstructionFields({ step, disabled, onChange }: { step: Extract<Step, { type: 'ai_action' | 'ai_extract' | 'ai_assert' }>; disabled?: boolean; onChange: (step: Step) => void }) {
  if (!('instruction' in step.input)) return null
  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <div className='flex items-center gap-1.5'>
          <Label htmlFor={fieldElementId(step.id, ['input', 'instruction'])}>
            业务指令
          </Label>
          <FieldHelp label='业务指令'>
            {step.type === 'ai_action'
              ? '视觉操作会使用视觉模型查看当前页面并执行动作；业务意图可能包含多个动作，异常时不会盲目重发。'
              : '此步骤为只读检查；符合条件时可先用 Aria 文本模型，未命中会回退视觉模型。“仅文本定位”只限制普通步骤找元素。'}
          </FieldHelp>
          <span className='text-destructive font-semibold' aria-hidden='true'>*</span>
        </div>
        <Textarea
          id={fieldElementId(step.id, ['input', 'instruction'])}
          aria-label='业务指令'
          value={step.input.instruction}
          disabled={disabled}
          onChange={(event) => {
            const instruction = event.target.value
            if (step.type === 'ai_extract') {
              onChange({ ...step, input: { ...step.input, instruction } })
              return
            }
            onChange({ ...step, input: { instruction } })
          }}
        />
      </div>
      {step.type === 'ai_extract' ? (
        <OutputSchemaFields
          stepId={step.id}
          schema={step.input.outputSchema}
          disabled={disabled}
          onChange={(outputSchema) =>
            onChange({ ...step, input: { ...step.input, outputSchema } })
          }
        />
      ) : null}
    </div>
  )
}

function OutputSchemaFields({
  stepId,
  schema,
  disabled,
  onChange,
}: {
  stepId: string
  schema: AiOutputSchema
  disabled?: boolean
  onChange: (schema: AiOutputSchema) => void
}) {
  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <Label>输出形状</Label>
        <Select
          value={schema.kind}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === 'scalar') onChange({ kind: 'scalar', type: 'string' })
            else if (value === 'list')
              onChange({
                kind: 'list',
                item: { kind: 'scalar', type: 'string' },
                maxItems: 50,
              })
            else
              onChange({
                kind: 'object',
                fields: [{ name: 'value', type: 'string', required: true }],
              })
          }}
        >
          <SelectTrigger className='w-full' aria-label='输出形状'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='object'>对象字段</SelectItem>
            <SelectItem value='scalar'>单个标量</SelectItem>
            <SelectItem value='list'>列表数组</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {schema.kind === 'scalar' ? (
        <div className='space-y-2'>
          <Label>标量类型</Label>
          <Select
            value={schema.type}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({ kind: 'scalar', type: value as OutputFieldType })
            }
          >
            <SelectTrigger className='w-full' aria-label='标量类型'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTPUT_FIELD_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : schema.kind === 'list' ? (
        <div className='space-y-2'>
          <Label>列表元素类型</Label>
          <p className='text-label text-muted-foreground'>
            {schema.item.kind === 'scalar' ? `标量 (${TYPE_LABELS[schema.item.type as OutputFieldType] ?? schema.item.type})` : '对象'}
          </p>
          <Label htmlFor={`ai-list-max-${stepId}`}>上限</Label>
          <Input
            id={`ai-list-max-${stepId}`}
            type='number'
            min={1}
            max={200}
            disabled={disabled}
            value={schema.maxItems ?? 50}
            onChange={(event) => {
              const maxItems = Math.min(200, Math.max(1, Number(event.target.value) || 1))
              onChange({ ...schema, maxItems })
            }}
          />
        </div>
      ) : (
        <div className='space-y-2'>
          <div className='flex items-center justify-between'>
            <Label>声明字段</Label>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={disabled || schema.fields.length >= 32}
              onClick={() =>
                onChange({
                  ...schema,
                  fields: [
                    ...schema.fields,
                    {
                      name: `field${schema.fields.length + 1}`,
                      type: 'string',
                      required: true,
                    },
                  ],
                })
              }
            >
              添加字段
            </Button>
          </div>
          {schema.fields.map((field, index) => (
            <div
              key={`${field.name}-${index}`}
              className='grid gap-2 sm:grid-cols-[1fr_7rem_auto]'
            >
              <Input
                id={
                  index === 0
                    ? fieldElementId(stepId, ['input', 'outputSchema'])
                    : undefined
                }
                aria-label={`字段名 ${index + 1}`}
                value={field.name}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...schema,
                    fields: schema.fields.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, name: event.target.value }
                        : item
                    ),
                  })
                }
              />
              <Select
                value={field.type}
                disabled={disabled}
                onValueChange={(value) =>
                  onChange({
                    ...schema,
                    fields: schema.fields.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, type: value as OutputFieldType }
                        : item
                    ),
                  })
                }
              >
                <SelectTrigger
                  className='w-full'
                  aria-label={`字段类型 ${index + 1}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTPUT_FIELD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                disabled={disabled || schema.fields.length <= 1}
                onClick={() =>
                  onChange({
                    ...schema,
                    fields: schema.fields.filter(
                      (_, itemIndex) => itemIndex !== index
                    ),
                  })
                }
              >
                移除
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
