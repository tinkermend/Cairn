import { useState } from 'react'
import {
  RUNTIME_INVARIANT_KINDS,
  createRuntimeInvariant,
  type OutcomeOnViolation,
  type OutcomeSeverity,
  type RuntimeInvariant,
  type RuntimeInvariantEvaluateAt,
  type RuntimeInvariantKind,
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

const KIND_LABELS: Record<RuntimeInvariantKind, string> = {
  navigation_boundary: '不得离开允许范围',
  auth_validity: '登录保持有效',
  effect_ceiling: '副作用不超过声明',
  readonly_guarantee: '不得改写业务数据',
  error_surface: '不得出现系统错误弹窗',
}

const EVALUATE_LABELS: Record<RuntimeInvariantEvaluateAt, string> = {
  step_boundary: '步骤边界',
  before_side_effect: '副作用前',
  each_step: '每一步后探测',
}

export function RuntimeInvariantEditor({
  invariants,
  disabled,
  allowEachStepProbe,
  onChange,
}: {
  invariants: RuntimeInvariant[]
  disabled?: boolean
  allowEachStepProbe?: boolean
  onChange: (next: RuntimeInvariant[]) => void
}) {
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-small font-semibold'>运行期约束</h3>
        <Select
          disabled={disabled}
          onValueChange={(kind) => {
            if (!kind) return
            onChange([...invariants, createRuntimeInvariant(kind as RuntimeInvariantKind, crypto.randomUUID())])
          }}
        >
          <SelectTrigger className='w-auto' size='sm' aria-label='添加运行期约束'>
            <SelectValue placeholder='添加约束' />
          </SelectTrigger>
          <SelectContent>
            {RUNTIME_INVARIANT_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {invariants.length === 0 ? (
        <p className='text-small text-muted-foreground'>
          约束检查整个运行期间不能被破坏的事，例如不得离开允许范围、登录保持有效。
        </p>
      ) : (
        <ul className='space-y-3'>
          {invariants.map((invariant) => (
            <li key={invariant.id}>
              <InvariantCard
                invariant={invariant}
                disabled={disabled}
                allowEachStepProbe={allowEachStepProbe}
                onChange={(next) =>
                  onChange(invariants.map((item) => (item.id === next.id ? next : item)))
                }
                onRemove={() => onChange(invariants.filter((item) => item.id !== invariant.id))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function InvariantCard({
  invariant,
  disabled,
  allowEachStepProbe,
  onChange,
  onRemove,
}: {
  invariant: RuntimeInvariant
  disabled?: boolean
  allowEachStepProbe?: boolean
  onChange: (next: RuntimeInvariant) => void
  onRemove: () => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const haltBlocked = invariant.severity === 'SHOULD' || invariant.severity === 'INFO'
  const evaluateOptions: RuntimeInvariantEvaluateAt[] =
    invariant.kind === 'error_surface'
      ? allowEachStepProbe
        ? ['before_side_effect', 'each_step']
        : ['before_side_effect']
      : ['step_boundary', 'before_side_effect']

  return (
    <div className='space-y-3 rounded-md border border-border-card p-3'>
      <div className='flex items-start justify-between gap-2'>
        <div>
          <p className='text-label text-muted-foreground'>{KIND_LABELS[invariant.kind]}</p>
          <Label htmlFor={`invariant-meaning-${invariant.id}`}>一句话说明</Label>
        </div>
        <Button type='button' size='sm' variant='ghost' disabled={disabled} onClick={onRemove}>
          删除
        </Button>
      </div>
      <Input
        id={`invariant-meaning-${invariant.id}`}
        value={invariant.meaning}
        disabled={disabled}
        onChange={(event) => onChange({ ...invariant, meaning: event.target.value })}
      />
      {invariant.kind === 'navigation_boundary' || invariant.kind === 'auth_validity' ? (
        <p className='text-label text-muted-foreground'>
          越界导航和登录失效仍按原规则拦截或恢复；这里只决定如何记入业务结论。
        </p>
      ) : null}
      {invariant.kind === 'readonly_guarantee' ? (
        <p className='text-label text-muted-foreground'>
          对照已执行步骤的副作用类型，不会额外拦截写入。
        </p>
      ) : null}
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger className='flex items-center gap-1 text-label text-muted-foreground'>
          高级
          <ChevronDown className='size-3' />
        </CollapsibleTrigger>
        <CollapsibleContent className='mt-3 grid gap-3 sm:grid-cols-3'>
          <div className='space-y-1'>
            <Label>严重度</Label>
            <Select
              value={invariant.severity}
              disabled={disabled}
              onValueChange={(severity) => {
                const next = severity as OutcomeSeverity
                onChange({
                  ...invariant,
                  severity: next,
                  onViolation:
                    (next === 'SHOULD' || next === 'INFO') && invariant.onViolation === 'halt'
                      ? 'continue'
                      : invariant.onViolation,
                })
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='MUST'>必须</SelectItem>
                <SelectItem value='SHOULD'>应当</SelectItem>
                <SelectItem value='INFO'>提示</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label>违反时</Label>
            <Select
              value={invariant.onViolation}
              disabled={disabled || haltBlocked}
              onValueChange={(value) => onChange({ ...invariant, onViolation: value as OutcomeOnViolation })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='continue'>继续并记入结论</SelectItem>
                {!haltBlocked ? <SelectItem value='halt'>停止后续步骤</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label>求值时机</Label>
            <Select
              value={invariant.evaluateAt}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({ ...invariant, evaluateAt: value as RuntimeInvariantEvaluateAt })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {evaluateOptions.map((item) => (
                  <SelectItem key={item} value={item}>
                    {EVALUATE_LABELS[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export { KIND_LABELS as RUNTIME_INVARIANT_KIND_LABELS }
