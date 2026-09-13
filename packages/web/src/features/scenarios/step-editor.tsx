import type {
  AssertExpect,
  CompileDiagnostic,
  EffectType,
  ExecutableStepType,
  ExecutionErrorCategory,
  LocatorBy,
  NumberCompareOp,
  RelativeAnchorScope,
  ScenarioInputDecl,
  Step,
  TargetDescriptor,
} from '@cairn/shared'
import {
  ASSERT_KINDS,
  EFFECT_TYPES,
  EXECUTABLE_STEP_TYPES,
  EXECUTION_ERROR_CATEGORIES,
  LOCATOR_BY,
  MAX_FRAME_DEPTH,
  NUMBER_COMPARE_OPS,
  RELATIVE_ANCHOR_SCOPES,
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
import { Button } from '@/components/ui/button'
import { EFFECT_TYPE_LABELS, STEP_TYPE_LABELS } from './labels'
import { createBlankStep, defaultTarget } from './blank-step'

const BY_LABELS: Record<LocatorBy, string> = {
  role: '角色',
  label: '标签',
  text: '文本',
  title: '标题',
  testId: '测试标识',
  css: 'CSS',
}

const KIND_LABELS: Record<AssertExpect['kind'], string> = {
  exists: '元素存在',
  visible: '元素可见',
  text_equals: '文本等于',
  text_contains: '文本包含',
  number_compare: '数值比较',
}

const OP_LABELS: Record<NumberCompareOp, string> = {
  eq: '等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
}

const CATEGORY_LABELS: Record<ExecutionErrorCategory, string> = {
  VALIDATION: '校验',
  TIMEOUT: '超时',
  CANCELLED: '取消',
  EXECUTOR: '执行器',
  INFRASTRUCTURE: '基础设施',
  UNKNOWN: '未知',
}

const ANCHOR_LABELS: Record<RelativeAnchorScope, string> = {
  row: '同一行',
  nearest: '最近',
}

type BindingOption = { key: string; label: string }

type StepEditorProps = {
  step: Step
  index: number
  bindings: BindingOption[]
  diagnostics: CompileDiagnostic[]
  disabled?: boolean
  onChange: (step: Step) => void
}

export function StepEditor({ step, index, bindings, diagnostics, disabled, onChange }: StepEditorProps) {
  const own = diagnostics.filter((item) => item.stepId === step.id)

  function replace(next: Step) {
    onChange(next)
  }

  return (
    <div className='space-y-5'>
      <div className='space-y-2'>
        <Label htmlFor={`step-name-${step.id}`}>步骤名称</Label>
        <Input
          id={`step-name-${step.id}`}
          value={step.name}
          disabled={disabled}
          onChange={(event) => replace({ ...step, name: event.target.value })}
        />
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label>类型</Label>
          <Select
            value={step.type}
            disabled={disabled}
            onValueChange={(value) => {
              const next = createBlankStep(value as ExecutableStepType)
              replace({ ...next, id: step.id, name: step.name || next.name })
            }}
          >
            <SelectTrigger className='w-full' aria-label={`步骤 ${index + 1} 类型`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXECUTABLE_STEP_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {STEP_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-2'>
          <Label>副作用</Label>
          <Select
            value={step.effectType}
            disabled={disabled}
            onValueChange={(value) => replace({ ...step, effectType: value as EffectType })}
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
      </div>
      <StepFields step={step} bindings={bindings} disabled={disabled} onChange={replace} />
      {step.type === 'extract' || step.type === 'echo' ? (
        <div className='space-y-2'>
          <Label htmlFor={`step-output-${step.id}`}>
            {step.type === 'extract' ? '输出名称（建议填写）' : '输出名称（可选）'}
          </Label>
          <Input
            id={`step-output-${step.id}`}
            value={step.outputKey ?? ''}
            disabled={disabled}
            onChange={(event) =>
              replace({ ...step, outputKey: event.target.value.trim() || undefined })
            }
          />
        </div>
      ) : null}
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label htmlFor={`step-timeout-${step.id}`}>超时（毫秒，可选）</Label>
          <Input
            id={`step-timeout-${step.id}`}
            type='number'
            min={1}
            disabled={disabled}
            value={step.policy?.timeoutMs ?? ''}
            onChange={(event) => {
              const timeoutMs = event.target.value === '' ? undefined : Number(event.target.value)
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
          <Label htmlFor={`step-retry-${step.id}`}>重试上限（可选）</Label>
          <Input
            id={`step-retry-${step.id}`}
            type='number'
            min={0}
            max={10}
            disabled={disabled}
            value={step.policy?.retryLimit ?? ''}
            onChange={(event) => {
              const retryLimit = event.target.value === '' ? undefined : Number(event.target.value)
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
      {own.length > 0 ? (
        <ul className='space-y-2' aria-label='该步骤的编译诊断'>
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
      ) : null}
    </div>
  )
}

function StepFields({
  step,
  bindings,
  disabled,
  onChange,
}: {
  step: Step
  bindings: BindingOption[]
  disabled?: boolean
  onChange: (step: Step) => void
}) {
  if (step.type === 'navigate') {
    return (
      <div className='space-y-2'>
        <Label htmlFor={`step-url-${step.id}`}>页面地址</Label>
        <Input
          id={`step-url-${step.id}`}
          value={step.input.url}
          disabled={disabled}
          onChange={(event) => onChange({ ...step, input: { url: event.target.value } })}
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
            onChange({ ...step, input: { durationMs: Number(event.target.value) } })
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
            onChange={(event) => onChange({ ...step, input: { ...step.input, message: event.target.value } })}
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
                  input: { ...step.input, code: event.target.value.trim() || undefined },
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
                    category: value === '__none__' ? undefined : (value as ExecutionErrorCategory),
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
                input: { ...step.input, retryable: event.target.checked || undefined },
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
            onChange={(target) => onChange({ ...step, input: { ...step.input, target } })}
          />
        ) : null}
        <BindingFields
          id={step.id}
          from={from}
          value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)}
          bindings={bindings}
          disabled={disabled}
          onBinding={(nextFrom, nextValue) => {
            if (step.type === 'echo') {
              onChange({
                ...step,
                input: nextFrom ? { from: nextFrom } : { value: nextValue },
              })
              return
            }
            onChange({
              ...step,
              input: nextFrom
                ? { target: step.input.target, from: nextFrom, sensitive: step.input.sensitive }
                : { target: step.input.target, value: nextValue, sensitive: step.input.sensitive },
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
                onChange({ ...step, input: { ...step.input, sensitive: event.target.checked || undefined } })
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
      <TargetFields
        target={step.input.target}
        disabled={disabled}
        onChange={(target) => onChange({ ...step, input: { target } })}
      />
    )
  }
  if (step.type === 'extract') {
    return (
      <div className='space-y-3'>
        <TargetFields
          target={step.input.target}
          disabled={disabled}
          onChange={(target) => onChange({ ...step, input: { ...step.input, target } })}
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
                    attribute: value === 'attribute' ? step.input.attribute ?? 'value' : undefined,
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
                  onChange({ ...step, input: { ...step.input, attribute: event.target.value } })
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div className='space-y-3'>
      <TargetFields
        target={step.input.target ?? defaultTarget('结果')}
        disabled={disabled}
        onChange={(target) => onChange({ ...step, input: { ...step.input, target } })}
      />
      <AssertFields
        expect={step.input.expect}
        disabled={disabled}
        onChange={(next) => onChange({ ...step, input: { ...step.input, expect: next } })}
      />
    </div>
  )
}

function BindingFields({
  id,
  from,
  value,
  bindings,
  disabled,
  onBinding,
}: {
  id: string
  from: string
  value: string
  bindings: BindingOption[]
  disabled?: boolean
  onBinding: (from: string, value: string) => void
}) {
  const known = bindings.some((item) => item.key === from)
  const custom = Boolean(from) && !known
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
              else if (next === '__custom__') onBinding(from && !known ? from : 'input1', value)
              else onBinding(next, value)
            }}
          >
            <SelectTrigger className='w-full' aria-label='引用上下文'>
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

function TargetFields({
  target,
  disabled,
  onChange,
}: {
  target: TargetDescriptor
  disabled?: boolean
  onChange: (target: TargetDescriptor) => void
}) {
  const candidates = target.candidates.length > 0 ? target.candidates : [{ by: 'label' as const, value: '' }]
  const frames = target.framePath ?? []
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <Label>页面元素</Label>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled || candidates.length >= 5}
          onClick={() => {
            const extra = { by: 'label' as const, value: '' }
            const last = candidates[candidates.length - 1]
            onChange({
              ...target,
              candidates: last?.by === 'css' ? [...candidates.slice(0, -1), extra, last] : [...candidates, extra],
            })
          }}
        >
          添加候选
        </Button>
      </div>
      {candidates.map((candidate, index) => (
        <div key={`${candidate.by}-${index}`} className='space-y-2'>
          <div className='grid gap-2 sm:grid-cols-[7rem_1fr_auto]'>
            <Select
              value={candidate.by}
              disabled={disabled}
              onValueChange={(value) => {
                const by = value as LocatorBy
                const updated = { ...candidate, by, name: by === 'role' ? candidate.name : undefined }
                const next =
                  by === 'css' && index !== candidates.length - 1
                    ? [...candidates.filter((_, itemIndex) => itemIndex !== index), updated]
                    : candidates.map((item, itemIndex) => (itemIndex === index ? updated : item))
                onChange({ ...target, candidates: next })
              }}
            >
              <SelectTrigger className='w-full' aria-label={`定位候选 ${index + 1}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATOR_BY.map((by) => (
                  <SelectItem
                    key={by}
                    value={by}
                    disabled={by === 'css' && index !== candidates.length - 1 && candidates.some((item) => item.by === 'css')}
                  >
                    {BY_LABELS[by]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={candidate.value}
              disabled={disabled}
              aria-label={candidate.by === 'role' ? `角色 ${index + 1}` : `定位值 ${index + 1}`}
              placeholder={candidate.by === 'role' ? '按钮 / 文本框' : undefined}
              onChange={(event) => {
                const next = candidates.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: event.target.value } : item,
                )
                onChange({ ...target, candidates: next })
              }}
            />
            {candidates.length > 1 ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...target,
                    candidates: candidates.filter((_, itemIndex) => itemIndex !== index),
                  })
                }
              >
                移除
              </Button>
            ) : null}
          </div>
          {candidate.by === 'role' ? (
            <Input
              value={candidate.name ?? ''}
              disabled={disabled}
              aria-label={`角色名称 ${index + 1}`}
              placeholder='无障碍名称（可选）'
              onChange={(event) => {
                const next = candidates.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, name: event.target.value.trim() || undefined } : item,
                )
                onChange({ ...target, candidates: next })
              }}
            />
          ) : null}
        </div>
      ))}
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <Label>Frame 路径（可选）</Label>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={disabled || frames.length >= MAX_FRAME_DEPTH}
            onClick={() => onChange({ ...target, framePath: [...frames, { selector: '' }] })}
          >
            添加 Frame
          </Button>
        </div>
        {frames.map((frame, index) => (
          <div key={`frame-${index}`} className='flex gap-2'>
            <Input
              value={frame.selector ?? frame.name ?? frame.urlPattern ?? ''}
              disabled={disabled}
              aria-label={`Frame ${index + 1}`}
              placeholder='iframe 选择器'
              onChange={(event) => {
                onChange({
                  ...target,
                  framePath: frames.map((item, itemIndex) =>
                    itemIndex === index ? { selector: event.target.value } : item,
                  ),
                })
              }}
            />
            <Button
              type='button'
              variant='ghost'
              size='sm'
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...target,
                  framePath: frames.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              移除
            </Button>
          </div>
        ))}
      </div>
      <div className='space-y-2'>
        <label className='flex items-center gap-2 text-small'>
          <input
            type='checkbox'
            checked={Boolean(target.anchor)}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...target,
                anchor: event.target.checked ? { withinText: '', scope: 'nearest' } : undefined,
              })
            }
          />
          相对锚点
        </label>
        {target.anchor ? (
          <div className='grid gap-2 sm:grid-cols-2'>
            <Input
              value={target.anchor.withinText}
              disabled={disabled}
              aria-label='锚点文本'
              placeholder='附近可见文本'
              onChange={(event) =>
                onChange({
                  ...target,
                  anchor: { ...target.anchor!, withinText: event.target.value },
                })
              }
            />
            <Select
              value={target.anchor.scope}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...target,
                  anchor: { ...target.anchor!, scope: value as RelativeAnchorScope },
                })
              }
            >
              <SelectTrigger className='w-full' aria-label='锚点范围'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATIVE_ANCHOR_SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {ANCHOR_LABELS[scope]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AssertFields({
  expect,
  disabled,
  onChange,
}: {
  expect: AssertExpect
  disabled?: boolean
  onChange: (expect: AssertExpect) => void
}) {
  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <Label>断言条件</Label>
        <Select
          value={expect.kind}
          disabled={disabled}
          onValueChange={(value) => {
            const kind = value as AssertExpect['kind']
            if (kind === 'exists' || kind === 'visible') onChange({ kind })
            else if (kind === 'text_equals' || kind === 'text_contains') onChange({ kind, value: '' })
            else onChange({ kind: 'number_compare', op: 'eq', value: 0 })
          }}
        >
          <SelectTrigger className='w-full' aria-label='断言条件'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASSERT_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {expect.kind === 'text_equals' || expect.kind === 'text_contains' ? (
        <div className='space-y-2'>
          <Label htmlFor='assert-value'>期望文本</Label>
          <Input
            id='assert-value'
            value={expect.value}
            disabled={disabled}
            onChange={(event) => onChange({ ...expect, value: event.target.value })}
          />
        </div>
      ) : null}
      {expect.kind === 'number_compare' ? (
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label>比较</Label>
            <Select
              value={expect.op}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...expect, op: value as NumberCompareOp })}
            >
              <SelectTrigger className='w-full' aria-label='数值比较'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NUMBER_COMPARE_OPS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {OP_LABELS[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='assert-number'>期望数值</Label>
            <Input
              id='assert-number'
              type='number'
              disabled={disabled}
              value={expect.value}
              onChange={(event) => onChange({ ...expect, value: Number(event.target.value) })}
            />
          </div>
        </div>
      ) : null}
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
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <h3 className='text-small font-semibold'>场景输入</h3>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled}
          onClick={() => onChange([...inputs, { key: `input${inputs.length + 1}`, label: '新输入' }])}
        >
          添加输入
        </Button>
      </div>
      {inputs.length === 0 ? (
        <p className='text-small text-muted-foreground'>没有声明输入。步骤引用未声明的键时，保存为警告，发布会被拦住。</p>
      ) : (
        inputs.map((input, index) => (
          <div key={`${input.key}-${index}`} className='grid gap-2 sm:grid-cols-2'>
            <Input
              aria-label={`输入键 ${index + 1}`}
              value={input.key}
              disabled={disabled}
              onChange={(event) =>
                onChange(inputs.map((item, itemIndex) => (itemIndex === index ? { ...item, key: event.target.value } : item)))
              }
            />
            <div className='flex gap-2'>
              <Input
                aria-label={`输入名称 ${index + 1}`}
                value={input.label}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, label: event.target.value } : item,
                    ),
                  )
                }
              />
              <Button
                type='button'
                variant='ghost'
                size='sm'
                disabled={disabled}
                onClick={() => onChange(inputs.filter((_, itemIndex) => itemIndex !== index))}
              >
                移除
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
