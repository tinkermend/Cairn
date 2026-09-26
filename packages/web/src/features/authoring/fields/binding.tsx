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
import { useAuthoringObserve } from '../observe'
import { ContextBindingPopover } from './context-binding-popover'
import { ContextMentionInput } from '@/features/scenarios/components/context-mention-input'

export function BindingFields({
  id,
  from,
  fromField,
  value,
  bindings,
  shape,
  disabled,
  allowGenerators = false,
  onBinding,
}: {
  id: string
  from: string
  fromField?: string
  value: string
  bindings: BindingOption[]
  shape?: OutputShape
  disabled?: boolean
  allowGenerators?: boolean
  onBinding: (from: string, value: string, fromField?: string) => void
}) {
  const observe = useAuthoringObserve()
  const known = bindings.some((item) => item.key === from)
  const custom = Boolean(from) && !known
  const objectFields = shape?.kind === 'object' ? shape.fields : []
  const showFields = Boolean(from) && shape?.kind === 'object'
  return (
    <div className='space-y-3'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <div className='flex items-center justify-between gap-1'>
            <Label className='flex items-center gap-1.5'>
              <span>引用上下文</span>
              <span className='rounded bg-muted px-1.5 py-0.2 text-label font-medium text-muted-foreground'>选填</span>
            </Label>
            <ContextBindingPopover
              bindings={bindings}
              run={observe.run}
              disabled={disabled}
              onBind={(b) => {
                if (b.sourceStepId && !bindings.some((item) => item.key === b.from)) {
                  observe.ensureStepOutputKey?.(b.sourceStepId, b.from)
                }
                onBinding(b.from, '', b.fromField)
              }}
            />
          </div>
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
              <SelectValue placeholder='直接填写' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__literal__'>直接填写</SelectItem>
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
          <Label htmlFor={`step-value-${id}`} className='flex items-center gap-1.5'>
            <span>内容</span>
            {from ? (
              <span className='rounded bg-muted px-1.5 py-0.2 text-label font-medium text-muted-foreground'>从引用填充</span>
            ) : (
              <span className='text-destructive font-semibold' aria-hidden='true'>*</span>
            )}
          </Label>
          <ContextMentionInput
            id={`step-value-${id}`}
            aria-label='内容'
            value={from ? '' : value}
            disabled={disabled || Boolean(from)}
            bindings={bindings}
            mode='binding_picker'
            onSelectBinding={(b) => onBinding(b.key, '')}
            onChange={(val) => onBinding('', val)}
            placeholder={from ? '从引用填充' : '输入内容，或输入 @ 快速选择上下文变量'}
          />
        </div>
      </div>
      {allowGenerators && !from && !disabled ? (
        <div className='flex flex-wrap items-center gap-1.5 pt-0.5 text-label text-muted-foreground'>
          <span className='shrink-0 text-label'>快捷填充:</span>
          <button
            type='button'
            className='rounded bg-muted/80 px-2 py-0.5 text-label hover:bg-muted text-foreground transition-colors font-medium border border-border-divider/50'
            onClick={() => {
              const rnd = `key_${Math.random().toString(36).slice(2, 8)}`
              onBinding('', rnd)
            }}
            title='生成随机文本标识'
          >
            🎲 随机文本
          </button>
          <button
            type='button'
            className='rounded bg-muted/80 px-2 py-0.5 text-label hover:bg-muted text-foreground transition-colors font-medium border border-border-divider/50'
            onClick={() => {
              const rndPhone = `138${Math.floor(10000000 + Math.random() * 90000000)}`
              onBinding('', rndPhone)
            }}
            title='生成11位手机号'
          >
            📱 手机号
          </button>
          <button
            type='button'
            className='rounded bg-muted/80 px-2 py-0.5 text-label hover:bg-muted text-foreground transition-colors font-medium border border-border-divider/50'
            onClick={() => {
              const rndNum = `${Math.floor(1000 + Math.random() * 9000)}`
              onBinding('', rndNum)
            }}
            title='生成4位随机数字'
          >
            🔢 4位数字
          </button>
          <button
            type='button'
            className='rounded bg-muted/80 px-2 py-0.5 text-label hover:bg-muted text-foreground transition-colors font-medium border border-border-divider/50'
            onClick={() => {
              const uuid = crypto.randomUUID()
              onBinding('', uuid)
            }}
            title='生成标准 UUID'
          >
            UUID
          </button>
        </div>
      ) : null}
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
