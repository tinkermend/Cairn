import {
  EXECUTION_ERROR_CATEGORIES,
  type ExecutionErrorCategory,
  type OutputShape,
  type Step,
} from '@cairn/shared'
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
import { defaultTarget } from '../step-registry'
import { AiStepFields } from './ai'
import { AssertFields } from './assert'
import { BindingFields } from './binding'
import { CATEGORY_LABELS } from './labels'
import { TargetFields } from './target'

export function StepFields({
  step,
  bindings,
  shapes,
  disabled,
  onChange,
}: {
  step: Step
  bindings: BindingOption[]
  shapes: Map<string, OutputShape>
  disabled?: boolean
  onChange: (step: Step) => void
}) {
  if (
    step.type === 'ai_action' ||
    step.type === 'ai_extract' ||
    step.type === 'ai_assert'
  ) {
    return <AiStepFields step={step} disabled={disabled} bindings={bindings} shapes={shapes} onChange={onChange} />
  }
  if (step.type === 'navigate') {
    return (
      <div className='space-y-2'>
        <Label htmlFor={fieldElementId(step.id, ['input', 'url'])}>
          页面地址
        </Label>
        <Input
          id={fieldElementId(step.id, ['input', 'url'])}
          value={step.input.url}
          disabled={disabled}
          aria-invalid={step.input.url.trim().length === 0}
          onChange={(event) =>
            onChange({ ...step, input: { url: event.target.value } })
          }
        />
      </div>
    )
  }
  if (step.type === 'delay') {
    return (
      <div className='space-y-2'>
        <Label htmlFor={`step-delay-${step.id}`}>等待时间（毫秒）</Label>
        <Input
          id={`step-delay-${step.id}`}
          type='number'
          min={0}
          disabled={disabled}
          value={step.input.durationMs}
          onChange={(event) =>
            onChange({
              ...step,
              input: { durationMs: Number(event.target.value) },
            })
          }
        />
      </div>
    )
  }
  if (step.type === 'fail') {
    return (
      <div className='space-y-3'>
        <div className='space-y-2'>
          <Label htmlFor={`step-fail-${step.id}`}>失败说明</Label>
          <Input
            id={`step-fail-${step.id}`}
            value={step.input.message}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...step,
                input: { ...step.input, message: event.target.value },
              })
            }
          />
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor={`step-fail-code-${step.id}`}>错误码（可选）</Label>
            <Input
              id={`step-fail-code-${step.id}`}
              value={step.input.code ?? ''}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    code: event.target.value.trim() || undefined,
                  },
                })
              }
            />
          </div>
          <div className='space-y-2'>
            <Label>分类（可选）</Label>
            <Select
              value={step.input.category ?? '__none__'}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    category:
                      value === '__none__'
                        ? undefined
                        : (value as ExecutionErrorCategory),
                  },
                })
              }
            >
              <SelectTrigger className='w-full' aria-label='失败分类'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__none__'>不指定</SelectItem>
                {EXECUTION_ERROR_CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <label className='flex items-center gap-2 text-small'>
          <input
            type='checkbox'
            checked={step.input.retryable === true}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...step,
                input: {
                  ...step.input,
                  retryable: event.target.checked || undefined,
                },
              })
            }
          />
          提示可重试
        </label>
      </div>
    )
  }
  if (step.type === 'echo' || step.type === 'fill') {
    const from = step.input.from ?? ''
    const value = step.input.value ?? ''
    return (
      <div className='space-y-3'>
        {step.type === 'fill' ? (
          <TargetFields
            target={step.input.target}
            disabled={disabled}
            onChange={(target) =>
              onChange({ ...step, input: { ...step.input, target } })
            }
          />
        ) : null}
        <BindingFields
          id={step.id}
          from={from}
          fromField={step.input.fromField}
          value={
            typeof value === 'string'
              ? value
              : value === undefined
                ? ''
                : JSON.stringify(value)
          }
          bindings={bindings}
          shape={from ? shapes.get(from) : undefined}
          disabled={disabled}
          onBinding={(nextFrom, nextValue, nextField) => {
            if (step.type === 'echo') {
              onChange({
                ...step,
                input: nextFrom
                  ? { from: nextFrom, fromField: nextField }
                  : { value: nextValue },
              })
              return
            }
            onChange({
              ...step,
              input: nextFrom
                ? {
                    target: step.input.target,
                    from: nextFrom,
                    fromField: nextField,
                    sensitive: step.input.sensitive,
                  }
                : {
                    target: step.input.target,
                    value: nextValue,
                    sensitive: step.input.sensitive,
                  },
            })
          }}
        />
        {step.type === 'fill' ? (
          <label className='flex items-center gap-2 text-small'>
            <input
              type='checkbox'
              checked={step.input.sensitive === true}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    sensitive: event.target.checked || undefined,
                  },
                })
              }
            />
            敏感输入
          </label>
        ) : null}
      </div>
    )
  }
  if (step.type === 'click') {
    return (
      <div className='space-y-3'>
        <TargetFields
          target={step.input.target}
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <div className='grid gap-3 sm:grid-cols-3'>
          <div className='space-y-2'>
            <Label>鼠标键</Label>
            <Select
              value={step.input.button ?? 'left'}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    button:
                      value === 'left'
                        ? undefined
                        : (value as 'right' | 'middle'),
                  },
                })
              }
            >
              <SelectTrigger className='w-full' aria-label='鼠标键'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='left'>左键</SelectItem>
                <SelectItem value='right'>右键</SelectItem>
                <SelectItem value='middle'>中键</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-2'>
            <Label>次数</Label>
            <Select
              value={String(step.input.clickCount ?? 1)}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    clickCount: value === '2' ? 2 : undefined,
                  },
                })
              }
            >
              <SelectTrigger className='w-full' aria-label='点击次数'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='1'>单击</SelectItem>
                <SelectItem value='2'>双击</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className='space-y-2'>
          <Label>点击后页面</Label>
          <Select
            value={step.input.pageAfter ?? 'unset'}
            disabled={disabled}
            onValueChange={(value) => {
              const pageAfter: 'same' | 'popup' | undefined =
                value === 'same' || value === 'popup' ? value : undefined
              const next = {
                ...step.input,
                ...(pageAfter ? { pageAfter } : {}),
              }
              if (!pageAfter) delete next.pageAfter
              onChange({ ...step, input: next })
            }}
          >
            <SelectTrigger className='w-full' aria-label='点击后页面'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='unset'>未指定（保持当前页）</SelectItem>
              <SelectItem value='same'>保持当前页</SelectItem>
              <SelectItem value='popup'>切换到弹出窗口</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }
  if (step.type === 'select') {
    const from = step.input.from ?? ''
    return (
      <div className='space-y-3'>
        <TargetFields
          target={step.input.target}
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <div className='space-y-2'>
          <Label>选择方式</Label>
          <Select
            value={step.input.by}
            disabled={disabled}
            onValueChange={(value) => {
              const by = value as 'label' | 'value' | 'index'
              onChange({
                ...step,
                input:
                  by === 'index'
                    ? {
                        target: step.input.target,
                        by,
                        index: step.input.index ?? 0,
                      }
                    : {
                        target: step.input.target,
                        by,
                        value: step.input.value ?? '',
                      },
              })
            }}
          >
            <SelectTrigger className='w-full' aria-label='选择方式'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='label'>可见文本</SelectItem>
              <SelectItem value='value'>选项值</SelectItem>
              <SelectItem value='index'>序号</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {step.input.by === 'index' ? (
          <div className='space-y-2'>
            <Label htmlFor={`step-select-index-${step.id}`}>
              选项序号（从 0）
            </Label>
            <Input
              id={`step-select-index-${step.id}`}
              type='number'
              min={0}
              disabled={disabled}
              value={step.input.index ?? 0}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: {
                    target: step.input.target,
                    by: 'index',
                    index: Number(event.target.value),
                  },
                })
              }
            />
          </div>
        ) : (
          <BindingFields
            id={step.id}
            from={from}
            fromField={step.input.fromField}
            value={step.input.value ?? ''}
            bindings={bindings}
            shape={from ? shapes.get(from) : undefined}
            disabled={disabled}
            onBinding={(nextFrom, nextValue, nextField) =>
              onChange({
                ...step,
                input: nextFrom
                  ? {
                      target: step.input.target,
                      by: step.input.by,
                      from: nextFrom,
                      fromField: nextField,
                    }
                  : {
                      target: step.input.target,
                      by: step.input.by,
                      value: nextValue,
                    },
              })
            }
          />
        )}
      </div>
    )
  }
  if (step.type === 'keyboard') {
    return (
      <div className='space-y-3'>
        <TargetFields
          target={step.input.target ?? defaultTarget('焦点元素')}
          optional
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <label className='flex items-center gap-2 text-small'>
          <input
            type='checkbox'
            checked={Boolean(step.input.target)}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...step,
                input: event.target.checked
                  ? {
                      ...step.input,
                      target: step.input.target ?? defaultTarget('焦点元素'),
                    }
                  : { keys: step.input.keys },
              })
            }
          />
          先聚焦目标再按键
        </label>
        <div className='space-y-2'>
          <Label htmlFor={`step-keys-${step.id}`}>
            按键（逗号分隔，如 Enter 或 Control+s）
          </Label>
          <Input
            id={`step-keys-${step.id}`}
            value={step.input.keys.join(',')}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...step,
                input: {
                  ...step.input,
                  keys: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .slice(0, 4) as typeof step.input.keys,
                },
              })
            }
          />
        </div>
      </div>
    )
  }
  if (step.type === 'wait') {
    return (
      <div className='space-y-3'>
        <div className='space-y-2'>
          <Label>等待条件</Label>
          <Select
            value={step.input.kind}
            disabled={disabled}
            onValueChange={(value) => {
              const kind = value as typeof step.input.kind
              if (kind === 'time') {
                onChange({
                  ...step,
                  input: { kind, durationMs: step.input.durationMs ?? 1000 },
                })
                return
              }
              if (kind === 'url') {
                onChange({
                  ...step,
                  input: { kind, urlPattern: step.input.urlPattern ?? '' },
                })
                return
              }
              onChange({
                ...step,
                input: {
                  kind,
                  target: step.input.target ?? defaultTarget('等待元素'),
                  ...(kind === 'text' ? { text: step.input.text ?? '' } : {}),
                },
              })
            }}
          >
            <SelectTrigger className='w-full' aria-label='等待条件'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='time'>固定时间</SelectItem>
              <SelectItem value='visible'>元素可见</SelectItem>
              <SelectItem value='hidden'>元素消失</SelectItem>
              <SelectItem value='url'>地址匹配</SelectItem>
              <SelectItem value='text'>包含文本</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {step.input.kind === 'time' ? (
          <div className='space-y-2'>
            <Label htmlFor={`step-wait-ms-${step.id}`}>
              等待毫秒（最长 60 秒）
            </Label>
            <Input
              id={`step-wait-ms-${step.id}`}
              type='number'
              min={1}
              max={60_000}
              disabled={disabled}
              value={step.input.durationMs ?? 1000}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: {
                    kind: 'time',
                    durationMs: Number(event.target.value),
                  },
                })
              }
            />
          </div>
        ) : null}
        {step.input.kind === 'url' ? (
          <div className='space-y-2'>
            <Label htmlFor={`step-wait-url-${step.id}`}>地址包含</Label>
            <Input
              id={`step-wait-url-${step.id}`}
              disabled={disabled}
              value={step.input.urlPattern ?? ''}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: { kind: 'url', urlPattern: event.target.value },
                })
              }
            />
          </div>
        ) : null}
        {step.input.kind === 'visible' ||
        step.input.kind === 'hidden' ||
        step.input.kind === 'text' ? (
          <TargetFields
            target={step.input.target ?? defaultTarget('等待元素')}
            disabled={disabled}
            onChange={(target) =>
              onChange({ ...step, input: { ...step.input, target } })
            }
          />
        ) : null}
        {step.input.kind === 'text' ? (
          <div className='space-y-2'>
            <Label htmlFor={`step-wait-text-${step.id}`}>可见文本包含</Label>
            <Input
              id={`step-wait-text-${step.id}`}
              disabled={disabled}
              value={step.input.text ?? ''}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    target: step.input.target,
                    kind: 'text',
                    text: event.target.value,
                  },
                })
              }
            />
          </div>
        ) : null}
      </div>
    )
  }
  if (step.type === 'extract') {
    return (
      <div className='space-y-3'>
        <TargetFields
          target={step.input.target}
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label>提取类型</Label>
            <Select
              value={step.input.as}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    as: value as 'text' | 'value' | 'attribute',
                    attribute:
                      value === 'attribute'
                        ? (step.input.attribute ?? 'value')
                        : undefined,
                  },
                })
              }
            >
              <SelectTrigger className='w-full' aria-label='提取类型'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='text'>文本</SelectItem>
                <SelectItem value='value'>输入值</SelectItem>
                <SelectItem value='attribute'>元素属性</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {step.input.as === 'attribute' ? (
            <div className='space-y-2'>
              <Label htmlFor={`step-attr-${step.id}`}>属性名</Label>
              <Input
                id={`step-attr-${step.id}`}
                value={step.input.attribute ?? ''}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...step,
                    input: { ...step.input, attribute: event.target.value },
                  })
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    )
  }
  if (step.type === 'assert') {
    return (
      <div className='space-y-3'>
        <TargetFields
          target={step.input.target ?? defaultTarget('结果')}
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <AssertFields
          expect={step.input.expect}
          disabled={disabled}
          onChange={(next) =>
            onChange({ ...step, input: { ...step.input, expect: next } })
          }
        />
      </div>
    )
  }
  return null
}
