import { useState } from 'react'
import {
  expectKindLabel,
  type AssertExpect,
  type OutcomeContract,
  type OutcomeOnViolation,
  type OutcomeSeverity,
  type TargetDescriptor,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown } from 'lucide-react'
import { defaultTarget } from './step-registry'
import { TargetFields } from './fields/target'
import { useAuthoringObserve } from './observe'

const EXPECT_OPTIONS: { kind: AssertExpect['kind']; label: string }[] = [
  { kind: 'exists', label: '对象存在' },
  { kind: 'visible', label: '对象可见' },
  { kind: 'text_equals', label: '文本相符' },
  { kind: 'text_contains', label: '文本包含' },
]

function newContractId(): string {
  return crypto.randomUUID()
}

function blankContract(scope: OutcomeContract['scope']): OutcomeContract {
  return {
    id: newContractId(),
    scope,
    meaning: '结果符合预期',
    severity: 'MUST',
    onViolation: 'halt',
    provenance: 'manual',
    rule: {
      kind: 'deterministic',
      target: defaultTarget('结果'),
      expect: { kind: 'exists' },
    },
  }
}

function ruleExpect(contract: OutcomeContract): AssertExpect {
  return contract.rule.kind === 'deterministic' ? contract.rule.expect : { kind: 'exists' }
}

function ruleTarget(contract: OutcomeContract): TargetDescriptor | undefined {
  return contract.rule.kind === 'deterministic' ? contract.rule.target : undefined
}

