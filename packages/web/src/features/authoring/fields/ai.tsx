import type { AiOutputSchema, OutputFieldType, Step } from '@cairn/shared'
import { OUTPUT_FIELD_TYPES } from '@cairn/shared'
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
import { fieldElementId } from './studio-document'

const TYPE_LABELS: Record<OutputFieldType, string> = {
  string: '文本',
  number: '数字',
  boolean: '布尔',
}

export function AiStepFields({
  step,
  disabled,
  onChange,
}: {
  step: Extract<Step, { type: 'ai_action' | 'ai_extract' | 'ai_assert' }>
  disabled?: boolean
  onChange: (step: Step) => void
}) {
  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <Label htmlFor={fieldElementId(step.id, ['input', 'instruction'])}>业务指令</Label>
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
          onChange={(outputSchema) => onChange({ ...step, input: { ...step.input, outputSchema } })}
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
            else onChange({ kind: 'object', fields: [{ name: 'value', type: 'string', required: true }] })
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
            onValueChange={(value) => onChange({ kind: 'scalar', type: value as OutputFieldType })}
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
                  fields: [...schema.fields, { name: `field${schema.fields.length + 1}`, type: 'string', required: true }],
                })
              }
            >
              添加字段
            </Button>
          </div>
          {schema.fields.map((field, index) => (
            <div key={`${field.name}-${index}`} className='grid gap-2 sm:grid-cols-[1fr_7rem_auto]'>
              <Input
                id={index === 0 ? fieldElementId(stepId, ['input', 'outputSchema']) : undefined}
                aria-label={`字段名 ${index + 1}`}
                value={field.name}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...schema,
                    fields: schema.fields.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name: event.target.value } : item,
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
                      itemIndex === index ? { ...item, type: value as OutputFieldType } : item,
                    ),
                  })
                }
              >
                <SelectTrigger className='w-full' aria-label={`字段类型 ${index + 1}`}>
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
                  onChange({ ...schema, fields: schema.fields.filter((_, itemIndex) => itemIndex !== index) })
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
