import {
  EXPR_FUNCTIONS,
  EXECUTION_ERROR_CATEGORIES,
  type ExecutionErrorCategory,
  type OutputShape,
  type ResolutionPolicy,
  type LocatorPlan,
  type Step,
} from '@cairn/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FieldHelp } from '@/components/ui/field-help'
import { fieldElementId, type BindingOption } from '../document'
import { defaultTarget } from '../step-registry'
import { AiStepFields } from './ai'
import { AssertFields } from './assert'
import { BindingFields } from './binding'
import { CATEGORY_LABELS } from './labels'
import { TargetFields } from './target'

function policyHandlers(step: Step, onChange: (step: Step) => void) {
  return {
    policy: step.policy,
    onPolicyChange: (policy: { resolution?: ResolutionPolicy; locatorPlan?: LocatorPlan; deepLocate?: boolean }) => {
      const { resolution: _oldResolution, locatorPlan: _oldPlan, ...preserved } = step.policy ?? {}
      onChange({ ...step, policy: { ...preserved, ...policy } })
    },
  }
}

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
        <Label htmlFor={fieldElementId(step.id, ['input', 'url'])} className='flex items-center gap-1.5'>
          <span>页面地址</span>
          <span className='text-destructive font-semibold' aria-hidden='true'>*</span>
        </Label>
        <Input
          id={fieldElementId(step.id, ['input', 'url'])}
          aria-label='页面地址'
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
            {...policyHandlers(step, onChange)}
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
          allowGenerators={step.type === 'fill'}
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
          <div className='flex items-center gap-1.5'>
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
            <FieldHelp label='敏感输入'>
              勾选后，录入的内容在执行日志和快照证据中将被脱敏遮蔽，防止密码或私密凭据泄露。
            </FieldHelp>
          </div>
        ) : null}
      </div>
    )
  }
  if (step.type === 'click') {
    return (
      <div className='space-y-3'>
        <TargetFields
          {...policyHandlers(step, onChange)}
          target={step.input.target}
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <div className='grid gap-3 sm:grid-cols-2'>
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
          <div className='flex items-center gap-1.5'>
            <Label>点击后页面</Label>
            <FieldHelp label='点击后页面'>
              指定点击后期望保持当前页面或切换到弹出的新窗口/新标签页。
            </FieldHelp>
            <span className='rounded bg-muted px-1.5 py-0.2 text-caption font-medium text-muted-foreground'>选填</span>
          </div>
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
          {...policyHandlers(step, onChange)}
          target={step.input.target}
          disabled={disabled}
          onChange={(target) =>
            onChange({ ...step, input: { ...step.input, target } })
          }
        />
        <div className='space-y-2'>
          <div className='flex items-center gap-1.5'>
            <Label>选择方式</Label>
            <FieldHelp label='选择方式'>
              用于原生 HTML &lt;select&gt; 下拉框。若目标下拉框为浮层菜单或需动态／随机选择选项，可使用「视觉操作」（如：在当前分组下拉列表中随机选择一个分组）。
            </FieldHelp>
            <span className='text-destructive font-semibold' aria-hidden='true'>*</span>
          </div>
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
                <SelectItem value='label'>可见文本（界面显示的文字）</SelectItem>
                <SelectItem value='value'>选项值（HTML Value）</SelectItem>
                <SelectItem value='index'>选项序号（从 0 开始）</SelectItem>
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
          {...policyHandlers(step, onChange)}
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
          <div className='flex items-center gap-1.5'>
            <Label htmlFor={`step-keys-${step.id}`}>按键</Label>
            <FieldHelp label='按键'>
              按键名称以逗号分隔，最多 4 个。例如 Enter、Tab、Escape 或 Control+s。
            </FieldHelp>
          </div>
          <Input
            id={`step-keys-${step.id}`}
            value={step.input.keys.join(',')}
            disabled={disabled}
            placeholder='例如: Enter 或 Control+s'
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
              if (kind === 'semantic') {
                onChange({
                  ...step,
                  input: { kind, text: step.input.text ?? '' },
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
              <SelectItem value='semantic'>语义等待（尚未交付）</SelectItem>
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
            {...policyHandlers(step, onChange)}
            target={step.input.target ?? defaultTarget('等待元素')}
            disabled={disabled}
            onChange={(target) =>
              onChange({ ...step, input: { ...step.input, target } })
            }
          />
        ) : null}
        {step.input.kind === 'semantic' ? (
          <div className='space-y-2'>
            <div className='flex items-center gap-1.5'>
              <Label htmlFor={`step-wait-semantic-${step.id}`}>等待描述</Label>
              <FieldHelp label='等待描述'>
                契约已预留，发布前会提示当前部署尚未开放语义等待。
              </FieldHelp>
            </div>
            <Input
              id={`step-wait-semantic-${step.id}`}
              disabled={disabled}
              placeholder='例如：列表出现第一笔订单'
              value={step.input.text ?? ''}
              onChange={(event) =>
                onChange({
                  ...step,
                  input: { kind: 'semantic', text: event.target.value },
                })
              }
            />
          </div>
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
          {...policyHandlers(step, onChange)}
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
        <div className='flex items-center justify-between gap-3'>
          <div className='flex items-center gap-1.5'>
            <Label htmlFor={`step-many-${step.id}`}>提取全部匹配</Label>
            <FieldHelp label='提取全部匹配'>
              开启后提取所有匹配元素的内容并输出为数组列表；未开启时仅提取首个匹配项。
            </FieldHelp>
          </div>
          <Switch
            id={`step-many-${step.id}`}
            checked={Boolean(step.input.many)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({
                ...step,
                input: {
                  ...step.input,
                  many: checked ? { maxItems: step.input.many?.maxItems ?? 50 } : undefined,
                },
              })
            }
          />
        </div>
        {step.input.many ? (
          <div className='space-y-2'>
            <Label htmlFor={`step-many-max-${step.id}`}>上限</Label>
            <Input
              id={`step-many-max-${step.id}`}
              type='number'
              min={1}
              max={1000}
              disabled={disabled}
              value={step.input.many.maxItems}
              onChange={(event) => {
                const maxItems = Math.min(1000, Math.max(1, Number(event.target.value) || 1))
                onChange({
                  ...step,
                  input: { ...step.input, many: { ...step.input.many, maxItems } },
                })
              }}
            />
          </div>
        ) : null}
      </div>
    )
  }
  if (step.type === 'assert') {
    const isAriaSnapshot = step.input.expect.kind === 'aria_snapshot'
    return (
      <div className='space-y-3'>
        <AssertFields
          expect={step.input.expect}
          disabled={disabled}
          onChange={(next) =>
            onChange({
              ...step,
              input: {
                ...step.input,
                expect: next,
                target:
                  next.kind === 'aria_snapshot'
                    ? step.input.target
                    : (step.input.target ?? defaultTarget('结果')),
              },
            })
          }
        />
        {isAriaSnapshot ? (
          <div className='space-y-2 pt-1 border-t border-border/40'>
            <label className='flex items-center gap-2 text-small'>
              <input
                type='checkbox'
                checked={Boolean(step.input.target)}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...step,
                    input: {
                      ...step.input,
                      target: event.target.checked
                        ? (step.input.target ?? defaultTarget('断言作用域'))
                        : undefined,
                    },
                  })
                }
              />
              限定目标作用域（缺省匹配整页 body）
            </label>
            {step.input.target ? (
              <TargetFields
                {...policyHandlers(step, onChange)}
                target={step.input.target}
                optional
                disabled={disabled}
                onChange={(target) =>
                  onChange({ ...step, input: { ...step.input, target } })
                }
              />
            ) : null}
          </div>
        ) : (
          <TargetFields
            {...policyHandlers(step, onChange)}
            target={step.input.target ?? defaultTarget('结果')}
            disabled={disabled}
            onChange={(target) =>
              onChange({ ...step, input: { ...step.input, target } })
            }
          />
        )}
      </div>
    )
  }
  if (step.type === 'download') {
    return (
      <div className='space-y-3'>
        <div className='space-y-2'>
          <div className='flex items-center gap-1.5'>
            <Label className='text-small font-medium'>触发下载目标</Label>
            <FieldHelp label='触发下载目标'>
              可选。留空则等待前序步骤触发的下载；若点击页面上某个按钮触发下载，可在此处指定目标。
            </FieldHelp>
            <span className='rounded bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground'>选填</span>
          </div>
          <TargetFields
            {...policyHandlers(step, onChange)}
            target={step.input.target ?? defaultTarget('下载目标')}
            optional
            disabled={disabled}
            onChange={(target) =>
              onChange({ ...step, input: { ...step.input, target } })
            }
          />
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor={`step-wait-${step.id}`}>等待下载超时（毫秒）</Label>
            <Input
              id={`step-wait-${step.id}`}
              type='number'
              min={1000}
              max={120000}
              disabled={disabled}
              value={step.input.waitMs ?? 30000}
              onChange={(e) =>
                onChange({
                  ...step,
                  input: { ...step.input, waitMs: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor={`step-expect-name-${step.id}`}>期望文件名正则（可选）</Label>
            <Input
              id={`step-expect-name-${step.id}`}
              placeholder='如 \.csv$'
              disabled={disabled}
              value={step.input.expect?.fileNamePattern ?? ''}
              onChange={(e) =>
                onChange({
                  ...step,
                  input: {
                    ...step.input,
                    expect: {
                      ...step.input.expect,
                      fileNamePattern: e.target.value.trim() || undefined,
                    },
                  },
                })
              }
            />
          </div>
        </div>
      </div>
    )
  }
  if (step.type === 'upload') {
    const file = step.input.files[0]
    return (
      <div className='space-y-3'>
        <div className='space-y-2'>
          <Label className='text-small font-medium'>上传目标入口 / 文件选择框</Label>
          <TargetFields
            {...policyHandlers(step, onChange)}
            target={step.input.target}
            disabled={disabled}
            onChange={(target) =>
              onChange({ ...step, input: { ...step.input, target } })
            }
          />
        </div>
        <div className='space-y-2 pt-2 border-t border-border-divider'>
          <Label className='text-small font-medium'>上传文件附件来源</Label>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label>来源类型</Label>
              <Select
                value={file?.source ?? 'context'}
                disabled={disabled}
                onValueChange={(val) => {
                  if (val === 'context') {
                    onChange({
                      ...step,
                      input: {
                        ...step.input,
                        files: [
                          {
                            source: 'context',
                            from: file && file.source === 'context' ? file.from : (bindings[0]?.key ?? 'downloadedTemplate'),
                          },
                        ],
                      },
                    })
                  }
                }}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='context'>前序步骤输出句柄 (context)</SelectItem>
                  <SelectItem value='asset' disabled>夹具资产 (asset)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {file && file.source === 'context' ? (
              <div className='space-y-1.5'>
                <Label htmlFor={`step-upload-from-${step.id}`}>引用前序变量 (from)</Label>
                <Input
                  id={`step-upload-from-${step.id}`}
                  placeholder='例如: downloadedTemplate'
                  value={file.from}
                  disabled={disabled}
                  onChange={(e) => {
                    const nextFrom = e.target.value.trim()
                    onChange({
                      ...step,
                      input: {
                        ...step.input,
                        files: [
                          {
                            ...file,
                            from: nextFrom,
                          },
                        ],
                      },
                    })
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  if (step.type === 'probe') {
    const probeInput = step.input
    return (
      <div className='space-y-4'>
        <div className='space-y-2'>
          <div className='flex items-center gap-1.5'>
            <Label>检查目标类型</Label>
            <FieldHelp label='检查目标类型'>
              探测步骤用于在执行分支判断或前置确认时，轻量检测页面元素、包含文本或 URL 地址是否符合预期。
            </FieldHelp>
          </div>
          <Select
            value={probeInput.kind}
            disabled={disabled}
            onValueChange={(val: 'element' | 'text' | 'url') => {
              if (val === 'element') {
                onChange({
                  ...step,
                  input: {
                    kind: 'element',
                    target: defaultTarget('目标元素'),
                    state: 'visible',
                    waitMs: 2000,
                  },
                })
              } else if (val === 'text') {
                onChange({
                  ...step,
                  input: {
                    kind: 'text',
                    text: '',
                    waitMs: 2000,
                  },
                })
              } else {
                onChange({
                  ...step,
                  input: {
                    kind: 'url',
                    urlPattern: '',
                    waitMs: 2000,
                  },
                })
              }
            }}
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='element'>页面元素是否存在或可见</SelectItem>
              <SelectItem value='text'>页面或目标内包含文本</SelectItem>
              <SelectItem value='url'>当前页面 URL 匹配模式</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {probeInput.kind === 'element' && (
          <div className='space-y-3'>
            <TargetFields
              {...policyHandlers(step, onChange)}
              target={probeInput.target}
              disabled={disabled}
              onChange={(target) =>
                onChange({ ...step, input: { ...probeInput, target } })
              }
            />
            <div className='space-y-1.5'>
              <Label>期望状态</Label>
              <Select
                value={probeInput.state ?? 'visible'}
                disabled={disabled}
                onValueChange={(val: 'visible' | 'present') =>
                  onChange({ ...step, input: { ...probeInput, state: val } })
                }
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='visible'>可见 (Visible)</SelectItem>
                  <SelectItem value='present'>DOM 存在即可 (Present)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {probeInput.kind === 'text' && (
          <div className='space-y-2'>
            <Label htmlFor={`step-probe-text-${step.id}`}>待检查文本</Label>
            <Input
              id={`step-probe-text-${step.id}`}
              placeholder='输入页面中需要检查的文本关键字'
              value={probeInput.text}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...step, input: { ...probeInput, text: e.target.value } })
              }
            />
          </div>
        )}

        {probeInput.kind === 'url' && (
          <div className='space-y-2'>
            <Label htmlFor={`step-probe-url-${step.id}`}>URL 匹配规则 / 正则</Label>
            <Input
              id={`step-probe-url-${step.id}`}
              placeholder='如: /dashboard 或 https://example.com/.*'
              value={probeInput.urlPattern}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...step, input: { ...probeInput, urlPattern: e.target.value } })
              }
            />
          </div>
        )}

        <div className='space-y-1.5'>
          <div className='flex items-center gap-1.5'>
            <Label htmlFor={`step-probe-wait-${step.id}`}>最长等待时间（毫秒）</Label>
            <FieldHelp label='最长等待时间'>
              探测检查的最长等待超时时间，最大不超过 5000ms。
            </FieldHelp>
          </div>
          <Input
            id={`step-probe-wait-${step.id}`}
            type='number'
            min={0}
            max={5000}
            placeholder='2000'
            value={probeInput.waitMs ?? 2000}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...step,
                input: { ...probeInput, waitMs: Math.min(5000, Number(e.target.value)) },
              })
            }
          />
        </div>
      </div>
    )
  }

  if (step.type === 'compute') {
    const expr = step.input.expression
    return (
      <div className='space-y-4'>
        <div className='space-y-2'>
          <div className='flex items-center gap-1.5'>
            <Label htmlFor={`step-compute-out-${step.id}`}>输出变量名</Label>
            <FieldHelp label='输出变量名'>
              计算步骤执行后的结果将存储于该变量中，供后续步骤或断言引用。
            </FieldHelp>
          </div>
          <Input
            id={`step-compute-out-${step.id}`}
            placeholder='例如: computedResult'
            value={step.outputKey ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...step, outputKey: e.target.value.trim() })
            }
          />
        </div>

        <div className='space-y-2'>
          <Label>表达式类型</Label>
          <Select
            value={expr.kind}
            disabled={disabled}
            onValueChange={(val) => {
              if (val === 'literal') {
                onChange({
                  ...step,
                  input: { expression: { kind: 'literal', value: '' } },
                })
              } else if (val === 'ref') {
                onChange({
                  ...step,
                  input: { expression: { kind: 'ref', key: bindings[0]?.key ?? 'var' } },
                })
              } else if (val === 'call') {
                onChange({
                  ...step,
                  input: {
                    expression: {
                      kind: 'call',
                      fn: 'concat',
                      args: [{ kind: 'literal', value: '' }],
                    },
                  },
                })
              }
            }}
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='literal'>字面量常数 (Literal)</SelectItem>
              <SelectItem value='ref'>上下文变量引用 (Ref)</SelectItem>
              <SelectItem value='call'>内置函数调用 (Call)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {expr.kind === 'literal' && (
          <div className='space-y-1.5'>
            <Label htmlFor={`step-compute-literal-${step.id}`}>常数值</Label>
            <Input
              id={`step-compute-literal-${step.id}`}
              placeholder='输入计算字面量'
              value={String(expr.value ?? '')}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...step,
                  input: { expression: { kind: 'literal', value: e.target.value } },
                })
              }
            />
          </div>
        )}

        {expr.kind === 'ref' && (
          <div className='space-y-1.5'>
            <Label htmlFor={`step-compute-ref-${step.id}`}>引用变量键 (key)</Label>
            <Input
              id={`step-compute-ref-${step.id}`}
              placeholder='例如: extractedText'
              value={expr.key}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...step,
                  input: { expression: { kind: 'ref', key: e.target.value } },
                })
              }
            />
          </div>
        )}

        {expr.kind === 'call' && (
          <div className='space-y-3'>
            <div className='space-y-1.5'>
              <Label>函数名 (fn)</Label>
              <Select
                value={expr.fn}
                disabled={disabled}
                onValueChange={(value) => {
                  const fnVal = EXPR_FUNCTIONS.find((fn) => fn === value)
                  if (!fnVal) return
                  onChange({
                    ...step,
                    input: { expression: { ...expr, fn: fnVal } },
                  })
                }}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='concat'>concat(拼接字符串)</SelectItem>
                  <SelectItem value='trim'>trim(去除首尾空格)</SelectItem>
                  <SelectItem value='lower'>lower(转小写)</SelectItem>
                  <SelectItem value='upper'>upper(转大写)</SelectItem>
                  <SelectItem value='toNumber'>toNumber(转换为数字)</SelectItem>
                  <SelectItem value='extractNumber'>extractNumber(提取数字)</SelectItem>
                  <SelectItem value='round'>round(四舍五入)</SelectItem>
                  <SelectItem value='abs'>abs(绝对值)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
    )
  }

  return null
}
