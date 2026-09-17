import type { OutputShape } from '@cairn/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fieldElementId, type BindingOption } from '../document'

export function BindingFields({
  id,
  from,
  fromField,
  value,
  bindings,
  shape,
  disabled,
  onBinding,
}: {
  id: string
  from: string
  fromField?: string
  value: string
  bindings: BindingOption[]
  shape?: OutputShape
  disabled?: boolean
  onBinding: (from: string, value: string, fromField?: string) => void
}) {
  const known = bindings.some((item) => item.key === from)
  const custom = Boolean(from) && !known
  const objectFields = shape?.kind === 'object' ? shape.fields : []
  const showFields = Boolean(from) && shape?.kind === 'object'
  return (
    <div className='space-y-3'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label>引用上下文</Label>
          <Select
            value={custom ? '__custom__' : from || '__literal__'}
            disabled={disabled}
            onValueChange={(next) => {
              if (next === '__literal__') onBinding('', value)
              else if (next === '__custom__')
                onBinding(from && !known ? from : 'input1', value)
              else onBinding(next, value)
            }}
          >
            <SelectTrigger
              id={fieldElementId(id, ['input', 'from'])}
              className='w-full'
              aria-label='引用上下文'
            >
              <SelectValue placeholder='使用字面量' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__literal__'>使用字面量</SelectItem>
              {bindings.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {item.label}
                </SelectItem>
              ))}
              <SelectItem value='__custom__'>尚未声明的键</SelectItem>
            </SelectContent>
          </Select>
          {from && shape?.kind === 'unknown' ? (
            <p className='text-label text-muted-foreground'>
              来源没有静态类型，运行时再检查。不提供字段点选。
            </p>
          ) : null}
        </div>
        <div className='space-y-2'>
          <Label htmlFor={`step-value-${id}`}>内容</Label>
          <Input
            id={`step-value-${id}`}
            value={from ? '' : value}
            disabled={disabled || Boolean(from)}
            onChange={(event) => onBinding('', event.target.value)}
          />
        </div>
      </div>
      {showFields ? (
        <div className='space-y-2'>
          <Label>输出字段</Label>
          <Select
            value={
              fromField &&
              objectFields.some((field) => field.name === fromField)
                ? fromField
                : fromField
                  ? '__stale__'
                  : '__none__'
            }
            disabled={disabled}
            onValueChange={(next) => {
              if (next === '__none__') onBinding(from, value)
              else if (next !== '__stale__') onBinding(from, value, next)
            }}
          >
            <SelectTrigger
              id={fieldElementId(id, ['input', 'fromField'])}
              className='w-full'
              aria-label='输出字段'
            >
              <SelectValue placeholder='选择字段' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__none__'>选择字段</SelectItem>
              {objectFields.map((field) => (
                <SelectItem key={field.name} value={field.name}>
                  {field.name} · {field.type}
                  {field.required ? ' · 必填' : ''}
                </SelectItem>
              ))}
              {fromField &&
              !objectFields.some((field) => field.name === fromField) ? (
                <SelectItem value='__stale__'>{fromField}（失效）</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {custom ? (
        <div className='space-y-2'>
          <Label htmlFor={`step-from-${id}`}>未声明的输入键</Label>
          <Input
            id={`step-from-${id}`}
            value={from}
            disabled={disabled}
            onChange={(event) => onBinding(event.target.value.trim(), value)}
          />
        </div>
      ) : null}
    </div>
  )
}
