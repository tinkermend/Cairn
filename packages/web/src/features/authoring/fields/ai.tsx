import {
  OUTPUT_FIELD_TYPES,
  type AiOutputSchema,
  type OutputFieldType,
  type Step,
  type OutputShape,
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
import { fieldElementId } from '../document'
import type { BindingOption } from '../document'
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
  if (step.type === 'ai_action') return (
    <div className='space-y-3'>
      <Label>操作方式</Label>
      <Select value={'operation' in step.input ? step.input.operation : 'intent'} disabled={disabled} onValueChange={(operation) => {
        const input = operation === 'intent' ? { instruction: '完成指定的页面操作' }
          : operation === 'tap' ? { operation: 'tap' as const, targetDescription: '' }
          : operation === 'input' ? { operation: 'input' as const, mode: 'replace' as const, targetDescription: '', value: '' }
          : operation === 'keyboard' ? { operation: 'keyboard' as const, key: 'Enter' }
          : { operation: 'scroll' as const, direction: 'down' as const, distance: 300 }
        onChange({ ...step, input, policy: { ...step.policy, retryLimit: 0 } })
      }}>
        <SelectTrigger className='w-full' aria-label='AI 操作方式'><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value='intent'>业务意图</SelectItem><SelectItem value='tap'>点击目标</SelectItem><SelectItem value='input'>输入文字</SelectItem><SelectItem value='keyboard'>按键</SelectItem><SelectItem value='scroll'>相对滚动</SelectItem></SelectContent>
      </Select>
      {'operation' in step.input ? <AtomicActionFields step={step} disabled={disabled} bindings={bindings} shapes={shapes} onChange={onChange} /> : <InstructionFields step={step} disabled={disabled} onChange={onChange} />}
    </div>
  )
  return <InstructionFields step={step} disabled={disabled} onChange={onChange} />
}

function AtomicActionFields({ step, disabled, bindings, shapes, onChange }: { step: Extract<Step, { type: 'ai_action' }>; disabled?: boolean; bindings: BindingOption[]; shapes: Map<string, OutputShape>; onChange: (step: Step) => void }) {
  const input = step.input
  if (!('operation' in input)) return null
  const update = (patch: Record<string, unknown>) => onChange({ ...step, input: { ...input, ...patch } } as Step)
  return <div className='space-y-3'>
    <div className='space-y-2'><Label htmlFor={`atom-target-${step.id}`}>目标描述{input.operation === 'keyboard' || input.operation === 'scroll' ? '（可选）' : ''}</Label>
      <Textarea id={`atom-target-${step.id}`} value={input.targetDescription ?? ''} disabled={disabled} onChange={(e) => update({ targetDescription: e.target.value || undefined })} />
      {input.operation === 'keyboard' && <p className='text-label text-muted-foreground'>不填写目标时，在当前焦点上发送按键。</p>}
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
    <p className='text-label text-muted-foreground'>每次执行一个明确动作。存在副作用，不会自动重试。</p>
  </div>
}

function InstructionFields({ step, disabled, onChange }: { step: Extract<Step, { type: 'ai_action' | 'ai_extract' | 'ai_assert' }>; disabled?: boolean; onChange: (step: Step) => void }) {
  if (!('instruction' in step.input)) return null
  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <Label htmlFor={fieldElementId(step.id, ['input', 'instruction'])}>
          业务指令
        </Label>
        <Textarea
          id={fieldElementId(step.id, ['input', 'instruction'])}
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
      <p className='text-label text-muted-foreground'>
        {step.type === 'ai_action'
          ? '副作用固定为有副作用，且不允许自动重试。'
          : '此步骤只读。判断不成立不是可改重试的故障。'}
      </p>
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
