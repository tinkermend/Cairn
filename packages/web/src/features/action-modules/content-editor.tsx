import { useState, type ReactNode } from 'react'
import {
  MAX_MODULE_IMPLEMENTATIONS,
  MAX_SCENARIO_STEPS,
  scenarioDefinitionFromSteps,
  type CompileDiagnostic,
  type ExecutableStepType,
  type ModuleCondition,
  type ModuleContent,
} from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Bot,
  CheckCircle2,
  Clock,
  Globe,
  Layers,
  MousePointer,
  Plus,
  Sparkles,
  TextCursorInput,
  Trash2,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  createBlankStep,
  priorBindings,
  priorOutputShapes,
  StepEditor,
  STEP_TYPE_LABELS,
} from '@/features/authoring'
import { MODULE_EFFECT_CEILING_LABELS } from './labels'
import { ScopeVariablesBar } from './scope-variables-bar'

const sections = [
  'preconditions',
  'postconditions',
  'entryState',
  'exitState',
] as const
const sectionNames = {
  preconditions: '前置条件',
  postconditions: '后置条件',
  entryState: '入口状态',
  exitState: '结束状态',
}

function stepTypeIcon(type: ExecutableStepType) {
  switch (type) {
    case 'navigate':
      return Globe
    case 'click':
      return MousePointer
    case 'fill':
    case 'keyboard':
      return TextCursorInput
    case 'assert':
      return CheckCircle2
    case 'ai_action':
      return Bot
    case 'ai_assert':
    case 'ai_extract':
      return Sparkles
    case 'wait':
    case 'delay':
      return Clock
    default:
      return Layers
  }
}