export function OutcomeListEditor({
  outcomes,
  scope,
  disabled,
  onChange,
}: {
  outcomes: OutcomeContract[]
  scope: OutcomeContract['scope']
  disabled?: boolean
  onChange: (next: OutcomeContract[]) => void
}) {
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-small font-semibold'>
          {scope === 'scenario' ? '怎样才算成功' : '成功条件'}
        </h3>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled}
          onClick={() => onChange([...outcomes, blankContract(scope)])}
        >
          添加条件
        </Button>
      </div>
      {outcomes.length === 0 ? (
        <p className='text-small text-muted-foreground'>
          {scope === 'scenario'
            ? '还没有场景级成功条件。可以从页面选择对象，用业务语言写下期望。'
            : '还没有成功条件。跑完这一步后，怎样才算业务成功？'}
        </p>
      ) : (
        <ul className='space-y-3'>
          {outcomes.map((contract, index) => (
            <li key={contract.id}>
              <OutcomeCard
                contract={contract}
                index={index}
                disabled={disabled}
                onChange={(next) =>
                  onChange(outcomes.map((item) => (item.id === next.id ? next : item)))
                }
                onRemove={() => onChange(outcomes.filter((item) => item.id !== contract.id))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function OutcomeCard({
  contract,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  contract: OutcomeContract
  index: number
  disabled?: boolean
  onChange: (next: OutcomeContract) => void
  onRemove: () => void
}) {
  const observe = useAuthoringObserve()
  const [advanced, setAdvanced] = useState(false)
  const expect = ruleExpect(contract)
  const target = ruleTarget(contract)
  const haltBlocked = contract.severity === 'SHOULD' || contract.severity === 'INFO'

  function patchRule(next: { target?: TargetDescriptor; expect?: AssertExpect }) {
    if (contract.rule.kind !== 'deterministic') return
    onChange({
      ...contract,
      rule: {
        ...contract.rule,
        ...(next.target ? { target: next.target } : {}),
        ...(next.expect ? { expect: next.expect } : {}),
      },
    })
  }

  function applyPickedTarget() {
    const picked = observe.lastPicked ?? observe.highlight?.target
    if (!picked) return
    patchRule({ target: picked })
  }

  return (
    <div className='space-y-3 rounded-md border border-border-card p-3'>
      <div className='space-y-2'>
        <Label htmlFor={`outcome-meaning-${contract.id}`}>成功含义</Label>
        <Input
          id={`outcome-meaning-${contract.id}`}
          value={contract.meaning}
          disabled={disabled}
          aria-label={`成功条件 ${index + 1} 含义`}
          onChange={(event) => onChange({ ...contract, meaning: event.target.value })}
        />
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-2'>
          <Label>期望</Label>
          <Select
            value={expect.kind}
            disabled={disabled}
            onValueChange={(kind) => {
              const nextKind = kind as AssertExpect['kind']
              if (nextKind === 'text_equals' || nextKind === 'text_contains') {
                patchRule({
                  expect: {
                    kind: nextKind,
                    value: expect.kind === 'text_equals' || expect.kind === 'text_contains' ? expect.value : '',
                  },
                })
                return
              }
              if (nextKind === 'number_compare') {
                patchRule({ expect: { kind: 'number_compare', op: 'eq', value: 0 } })
                return
              }
              patchRule({ expect: { kind: nextKind } })
            }}
          >
            <SelectTrigger className='w-full' aria-label={`成功条件 ${index + 1} 期望`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPECT_OPTIONS.map((item) => (
                <SelectItem key={item.kind} value={item.kind}>
                  {item.label}
                </SelectItem>
              ))}
              {advanced ? (
                <SelectItem value='number_compare'>数值比较</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
        {expect.kind === 'text_equals' || expect.kind === 'text_contains' ? (
          <div className='space-y-2'>
            <Label htmlFor={`outcome-text-${contract.id}`}>
              {expect.kind === 'text_equals' ? '期望文本' : '应包含的文本'}
            </Label>
            <Input
              id={`outcome-text-${contract.id}`}
              value={expect.value}
              disabled={disabled}
              onChange={(event) =>
                patchRule({ expect: { kind: expect.kind, value: event.target.value } })
              }
            />
          </div>
        ) : null}
        {expect.kind === 'number_compare' ? (
          <div className='grid grid-cols-2 gap-2'>
            <Select
              value={expect.op}
              disabled={disabled}
              onValueChange={(op) =>
                patchRule({
                  expect: { ...expect, op: op as typeof expect.op },
                })
              }
            >
              <SelectTrigger aria-label={`成功条件 ${index + 1} 比较`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='eq'>等于</SelectItem>
                <SelectItem value='gt'>大于</SelectItem>
                <SelectItem value='gte'>不小于</SelectItem>
                <SelectItem value='lt'>小于</SelectItem>
                <SelectItem value='lte'>不大于</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type='number'
              value={expect.value}
              disabled={disabled}
              aria-label={`成功条件 ${index + 1} 期望数值`}
              onChange={(event) =>
                patchRule({
                  expect: { ...expect, value: Number(event.target.value) },
                })
              }
            />
          </div>
        ) : null}
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled}
          onClick={() => {
            if (!observe.holding) {
              observe.setPickMode(true)
              return
            }
            observe.setPickMode(true)
          }}
        >
          从页面选择
        </Button>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={disabled || !(observe.lastPicked || observe.highlight?.target)}
          onClick={applyPickedTarget}
        >
          使用刚点到的对象
        </Button>
        <Button type='button' size='sm' variant='ghost' disabled={disabled} onClick={onRemove}>
          移除
        </Button>
      </div>
      <p className='text-label text-muted-foreground'>
        {expectKindLabel(expect.kind)}
        {target?.candidates[0]?.value ? ` · 已选择「${target.candidates[0].value}」` : ' · 尚未选择页面对象'}
      </p>
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger asChild>
          <Button type='button' size='sm' variant='ghost' className='gap-1'>
            高级
            <ChevronDown className={advanced ? 'size-3.5 rotate-180' : 'size-3.5'} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className='mt-3 space-y-3'>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-2'>
              <Label>严重度</Label>
              <Select
                value={contract.severity}
                disabled={disabled}
                onValueChange={(severity) => {
                  const next = severity as OutcomeSeverity
                  onChange({
                    ...contract,
                    severity: next,
                    onViolation: next === 'MUST' ? contract.onViolation : 'continue',
                  })
                }}
              >
                <SelectTrigger aria-label={`成功条件 ${index + 1} 严重度`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='MUST'>必须成立</SelectItem>
                  <SelectItem value='SHOULD'>应当成立</SelectItem>
                  <SelectItem value='INFO'>仅记录</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className='space-y-2'>
              <Label>不成立时</Label>
              <Select
                value={haltBlocked ? 'continue' : contract.onViolation}
                disabled={disabled || haltBlocked}
                onValueChange={(value) =>
                  onChange({ ...contract, onViolation: value as OutcomeOnViolation })
                }
              >
                <SelectTrigger aria-label={`成功条件 ${index + 1} 不成立时`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='halt'>停止运行</SelectItem>
                  <SelectItem value='continue'>继续并记入结果</SelectItem>
                </SelectContent>
              </Select>
              {haltBlocked ? (
                <p className='text-label text-muted-foreground'>应当成立或仅记录的条件不能停止整次运行。</p>
              ) : null}
            </div>
          </div>
          {target ? (
            <TargetFields
              target={target}
              disabled={disabled}
              optional
              onChange={(next) => patchRule({ target: next })}
            />
          ) : (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={disabled}
              onClick={() => patchRule({ target: defaultTarget('结果') })}
            >
              手工指定页面对象
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
