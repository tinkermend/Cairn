import { useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { AuthoringObserveProvider } from '@/features/scenarios/authoring-observe'
import { StepEditor } from '@/features/scenarios/step-editor'
import {
  createBlankStep,
  STEP_TYPE_LABELS,
} from '@/features/scenarios/step-registry'
import {
  priorBindings,
  priorOutputShapes,
} from '@/features/scenarios/studio-document'
import { MODULE_EFFECT_CEILING_LABELS } from './labels'

const selectClass =
  'h-9 max-w-full rounded-md border border-input bg-background px-2 text-body'
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

export function ModuleContentEditor({
  content,
  onChange,
  disabled = false,
  types,
  diagnostics,
  implementationsQuality,
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
}) {
  const [selected, setSelected] = useState(0)
  const [implIndex, setImplIndex] = useState(0)
  const [addType, setAddType] = useState<ExecutableStepType>('assert')
  const safeImplIndex = Math.min(implIndex, Math.max(0, content.implementations.length - 1))
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
        i === safeImplIndex ? { ...item, ...patch } : item,
      ),
    })
  const nextImplementationKey = () => {
    const used = new Set(content.implementations.map((item) => item.implementationKey))
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
    if (section === 'postconditions' && values.length < contract.postconditions.length) {
      nextImplementations = content.implementations.map((item) => {
        if (!item.postconditionBindings) return item
        const kept = values.map((val) => {
          const oldIndex = contract.postconditions.findIndex((orig) => orig === val)
          return oldIndex >= 0 && item.postconditionBindings?.[oldIndex]
            ? item.postconditionBindings[oldIndex]!
            : val.verification
        })
        return { ...item, postconditionBindings: kept }
      })
    }
    if (section === 'preconditions' && values.length < contract.preconditions.length) {
      nextImplementations = content.implementations.map((item) => {
        if (!item.preconditionBindings) return item
        const kept = values.map((val) => {
          const oldIndex = contract.preconditions.findIndex((orig) => orig === val)
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
    <div className='space-y-6'>
      <section className='space-y-4 rounded-xl border bg-card p-4'>
        <h2 className='text-section font-semibold'>输入输出与副作用</h2>
        <label className='flex flex-wrap items-center gap-3 text-body'>
          副作用上限
          <select
            aria-label='副作用上限'
            className={selectClass}
            value={contract.effectCeiling}
            disabled={disabled}
            onChange={(e) =>
              updateContract({
                effectCeiling: e.target.value as typeof contract.effectCeiling,
              })
            }
          >
            {Object.entries(MODULE_EFFECT_CEILING_LABELS).map(
              ([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              )
            )}
          </select>
        </label>
        <div className='flex items-center justify-between gap-2'>
          <h3 className='text-body font-medium'>输入声明</h3>
          {!disabled && (
            <Button
              variant='outline'
              size='sm'
              disabled={contract.inputs.length >= 32}
              onClick={() =>
                updateContract({
                  inputs: [
                    ...contract.inputs,
                    { key: '', label: '', valueType: 'string', required: true },
                  ],
                })
              }
            >
              添加输入
            </Button>
          )}
        </div>
        {contract.inputs.map((input, i) => (
          <div
            key={i}
            className='grid gap-3 rounded-md border p-3 sm:grid-cols-2'
          >
            <label className='text-bodyall space-y-1'>
              输入 Key
              <Input
                aria-label={`输入 ${i + 1} Key`}
                value={input.key}
                disabled={disabled}
                onChange={(e) =>
                  updateContract({
                    inputs: contract.inputs.map((v, n) =>
                      n === i ? { ...v, key: e.target.value } : v
                    ),
                  })
                }
              />
            </label>
            <label className='text-bodyall space-y-1'>
              输入名称
              <Input
                aria-label={`输入 ${i + 1} 名称`}
                value={input.label}
                disabled={disabled}
                onChange={(e) =>
                  updateContract({
                    inputs: contract.inputs.map((v, n) =>
                      n === i ? { ...v, label: e.target.value } : v
                    ),
                  })
                }
              />
            </label>
            <label className='text-bodyall flex items-center gap-2'>
              类型
              <select
                aria-label={`输入 ${i + 1} 类型`}
                className={selectClass}
                disabled={disabled}
                value={input.valueType}
                onChange={(e) =>
                  updateContract({
                    inputs: contract.inputs.map((v, n) =>
                      n === i
                        ? {
                            ...v,
                            valueType: e.target.value as typeof v.valueType,
                          }
                        : v
                    ),
                  })
                }
              >
                {['string', 'number', 'boolean', 'json'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <div className='flex items-center justify-between gap-2'>
              <label className='text-bodyall flex items-center gap-2'>
                <input
                  type='checkbox'
                  checked={input.required}
                  disabled={disabled}
                  onChange={(e) =>
                    updateContract({
                      inputs: contract.inputs.map((v, n) =>
                        n === i ? { ...v, required: e.target.checked } : v
                      ),
                    })
                  }
                />
                必填
              </label>
              {!disabled && (
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() =>
                    updateContract({
                      inputs: contract.inputs.filter((_, n) => n !== i),
                    })
                  }
                >
                  删除输入 {i + 1}
                </Button>
              )}
            </div>
            <label className='text-bodyall space-y-1 sm:col-span-2'>
              说明
              <Input
                value={input.description ?? ''}
                disabled={disabled}
                onChange={(e) =>
                  updateContract({
                    inputs: contract.inputs.map((v, n) =>
                      n === i ? { ...v, description: e.target.value } : v
                    ),
                  })
                }
              />
            </label>
          </div>
        ))}
        <div className='flex items-center justify-between gap-2'>
          <h3 className='text-body font-medium'>输出声明与映射</h3>
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
              添加输出
            </Button>
          )}
        </div>
        {contract.outputs.map((output, i) => (
          <div
            key={i}
            className='grid gap-3 rounded-md border p-3 sm:grid-cols-2'
          >
            <label className='text-bodyall space-y-1'>
              输出 Key
              <Input
                aria-label={`输出 ${i + 1} Key`}
                value={output.key}
                disabled={disabled}
                onChange={(e) => {
                  const oldKey = output.key
                  const newKey = e.target.value
                  const nextImplementations = content.implementations.map((item) => {
                    const outputMapping = { ...item.outputMapping }
                    if (Object.prototype.hasOwnProperty.call(outputMapping, oldKey)) {
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
            </label>
            <label className='text-bodyall space-y-1'>
              输出名称
              <Input
                aria-label={`输出 ${i + 1} 名称`}
                value={output.label}
                disabled={disabled}
                onChange={(e) =>
                  updateContract({
                    outputs: contract.outputs.map((v, n) =>
                      n === i ? { ...v, label: e.target.value } : v
                    ),
                  })
                }
              />
            </label>
            <label className='text-bodyall space-y-1'>
              输出类型
              <select
                aria-label={`输出 ${i + 1} 类型`}
                className={`${selectClass} block w-full`}
                disabled={disabled}
                value={
                  output.shape.kind === 'scalar'
                    ? output.shape.type
                    : output.shape.kind
                }
                onChange={(e) =>
                  updateContract({
                    outputs: contract.outputs.map((v, n) =>
                      n !== i
                        ? v
                        : {
                            ...v,
                            shape:
                              e.target.value === 'unknown'
                                ? { kind: 'unknown' }
                                : e.target.value === 'object'
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
                                      type: e.target.value as
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
                {[
                  'string',
                  'number',
                  'boolean',
                  'json',
                  'object',
                  'unknown',
                ].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className='text-bodyall space-y-1'>
              实现输出
              <select
                aria-label={`输出 ${i + 1} 映射`}
                className={`${selectClass} block w-full`}
                disabled={disabled}
                value={impl.outputMapping[output.key] ?? ''}
                onChange={(e) =>
                  updateImpl({
                    outputMapping: {
                      ...impl.outputMapping,
                      [output.key]: e.target.value,
                    },
                  })
                }
              >
                <option value=''>选择步骤 outputKey</option>
                {impl.steps
                  .filter((s) => s.outputKey)
                  .map((s) => (
                    <option key={s.id} value={s.outputKey}>
                      {s.outputKey} · {s.name}
                    </option>
                  ))}
              </select>
            </label>
            {output.shape.kind === 'object' && (
              <div className='space-y-2 sm:col-span-2'>
                {output.shape.fields.map((field, n) => (
                  <div key={n} className='flex flex-wrap items-center gap-2'>
                    <Input
                      className='w-40'
                      aria-label={`输出 ${i + 1} 字段 ${n + 1}`}
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
                    <select
                      aria-label={`输出 ${i + 1} 字段 ${n + 1} 类型`}
                      className={selectClass}
                      value={field.type}
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
                                        ? {
                                            ...f,
                                            type: e.target
                                              .value as typeof f.type,
                                          }
                                        : f
                                    ),
                                  },
                                }
                          ),
                        })
                      }
                    >
                      {['string', 'number', 'boolean'].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <label className='text-bodyall'>
                      <input
                        type='checkbox'
                        checked={field.required}
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
                                          ? { ...f, required: e.target.checked }
                                          : f
                                      ),
                                    },
                                  }
                            ),
                          })
                        }
                      />{' '}
                      必填字段
                    </label>
                    {!disabled && (
                      <Button
                        variant='ghost'
                        size='sm'
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
                        删除字段
                      </Button>
                    )}
                  </div>
                ))}
                {!disabled && (
                  <Button
                    size='sm'
                    variant='outline'
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
                    添加输出字段
                  </Button>
                )}
              </div>
            )}
            <label className='text-bodyall space-y-1 sm:col-span-2'>
              说明
              <Input
                value={output.description ?? ''}
                disabled={disabled}
                onChange={(e) =>
                  updateContract({
                    outputs: contract.outputs.map((v, n) =>
                      n === i ? { ...v, description: e.target.value } : v
                    ),
                  })
                }
              />
            </label>
            {!disabled && (
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  const delKey = output.key
                  const nextImplementations = content.implementations.map((item) => {
                    const outputMapping = { ...item.outputMapping }
                    delete outputMapping[delKey]
                    return { ...item, outputMapping }
                  })
                  onChange({
                    ...content,
                    contract: {
                      ...contract,
                      outputs: contract.outputs.filter((_, n) => n !== i),
                    },
                    implementations: nextImplementations,
                  })
                }}
              >
                删除输出 {i + 1}
              </Button>
            )}
          </div>
        ))}
      </section>
      <section className='space-y-4 rounded-xl border bg-card p-4'>
        <h2 className='text-section font-semibold'>条件与起止状态</h2>
        <p className='text-bodyall text-muted-foreground'>
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
                    conditions.map((c, n) => (n === i ? { ...c, ...patch } : c))
                  )
                return (
                  <div
                    key={i}
                    className='grid gap-3 rounded-md border p-3 sm:grid-cols-2'
                  >
                    <label className='text-bodyall space-y-1 sm:col-span-2'>
                      业务含义
                      <Textarea
                        aria-label={`${sectionNames[section]} ${i + 1} 含义`}
                        disabled={disabled}
                        value={condition.meaning}
                        onChange={(e) => update({ meaning: e.target.value })}
                      />
                    </label>
                    <select
                      aria-label={`${sectionNames[section]} ${i + 1} 验证方式`}
                      className={selectClass}
                      value={condition.verification.kind}
                      disabled={disabled}
                      onChange={(e) =>
                        update({
                          verification:
                            e.target.value === 'step'
                              ? { kind: 'step', stepId: '' }
                              : e.target.value === 'output_required'
                                ? { kind: 'output_required', outputKey: '' }
                                : { kind: 'manual_requirement' },
                        })
                      }
                    >
                      <option value='manual_requirement'>
                        人工说明，未自动验证
                      </option>
                      <option value='step'>断言步骤</option>
                      <option value='output_required'>必需输出</option>
                    </select>
                    {condition.verification.kind === 'step' && (
                      <select
                        aria-label={`${sectionNames[section]} ${i + 1} 断言步骤`}
                        className={selectClass}
                        value={condition.verification.stepId}
                        disabled={disabled}
                        onChange={(e) =>
                          update({
                            verification: {
                              kind: 'step',
                              stepId: e.target.value,
                            },
                          })
                        }
                      >
                        <option value=''>选择断言</option>
                        {impl.steps
                          .filter(
                            (s) => s.type === 'assert' || s.type === 'ai_assert'
                          )
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                    )}
                    {condition.verification.kind === 'output_required' && (
                      <select
                        aria-label={`${sectionNames[section]} ${i + 1} 输出`}
                        className={selectClass}
                        value={condition.verification.outputKey}
                        disabled={disabled}
                        onChange={(e) =>
                          update({
                            verification: {
                              kind: 'output_required',
                              outputKey: e.target.value,
                            },
                          })
                        }
                      >
                        <option value=''>选择输出</option>
                        {contract.outputs
                          .filter((o) => o.key)
                          .map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label} ({o.key})
                            </option>
                          ))}
                      </select>
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
      <section className='space-y-4 rounded-xl border bg-card p-4'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <h2 className='text-section font-semibold'>实现</h2>
          {!disabled && content.implementations.length < MAX_MODULE_IMPLEMENTATIONS ? (
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
        <label className='space-y-1 text-bodyall'>
          实现 key
          <Input
            aria-label='实现 key'
            value={impl.implementationKey}
            disabled={disabled}
            onChange={(e) => updateImpl({ implementationKey: e.target.value })}
          />
        </label>
        {(() => {
          const stats = implementationsQuality?.find((q) => q.implementationKey === impl.implementationKey)
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
          <div className='space-y-3 rounded-lg border p-3 bg-muted/20'>
            <div className='space-y-1'>
              <h3 className='text-body font-medium'>后置条件映射</h3>
              <p className='text-small text-muted-foreground'>
                为当前实现指定后置条件的断言步骤映射。
              </p>
            </div>
            {contract.postconditions.map((postcondition, i) => {
              const currentBinding = impl.postconditionBindings?.[i] ?? postcondition.verification
              const assertSteps = impl.steps.filter((s) => s.type === 'assert' || s.type === 'ai_assert')
              return (
                <div key={i} className='grid gap-2 sm:grid-cols-2 items-center text-body'>
                  <div>
                    <span className='font-medium'>{postcondition.meaning}</span>
                    <Badge variant='outline' className='ms-2 text-label'>
                      {postcondition.verification.kind === 'output_required'
                        ? '必需输出'
                        : postcondition.verification.kind === 'manual_requirement'
                          ? '人工说明'
                          : '断言步骤'}
                    </Badge>
                  </div>
                  {postcondition.verification.kind === 'step' ? (
                    <select
                      aria-label={`后置条件 ${i + 1} 步骤映射`}
                      className={selectClass}
                      disabled={disabled}
                      value={currentBinding.kind === 'step' ? currentBinding.stepId : ''}
                      onChange={(e) => {
                        const newBindings = contract.postconditions.map((cond, idx) =>
                          idx === i
                            ? { kind: 'step' as const, stepId: e.target.value }
                            : (impl.postconditionBindings?.[idx] ?? cond.verification),
                        )
                        updateImpl({ postconditionBindings: newBindings })
                      }}
                    >
                      <option value=''>选择断言步骤</option>
                      {assertSteps.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : postcondition.verification.kind === 'output_required' ? (
                    <span className='text-muted-foreground text-small'>
                      要求输出「{postcondition.verification.outputKey}」
                      {impl.outputMapping[postcondition.verification.outputKey]
                        ? `（映射至 ${impl.outputMapping[postcondition.verification.outputKey]}）`
                        : '（未映射）'}
                    </span>
                  ) : (
                    <span className='text-muted-foreground text-small'>人工说明，无需步骤映射</span>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
        {contract.preconditions.some((p) => p.verification.kind === 'step') ? (
          <div className='space-y-3 rounded-lg border p-3 bg-muted/20'>
            <div className='space-y-1'>
              <h3 className='text-body font-medium'>前置条件映射</h3>
              <p className='text-small text-muted-foreground'>
                为当前实现指定前置条件的断言步骤映射。
              </p>
            </div>
            {contract.preconditions.map((precondition, i) => {
              const currentBinding = impl.preconditionBindings?.[i] ?? precondition.verification
              const assertSteps = impl.steps.filter((s) => s.type === 'assert' || s.type === 'ai_assert')
              return (
                <div key={i} className='grid gap-2 sm:grid-cols-2 items-center text-bodyall'>
                  <div>
                    <span className='font-medium'>{precondition.meaning}</span>
                  </div>
                  {precondition.verification.kind === 'step' ? (
                    <select
                      aria-label={`前置条件 ${i + 1} 步骤映射`}
                      className={selectClass}
                      disabled={disabled}
                      value={currentBinding.kind === 'step' ? currentBinding.stepId : ''}
                      onChange={(e) => {
                        const newBindings = contract.preconditions.map((cond, idx) =>
                          idx === i
                            ? { kind: 'step' as const, stepId: e.target.value }
                            : (impl.preconditionBindings?.[idx] ?? cond.verification),
                        )
                        updateImpl({ preconditionBindings: newBindings })
                      }}
                    >
                      <option value=''>选择断言步骤</option>
                      {assertSteps.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className='text-muted-foreground text-small'>非断言步骤，无需映射</span>
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
                implementations: content.implementations.filter((_, i) => i !== safeImplIndex),
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
            实现步骤 · {impl.implementationKey} ({impl.steps.length}/{MAX_SCENARIO_STEPS})
          </h2>
          {!disabled && (
            <div className='flex flex-wrap gap-2'>
              <select
                aria-label='添加步骤类型'
                className={selectClass}
                value={types.includes(addType) ? addType : (types[0] ?? '')}
                onChange={(e) =>
                  setAddType(e.target.value as ExecutableStepType)
                }
              >
                {types.map((type) => (
                  <option key={type} value={type}>
                    {STEP_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
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
              {impl.steps.map((s, i) => (
                <Button
                  key={s.id}
                  variant={index === i ? 'secondary' : 'ghost'}
                  className='w-full justify-start overflow-hidden'
                  onClick={() => setSelected(i)}
                >
                  <span className='truncate'>
                    {i + 1}. {s.name} · {STEP_TYPE_LABELS[s.type]}
                  </span>
                </Button>
              ))}
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
                <AuthoringObserveProvider
                  enabled={false}
                  authoring={{
                    indicate: 'closed',
                    highlight: 'closed',
                    debugHold: 'closed',
                    assist: 'closed',
                    stepTypesExtra: [],
                  }}
                  onApplyTarget={() => {}}
                >
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
                </AuthoringObserveProvider>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