export function ModuleContentEditor({
  content,
  onChange,
  disabled = false,
  types,
  diagnostics,
  implementationsQuality,
  metaSlot,
  rightBottomSlot,
}: {
  content: ModuleContent
  onChange: (content: ModuleContent) => void
  disabled?: boolean
  types: readonly ExecutableStepType[]
  diagnostics: CompileDiagnostic[]
  implementationsQuality?: readonly {
    implementationKey: string
    lastVerifiedAt?: string | null
    verifiedRate?: number | null
    calls?: number
  }[]
  metaSlot?: ReactNode
  rightBottomSlot?: ReactNode
}) {
  const [selected, setSelected] = useState(0)
  const [implIndex, setImplIndex] = useState(0)
  const [addType, setAddType] = useState<ExecutableStepType>('assert')
  const safeImplIndex = Math.min(
    implIndex,
    Math.max(0, content.implementations.length - 1)
  )
  const impl = content.implementations[safeImplIndex]!
  const { contract } = content
  const index = Math.min(selected, Math.max(0, impl.steps.length - 1))
  const step = impl.steps[index]
  const document = scenarioDefinitionFromSteps(
    impl.steps,
    contract.inputs.map(({ key, label }) => ({ key, label }))
  )
  const updateContract = (patch: Partial<ModuleContent['contract']>) =>
    onChange({ ...content, contract: { ...contract, ...patch } })
  const updateImpl = (patch: Partial<typeof impl>) =>
    onChange({
      ...content,
      implementations: content.implementations.map((item, i) =>
        i === safeImplIndex ? { ...item, ...patch } : item
      ),
    })
  const nextImplementationKey = () => {
    const used = new Set(
      content.implementations.map((item) => item.implementationKey)
    )
    if (!used.has('alt')) return 'alt'
    let n = 2
    while (used.has(`alt${n}`)) n += 1
    return `alt${n}`
  }
  const setConditions = (
    section: (typeof sections)[number],
    values: ModuleCondition[]
  ) => {
    let nextImplementations = content.implementations
    if (
      section === 'postconditions' &&
      values.length < contract.postconditions.length
    ) {
      nextImplementations = content.implementations.map((item) => {
        if (!item.postconditionBindings) return item
        const kept = values.map((val) => {
          const oldIndex = contract.postconditions.findIndex(
            (orig) => orig === val
          )
          return oldIndex >= 0 && item.postconditionBindings?.[oldIndex]
            ? item.postconditionBindings[oldIndex]!
            : val.verification
        })
        return { ...item, postconditionBindings: kept }
      })
    }
    if (
      section === 'preconditions' &&
      values.length < contract.preconditions.length
    ) {
      nextImplementations = content.implementations.map((item) => {
        if (!item.preconditionBindings) return item
        const kept = values.map((val) => {
          const oldIndex = contract.preconditions.findIndex(
            (orig) => orig === val
          )
          return oldIndex >= 0 && item.preconditionBindings?.[oldIndex]
            ? item.preconditionBindings[oldIndex]!
            : val.verification
        })
        return { ...item, preconditionBindings: kept }
      })
    }
    onChange({
      ...content,
      contract: {
        ...contract,
        [section]:
          section === 'entryState' || section === 'exitState'
            ? values[0]
            : values,
      },
      implementations: nextImplementations,
    })
  }
  return (
    <div className='grid items-start gap-6 lg:grid-cols-12'>
      {/* 左侧：契约与配置 (~42% 宽度，lg:col-span-5) */}
      <div className='min-w-0 space-y-6 lg:col-span-5'>
        {metaSlot}

        <section className='space-y-4 rounded-xl border bg-card p-4'>
          <h2 className='text-section font-semibold'>输入输出与副作用</h2>
          <label className='flex flex-wrap items-center gap-3 text-body'>
            <span className='font-medium'>
              副作用上限{' '}
              <span className='text-destructive' aria-hidden='true'>
                *
              </span>
            </span>
            <Select
              value={contract.effectCeiling}
              disabled={disabled}
              onValueChange={(val) =>
                updateContract({
                  effectCeiling: val as typeof contract.effectCeiling,
                })
              }
            >
              <SelectTrigger className='w-44' aria-label='副作用上限'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(MODULE_EFFECT_CEILING_LABELS).map(
                  ([value, name]) => (
                    <SelectItem key={value} value={value}>
                      {name}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </label>
          <div className='flex items-center justify-between gap-2'>
            <div>
              <h3 className='flex items-center gap-1.5 text-body font-medium'>
                输入声明
                <span className='text-label font-normal text-muted-foreground'>
                  ({contract.inputs.length}/32)
                </span>
              </h3>
              <p className='text-label text-muted-foreground'>
                向模块传入外部参数，可在实现步骤中引用。
              </p>
            </div>
            {!disabled && (
              <Button
                variant='outline'
                size='sm'
                disabled={contract.inputs.length >= 32}
                onClick={() =>
                  updateContract({
                    inputs: [
                      ...contract.inputs,
                      {
                        key: '',
                        label: '',
                        valueType: 'string',
                        required: true,
                      },
                    ],
                  })
                }
              >
                <Plus className='mr-1.5 size-3.5' />
                添加输入
              </Button>
            )}
          </div>
          {contract.inputs.length === 0 ? (
            <div className='rounded-lg border border-dashed p-4 text-center text-small text-muted-foreground'>
              暂无输入参数。若该模块无需接收外部参数，可留空。
            </div>
          ) : (
            <div className='overflow-x-auto rounded-lg border bg-card/60'>
              <table className='w-full min-w-[34rem] text-left text-small'>
                <thead>
                  <tr className='border-b bg-muted/40 text-label text-muted-foreground'>
                    <th className='p-2.5 font-medium'>
                      Key <span className='text-destructive'>*</span>
                    </th>
                    <th className='p-2.5 font-medium'>
                      名称 <span className='text-destructive'>*</span>
                    </th>
                    <th className='p-2.5 font-medium'>
                      类型 <span className='text-destructive'>*</span>
                    </th>
                    <th className='p-2.5 text-center font-medium'>必填</th>
                    <th className='p-2.5 font-medium'>说明</th>
                    {!disabled && (
                      <th className='w-12 p-2.5 text-center font-medium'>操作</th>
                    )}
                  </tr>
                </thead>
                <tbody className='divide-y'>
                  {contract.inputs.map((input, i) => (
                    <tr key={i} className='hover:bg-muted/20'>
                      <td className='p-2'>
                        <Input
                          aria-label={`输入 ${i + 1} Key`}
                          placeholder='例如：orderNo'
                          value={input.key}
                          disabled={disabled}
                          className='h-8 font-mono text-small'
                          onChange={(e) =>
                            updateContract({
                              inputs: contract.inputs.map((v, n) =>
                                n === i ? { ...v, key: e.target.value } : v
                              ),
                            })
                          }
                        />
                      </td>
                      <td className='p-2'>
                        <Input
                          aria-label={`输入 ${i + 1} 名称`}
                          placeholder='例如：订单号'
                          value={input.label}
                          disabled={disabled}
                          className='h-8 text-small'
                          onChange={(e) =>
                            updateContract({
                              inputs: contract.inputs.map((v, n) =>
                                n === i ? { ...v, label: e.target.value } : v
                              ),
                            })
                          }
                        />
                      </td>
                      <td className='p-2'>
                        <Select
                          value={input.valueType}
                          disabled={disabled}
                          onValueChange={(val) =>
                            updateContract({
                              inputs: contract.inputs.map((v, n) =>
                                n === i
                                  ? {
                                      ...v,
                                      valueType: val as typeof v.valueType,
                                    }
                                  : v
                              ),
                            })
                          }
                        >
                          <SelectTrigger
                            className='h-8 w-24 text-small'
                            aria-label={`输入 ${i + 1} 类型`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['string', 'number', 'boolean', 'json'].map(
                              (t) => (
                                <SelectItem key={t} value={t}>
                                  {t}
                                </SelectItem>
                              )
                            )}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className='p-2 text-center'>
                        <input
                          type='checkbox'
                          aria-label={`输入 ${i + 1} 必填`}
                          checked={input.required}
                          disabled={disabled}
                          className='h-4 w-4 rounded border-border align-middle'
                          onChange={(e) =>
                            updateContract({
                              inputs: contract.inputs.map((v, n) =>
                                n === i ? { ...v, required: e.target.checked } : v
                              ),
                            })
                          }
                        />
                      </td>
                      <td className='p-2'>
                        <Input
                          placeholder='可选用途说明'
                          value={input.description ?? ''}
                          disabled={disabled}
                          className='h-8 text-small'
                          onChange={(e) =>
                            updateContract({
                              inputs: contract.inputs.map((v, n) =>
                                n === i
                                  ? { ...v, description: e.target.value }
                                  : v
                              ),
                            })
                          }
                        />
                      </td>
                      {!disabled && (
                        <td className='p-2 text-center'>
                          <Button
                            size='icon'
                            variant='ghost'
                            className='h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                            title={`删除输入 ${i + 1}`}
                            aria-label={`删除输入 ${i + 1}`}
                            onClick={() =>
                              updateContract({
                                inputs: contract.inputs.filter(
                                  (_, n) => n !== i
                                ),
                              })
                            }
                          >
                            <Trash2 className='h-4 w-4' />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className='flex items-center justify-between gap-2'>
            <div>
              <h3 className='flex items-center gap-1.5 text-body font-medium'>
                输出声明与映射
                <span className='text-label font-normal text-muted-foreground'>
                  ({contract.outputs.length}/32)
                </span>
              </h3>
              <p className='text-label text-muted-foreground'>
                定义模块对外输出字段，并映射至实现中步骤的 outputKey。
              </p>
            </div>
            {!disabled && (
              <Button
                size='sm'
                variant='outline'
                disabled={contract.outputs.length >= 32}
                onClick={() =>
                  updateContract({
                    outputs: [
                      ...contract.outputs,
                      {
                        key: '',
                        label: '',
                        shape: { kind: 'scalar', type: 'string' },
                      },
                    ],
                  })
                }
              >
                <Plus className='mr-1.5 size-3.5' />
                添加输出
              </Button>
            )}
          </div>
          {contract.outputs.length === 0 ? (
            <div className='rounded-lg border border-dashed p-4 text-center text-small text-muted-foreground'>
              暂无输出声明。如需向场景传递执行结果，请点击「添加输出」。
            </div>
          ) : (
            <div className='space-y-3'>
              {contract.outputs.map((output, i) => (
                <div
                  key={i}
                  className='rounded-lg border bg-card/60 p-3.5 space-y-3 shadow-card'
                >
                  <div className='flex items-center justify-between border-b pb-2 text-small'>
                    <div className='flex items-center gap-2 min-w-0'>
                      <span className='font-semibold text-foreground shrink-0'>
                        输出 #{i + 1}
                      </span>
                      {output.key ? (
                        <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-label text-muted-foreground truncate max-w-[180px]'>
                          {output.key}
                        </code>
                      ) : null}
                    </div>
                    {!disabled && (
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0'
                        title={`删除输出 ${i + 1}`}
                        aria-label={`删除输出 ${i + 1}`}
                        onClick={() => {
                          const delKey = output.key
                          const nextImplementations =
                            content.implementations.map((item) => {
                              const outputMapping = { ...item.outputMapping }
                              delete outputMapping[delKey]
                              return { ...item, outputMapping }
                            })
                          onChange({
                            ...content,
                            contract: {
                              ...contract,
                              outputs: contract.outputs.filter(
                                (_, n) => n !== i
                              ),
                            },
                            implementations: nextImplementations,
                          })
                        }}
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </Button>
                    )}
                  </div>

                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <div className='min-w-0'>
                      <label className='block space-y-1 text-label font-medium text-muted-foreground'>
                        Key <span className='text-destructive'>*</span>
                      </label>
                      <Input
                        aria-label={`输出 ${i + 1} Key`}
                        placeholder='例如：result'
                        value={output.key}
                        disabled={disabled}
                        className='h-8 w-full font-mono text-small'
                        onChange={(e) => {
                          const oldKey = output.key
                          const newKey = e.target.value
                          const nextImplementations =
                            content.implementations.map((item) => {
                              const outputMapping = { ...item.outputMapping }
                              if (
                                Object.prototype.hasOwnProperty.call(
                                  outputMapping,
                                  oldKey
                                )
                              ) {
                                const value = outputMapping[oldKey]!
                                delete outputMapping[oldKey]
                                outputMapping[newKey] = value
                              }
                              return { ...item, outputMapping }
                            })
                          onChange({
                            ...content,
                            contract: {
                              ...contract,
                              outputs: contract.outputs.map((v, n) =>
                                n === i ? { ...v, key: newKey } : v
                              ),
                            },
                            implementations: nextImplementations,
                          })
                        }}
                      />
                    </div>
                    <div className='min-w-0'>
                      <label className='block space-y-1 text-label font-medium text-muted-foreground'>
                        名称 <span className='text-destructive'>*</span>
                      </label>
                      <Input
                        aria-label={`输出 ${i + 1} 名称`}
                        placeholder='例如：处理结果'
                        value={output.label}
                        disabled={disabled}
                        className='h-8 w-full text-small'
                        onChange={(e) =>
                          updateContract({
                            outputs: contract.outputs.map((v, n) =>
                              n === i ? { ...v, label: e.target.value } : v
                            ),
                          })
                        }
                      />
                    </div>
                    <div className='min-w-0'>
                      <label className='block space-y-1 text-label font-medium text-muted-foreground'>
                        形态 <span className='text-destructive'>*</span>
                      </label>
                      <Select
                        value={
                          output.shape.kind === 'scalar'
                            ? output.shape.type
                            : output.shape.kind
                        }
                        disabled={disabled}
                        onValueChange={(val) =>
                          updateContract({
                            outputs: contract.outputs.map((v, n) =>
                              n !== i
                                ? v
                                : {
                                    ...v,
                                    shape:
                                      val === 'unknown'
                                        ? { kind: 'unknown' }
                                        : val === 'object'
                                          ? {
                                              kind: 'object',
                                              fields: [
                                                {
                                                  name: 'value',
                                                  type: 'string',
                                                  required: true,
                                                },
                                              ],
                                            }
                                          : {
                                              kind: 'scalar',
                                              type: val as
                                                | 'string'
                                                | 'number'
                                                | 'boolean'
                                                | 'json',
                                            },
                                  }
                            ),
                          })
                        }
                      >
                        <SelectTrigger
                          className='h-8 w-full text-small'
                          aria-label={`输出 ${i + 1} 类型`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[
                            'string',
                            'number',
                            'boolean',
                            'json',
                            'object',
                            'unknown',
                          ].map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='min-w-0'>
                      <label className='block space-y-1 text-label font-medium text-muted-foreground'>
                        实现映射 <span className='text-destructive'>*</span>
                      </label>
                      <Select
                        value={impl.outputMapping[output.key] || '__empty__'}
                        disabled={disabled}
                        onValueChange={(val) =>
                          updateImpl({
                            outputMapping: {
                              ...impl.outputMapping,
                              [output.key]: val === '__empty__' ? '' : val,
                            },
                          })
                        }
                      >
                        <SelectTrigger
                          className='h-8 w-full text-small min-w-0 truncate'
                          aria-label={`输出 ${i + 1} 映射`}
                        >
                          <span className='truncate block w-full text-left'>
                            <SelectValue placeholder='选择步骤 outputKey' />
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='__empty__'>未映射（空）</SelectItem>
                          {impl.steps
                            .filter((s) => s.outputKey)
                            .map((s) => (
                              <SelectItem key={s.id} value={s.outputKey!}>
                                <span className='font-mono font-medium'>{s.outputKey}</span>
                                <span className='text-muted-foreground ml-1.5'>· {s.name}</span>
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className='min-w-0'>
                    <label className='block space-y-1 text-label font-medium text-muted-foreground'>
                      说明描述（可选）
                    </label>
                    <Input
                      placeholder='输出用途或业务含义说明（可选）'
                      value={output.description ?? ''}
                      disabled={disabled}
                      className='h-8 w-full text-small'
                      onChange={(e) =>
                        updateContract({
                          outputs: contract.outputs.map((v, n) =>
                            n === i ? { ...v, description: e.target.value } : v
                          ),
                        })
                      }
                    />
                  </div>

                  {output.shape.kind === 'object' && (
                    <div className='space-y-2 rounded border bg-muted/20 p-2.5'>
                      <div className='flex items-center justify-between text-label font-medium text-muted-foreground'>
                        <span>嵌套字段结构 ({output.shape.fields.length})</span>
                        {!disabled && (
                          <Button
                            size='sm'
                            variant='outline'
                            className='h-7 text-label'
                            disabled={output.shape.fields.length >= 32}
                            onClick={() =>
                              updateContract({
                                outputs: contract.outputs.map((v, k) =>
                                  k !== i || v.shape.kind !== 'object'
                                    ? v
                                    : {
                                        ...v,
                                        shape: {
                                          ...v.shape,
                                          fields: [
                                            ...v.shape.fields,
                                            {
                                              name: '',
                                              type: 'string',
                                              required: true,
                                            },
                                          ],
                                        },
                                      }
                                ),
                              })
                            }
                          >
                            <Plus className='mr-1 size-3' />
                            添加字段
                          </Button>
                        )}
                      </div>
                      {output.shape.fields.map((field, n) => (
                        <div
                          key={n}
                          className='flex flex-wrap items-center gap-2'
                        >
                          <Input
                            className='h-7 w-36 font-mono text-small'
                            aria-label={`输出 ${i + 1} 字段 ${n + 1}`}
                            placeholder='字段名'
                            value={field.name}
                            disabled={disabled}
                            onChange={(e) =>
                              updateContract({
                                outputs: contract.outputs.map((v, k) =>
                                  k !== i || v.shape.kind !== 'object'
                                    ? v
                                    : {
                                        ...v,
                                        shape: {
                                          ...v.shape,
                                          fields: v.shape.fields.map((f, j) =>
                                            j === n
                                              ? { ...f, name: e.target.value }
                                              : f
                                          ),
                                        },
                                      }
                                ),
                              })
                            }
                          />
                          <Select
                            value={field.type}
                            disabled={disabled}
                            onValueChange={(val) =>
                              updateContract({
                                outputs: contract.outputs.map((v, k) =>
                                  k !== i || v.shape.kind !== 'object'
                                    ? v
                                    : {
                                        ...v,
                                        shape: {
                                          ...v.shape,
                                          fields: v.shape.fields.map((f, j) =>
                                            j === n
                                              ? {
                                                  ...f,
                                                  type: val as typeof f.type,
                                                }
                                              : f
                                          ),
                                        },
                                      }
                                ),
                              })
                            }
                          >
                            <SelectTrigger
                              className='h-7 w-24 text-label'
                              aria-label={`输出 ${i + 1} 字段 ${n + 1} 类型`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {['string', 'number', 'boolean'].map((t) => (
                                <SelectItem key={t} value={t}>
                                  {t}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <label className='flex items-center gap-1 text-label'>
                            <input
                              type='checkbox'
                              checked={field.required}
                              disabled={disabled}
                              className='h-3.5 w-3.5 rounded'
                              onChange={(e) =>
                                updateContract({
                                  outputs: contract.outputs.map((v, k) =>
                                    k !== i || v.shape.kind !== 'object'
                                      ? v
                                      : {
                                          ...v,
                                          shape: {
                                            ...v.shape,
                                            fields: v.shape.fields.map((f, j) =>
                                              j === n
                                                ? {
                                                    ...f,
                                                    required: e.target.checked,
                                                  }
                                                : f
                                            ),
                                          },
                                        }
                                  ),
                                })
                              }
                            />
                            必填
                          </label>
                          {!disabled && (
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-7 px-2 text-label text-muted-foreground hover:text-destructive'
                              onClick={() =>
                                updateContract({
                                  outputs: contract.outputs.map((v, k) =>
                                    k !== i || v.shape.kind !== 'object'
                                      ? v
                                      : {
                                          ...v,
                                          shape: {
                                            ...v.shape,
                                            fields: v.shape.fields.filter(
                                              (_, j) => j !== n
                                            ),
                                          },
                                        }
                                  ),
                                })
                              }
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className='space-y-4 rounded-xl border bg-card p-4'>
          <div className='flex items-center justify-between gap-2'>
            <h2 className='flex items-center gap-1.5 text-section font-semibold'>
              条件与起止状态
              <span className='text-label font-normal text-muted-foreground'>
                (可选约束)
              </span>
            </h2>
          </div>
          <p className='text-body text-muted-foreground'>
            声明描述验证方式；静态编译通过不表示条件已经执行验证。与输入相关的动态判据当前需保留为人工说明。
          </p>
          {sections.map((section) => {
            const value = contract[section]
            const conditions = !value
              ? []
              : Array.isArray(value)
                ? value
                : [value]
            const limit =
              section === 'entryState' || section === 'exitState' ? 1 : 16
            return (
              <div key={section} className='space-y-3'>
                <div className='flex items-center justify-between gap-2'>
                  <h3 className='text-body font-medium'>
                    {sectionNames[section]}
                  </h3>
                  {!disabled && (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={conditions.length >= limit}
                      onClick={() =>
                        setConditions(section, [
                          ...conditions,
                          {
                            meaning: '',
                            verification: { kind: 'manual_requirement' },
                          },
                        ])
                      }
                    >
                      添加{sectionNames[section]}
                    </Button>
                  )}
                </div>
                {conditions.map((condition, i) => {
                  const update = (patch: Partial<ModuleCondition>) =>
                    setConditions(
                      section,
                      conditions.map((c, n) =>
                        n === i ? { ...c, ...patch } : c
                      )
                    )
                  return (
                    <div
                      key={i}
                      className='grid gap-3 rounded-md border p-3 sm:grid-cols-2'
                    >
                      <label className='block space-y-1 text-body sm:col-span-2'>
                        <span className='flex items-center gap-1 font-medium'>
                          业务含义{' '}
                          <span className='text-destructive' aria-hidden='true'>
                            *
                          </span>
                        </span>
                        <Textarea
                          aria-label={`${sectionNames[section]} ${i + 1} 含义`}
                          placeholder='例如：执行前需处于系统已登录状态'
                          disabled={disabled}
                          value={condition.meaning}
                          onChange={(e) => update({ meaning: e.target.value })}
                        />
                      </label>
                      <Select
                        value={condition.verification.kind}
                        disabled={disabled}
                        onValueChange={(val) =>
                          update({
                            verification:
                              val === 'step'
                                ? { kind: 'step', stepId: '' }
                                : val === 'output_required'
                                  ? { kind: 'output_required', outputKey: '' }
                                  : { kind: 'manual_requirement' },
                          })
                        }
                      >
                        <SelectTrigger
                          className='w-full'
                          aria-label={`${sectionNames[section]} ${i + 1} 验证方式`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='manual_requirement'>
                            人工说明，未自动验证
                          </SelectItem>
                          <SelectItem value='step'>断言步骤</SelectItem>
                          <SelectItem value='output_required'>
                            必需输出
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {condition.verification.kind === 'step' && (
                        <Select
                          value={condition.verification.stepId || '__empty__'}
                          disabled={disabled}
                          onValueChange={(val) =>
                            update({
                              verification: {
                                kind: 'step',
                                stepId: val === '__empty__' ? '' : val,
                              },
                            })
                          }
                        >
                          <SelectTrigger
                            className='w-full'
                            aria-label={`${sectionNames[section]} ${i + 1} 断言步骤`}
                          >
                            <SelectValue placeholder='选择断言' />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='__empty__'>选择断言</SelectItem>
                            {impl.steps
                              .filter(
                                (s) =>
                                  s.type === 'assert' || s.type === 'ai_assert'
                              )
                              .map((s) => (
                                <SelectItem key={s.id} value={s.id}>
                                  {s.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      )}
                      {condition.verification.kind === 'output_required' && (
                        <Select
                          value={
                            condition.verification.outputKey || '__empty__'
                          }
                          disabled={disabled}
                          onValueChange={(val) =>
                            update({
                              verification: {
                                kind: 'output_required',
                                outputKey: val === '__empty__' ? '' : val,
                              },
                            })
                          }
                        >
                          <SelectTrigger
                            className='w-full'
                            aria-label={`${sectionNames[section]} ${i + 1} 输出`}
                          >
                            <SelectValue placeholder='选择输出' />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='__empty__'>选择输出</SelectItem>
                            {contract.outputs
                              .filter((o) => o.key)
                              .map((o) => (
                                <SelectItem key={o.key} value={o.key}>
                                  {o.label} ({o.key})
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      )}
                      {condition.verification.kind === 'manual_requirement' && (
                        <Badge variant='outline'>人工说明，未自动验证</Badge>
                      )}
                      {!disabled && (
                        <Button
                          variant='ghost'
                          size='sm'
                          onClick={() =>
                            setConditions(
                              section,
                              conditions.filter((_, n) => n !== i)
                            )
                          }
                        >
                          删除{sectionNames[section]} {i + 1}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </section>
      </div>

      {/* 右侧：核心步骤工作台 (~58% 宽度，lg:col-span-7) */}
      <div className='min-w-0 space-y-6 lg:col-span-7'>
        <section className='space-y-4 rounded-xl border bg-card p-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='flex items-center gap-2'>
              <h2 className='flex items-center gap-1.5 text-section font-semibold'>
                步骤编排
                <span className='text-destructive' aria-hidden='true'>
                  *
                </span>
              </h2>
              <span className='text-label text-muted-foreground'>
                ({impl.steps.length} 步骤 · {impl.implementationKey})
              </span>
            </div>
            {!disabled &&
            content.implementations.length < MAX_MODULE_IMPLEMENTATIONS ? (
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  onChange({
                    ...content,
                    implementations: [
                      ...content.implementations,
                      {
                        implementationKey: nextImplementationKey(),
                        kind: 'structured_steps',
                        steps: [],
                        outputMapping: {},
                      },
                    ],
                  })
                  setImplIndex(content.implementations.length)
                  setSelected(0)
                }}
              >
                添加实现
              </Button>
            ) : null}
          </div>
          <div className='flex flex-wrap gap-2'>
            {content.implementations.map((item, i) => (
              <Button
                key={item.implementationKey}
                type='button'
                size='sm'
                variant={i === safeImplIndex ? 'secondary' : 'outline'}
                onClick={() => {
                  setImplIndex(i)
                  setSelected(0)
                }}
              >
                {item.implementationKey}
              </Button>
            ))}
          </div>
          <label className='space-y-1 text-body'>
            实现 key
            <Input
              aria-label='实现 key'
              value={impl.implementationKey}
              disabled={disabled}
              onChange={(e) =>
                updateImpl({ implementationKey: e.target.value })
              }
            />
          </label>
          {(() => {
            const stats = implementationsQuality?.find(
              (q) => q.implementationKey === impl.implementationKey
            )
            if (!stats) return null
            return (
              <p className='text-small text-muted-foreground'>
                {stats.lastVerifiedAt
                  ? `最近验证试跑：${new Date(stats.lastVerifiedAt).toLocaleString()}${stats.verifiedRate !== null && stats.verifiedRate !== undefined ? `（通过率 ${(stats.verifiedRate * 100).toFixed(0)}%）` : ''}`
                  : '该实现尚未有已验证的试跑记录'}
              </p>
            )
          })()}
          {contract.postconditions.length > 0 ? (
            <div className='space-y-3 rounded-lg border bg-muted/20 p-3'>
              <div className='space-y-1'>
                <h3 className='text-body font-medium'>后置条件映射</h3>
                <p className='text-small text-muted-foreground'>
                  为当前实现指定后置条件的断言步骤映射。
                </p>
              </div>
              {contract.postconditions.map((postcondition, i) => {
                const currentBinding =
                  impl.postconditionBindings?.[i] ?? postcondition.verification
                const assertSteps = impl.steps.filter(
                  (s) => s.type === 'assert' || s.type === 'ai_assert'
                )
                return (
                  <div
                    key={i}
                    className='grid items-center gap-2 text-body sm:grid-cols-2'
                  >
                    <div>
                      <span className='font-medium'>
                        {postcondition.meaning}
                      </span>
                      <Badge variant='outline' className='ms-2 text-label'>
                        {postcondition.verification.kind === 'output_required'
                          ? '必需输出'
                          : postcondition.verification.kind ===
                              'manual_requirement'
                            ? '人工说明'
                            : '断言步骤'}
                      </Badge>
                    </div>
                    {postcondition.verification.kind === 'step' ? (
                      <Select
                        value={
                          currentBinding.kind === 'step' &&
                          currentBinding.stepId
                            ? currentBinding.stepId
                            : '__empty__'
                        }
                        disabled={disabled}
                        onValueChange={(val) => {
                          const newBindings = contract.postconditions.map(
                            (cond, idx) =>
                              idx === i
                                ? {
                                    kind: 'step' as const,
                                    stepId: val === '__empty__' ? '' : val,
                                  }
                                : (impl.postconditionBindings?.[idx] ??
                                  cond.verification)
                          )
                          updateImpl({ postconditionBindings: newBindings })
                        }}
                      >
                        <SelectTrigger
                          className='w-full'
                          aria-label={`后置条件 ${i + 1} 步骤映射`}
                        >
                          <SelectValue placeholder='选择断言步骤' />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='__empty__'>
                            选择断言步骤
                          </SelectItem>
                          {assertSteps.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : postcondition.verification.kind ===
                      'output_required' ? (
                      <span className='text-small text-muted-foreground'>
                        要求输出「{postcondition.verification.outputKey}」
                        {impl.outputMapping[
                          postcondition.verification.outputKey
                        ]
                          ? `（映射至 ${impl.outputMapping[postcondition.verification.outputKey]}）`
                          : '（未映射）'}
                      </span>
                    ) : (
                      <span className='text-small text-muted-foreground'>
                        人工说明，无需步骤映射
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
          {contract.preconditions.some(
            (p) => p.verification.kind === 'step'
          ) ? (
            <div className='space-y-3 rounded-lg border bg-muted/20 p-3'>
              <div className='space-y-1'>
                <h3 className='text-body font-medium'>前置条件映射</h3>
                <p className='text-small text-muted-foreground'>
                  为当前实现指定前置条件的断言步骤映射。
                </p>
              </div>
              {contract.preconditions.map((precondition, i) => {
                const currentBinding =
                  impl.preconditionBindings?.[i] ?? precondition.verification
                const assertSteps = impl.steps.filter(
                  (s) => s.type === 'assert' || s.type === 'ai_assert'
                )
                return (
                  <div
                    key={i}
                    className='grid items-center gap-2 text-body sm:grid-cols-2'
                  >
                    <div>
                      <span className='font-medium'>
                        {precondition.meaning}
                      </span>
                    </div>
                    {precondition.verification.kind === 'step' ? (
                      <Select
                        value={
                          currentBinding.kind === 'step' &&
                          currentBinding.stepId
                            ? currentBinding.stepId
                            : '__empty__'
                        }
                        disabled={disabled}
                        onValueChange={(val) => {
                          const newBindings = contract.preconditions.map(
                            (cond, idx) =>
                              idx === i
                                ? {
                                    kind: 'step' as const,
                                    stepId: val === '__empty__' ? '' : val,
                                  }
                                : (impl.preconditionBindings?.[idx] ??
                                  cond.verification)
                          )
                          updateImpl({ preconditionBindings: newBindings })
                        }}
                      >
                        <SelectTrigger
                          className='w-full'
                          aria-label={`前置条件 ${i + 1} 步骤映射`}
                        >
                          <SelectValue placeholder='选择断言步骤' />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='__empty__'>
                            选择断言步骤
                          </SelectItem>
                          {assertSteps.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className='text-small text-muted-foreground'>
                        非断言步骤，无需映射
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
          {content.implementations.length > 1 && !disabled ? (
            <Button
              variant='ghost'
              size='sm'
              disabled={content.implementations.length <= 1}
              onClick={() => {
                onChange({
                  ...content,
                  implementations: content.implementations.filter(
                    (_, i) => i !== safeImplIndex
                  ),
                })
                setImplIndex(0)
                setSelected(0)
              }}
            >
              删除当前实现
            </Button>
          ) : null}
        </section>
        <section className='space-y-4 rounded-xl border bg-card p-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <h2 className='text-section font-semibold'>
              实现步骤 · {impl.implementationKey} ({impl.steps.length}/
              {MAX_SCENARIO_STEPS})
            </h2>
            {!disabled && (
              <div className='flex flex-wrap gap-2'>
                <Select
                  value={types.includes(addType) ? addType : (types[0] ?? '')}
                  onValueChange={(val) => setAddType(val as ExecutableStepType)}
                >
                  <SelectTrigger className='w-32' aria-label='添加步骤类型'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {types.map((type) => (
                      <SelectItem key={type} value={type}>
                        {STEP_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant='outline'
                  disabled={
                    !types.length || impl.steps.length >= MAX_SCENARIO_STEPS
                  }
                  onClick={() => {
                    const next = createBlankStep(
                      types.includes(addType) ? addType : types[0]!,
                      [
                        ...contract.inputs.map((i) => i.key),
                        ...impl.steps.flatMap((s) =>
                          s.outputKey ? [s.outputKey] : []
                        ),
                      ]
                    )
                    updateImpl({ steps: [...impl.steps, next] })
                    setSelected(impl.steps.length)
                  }}
                >
                  添加步骤
                </Button>
              </div>
            )}
          </div>
          {!impl.steps.length ? (
            <p className='text-body text-muted-foreground'>
              暂无步骤，请添加实现。
            </p>
          ) : (
            <div className='grid min-w-0 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]'>
              <div className='space-y-2'>
                {impl.steps.map((s, i) => {
                  const StepIcon = stepTypeIcon(s.type)
                  const hasErrors = diagnostics.some(
                    (d) => d.stepId === s.id && d.severity === 'error'
                  )
                  const hasWarnings = diagnostics.some(
                    (d) => d.stepId === s.id && d.severity === 'warning'
                  )
                  return (
                    <Button
                      key={s.id}
                      variant={index === i ? 'secondary' : 'ghost'}
                      className='w-full justify-start gap-2 overflow-hidden px-2.5 py-2 text-left'
                      onClick={() => setSelected(i)}
                    >
                      <span className='flex size-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-label font-medium text-muted-foreground'>
                        {i + 1}
                      </span>
                      <StepIcon className='size-3.5 shrink-0 text-muted-foreground' />
                      <span className='truncate text-small font-medium'>
                        {s.name}
                      </span>
                      {s.outputKey && (
                        <span
                          className='ms-0.5 shrink-0 rounded bg-status-success-background px-1.5 py-0.5 font-mono text-label text-status-success-foreground'
                          title={`输出产物: ${s.outputKey}`}
                        >
                          → {s.outputKey}
                        </span>
                      )}
                      <div className='ms-auto flex shrink-0 items-center gap-1.5'>
                        {hasErrors && (
                          <span
                            className='size-2 rounded-full bg-destructive'
                            title='该步骤存在编译错误'
                          />
                        )}
                        {!hasErrors && hasWarnings && (
                          <span
                            className='size-2 rounded-full bg-status-warning-accent'
                            title='该步骤存在编译警告'
                          />
                        )}
                        <Badge
                          variant='outline'
                          className='shrink-0 text-label font-normal'
                        >
                          {STEP_TYPE_LABELS[s.type]}
                        </Badge>
                      </div>
                    </Button>
                  )
                })}
              </div>
              <div className='min-w-0 space-y-4'>
                {!disabled && (
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={index === 0}
                      onClick={() => {
                        const steps = [...impl.steps]
                        ;[steps[index - 1], steps[index]] = [
                          steps[index]!,
                          steps[index - 1]!,
                        ]
                        updateImpl({ steps })
                        setSelected(index - 1)
                      }}
                    >
                      上移
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={index === impl.steps.length - 1}
                      onClick={() => {
                        const steps = [...impl.steps]
                        ;[steps[index], steps[index + 1]] = [
                          steps[index + 1]!,
                          steps[index]!,
                        ]
                        updateImpl({ steps })
                        setSelected(index + 1)
                      }}
                    >
                      下移
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() =>
                        updateImpl({
                          steps: impl.steps.filter((_, i) => i !== index),
                        })
                      }
                    >
                      删除步骤
                    </Button>
                  </div>
                )}
                {step && (
                  <div className='space-y-4'>
                    <ScopeVariablesBar
                      inputs={contract.inputs}
                      priorSteps={impl.steps.slice(0, index)}
                    />
                    <StepEditor
                      step={step}
                      index={index}
                      bindings={priorBindings(document, index)}
                      shapes={priorOutputShapes(document, index)}
                      editableTypes={types}
                      diagnostics={diagnostics}
                      disabled={disabled}
                      onChange={(next) =>
                        updateImpl({
                          steps: impl.steps.map((s, i) =>
                            i === index ? next : s
                          ),
                        })
                      }
                      onRequestTypeChange={(type) => {
                        const replacement = {
                          ...createBlankStep(type),
                          id: step.id,
                        }
                        updateImpl({
                          steps: impl.steps.map((s, i) =>
                            i === index ? replacement : s
                          ),
                        })
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
        {rightBottomSlot}
      </div>
    </div>
  )
}
