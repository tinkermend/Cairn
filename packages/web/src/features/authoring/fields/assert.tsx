import {
  ASSERT_KINDS,
  NUMBER_COMPARE_OPS,
  type AssertExpect,
  type NumberCompareOp,
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
import { KIND_LABELS, OP_LABELS } from './labels'

export function AssertFields({
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
            else if (kind === 'text_equals' || kind === 'text_contains')
              onChange({ kind, value: '' })
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
            onChange={(event) =>
              onChange({ ...expect, value: event.target.value })
            }
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
              onValueChange={(value) =>
                onChange({ ...expect, op: value as NumberCompareOp })
              }
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
              onChange={(event) =>
                onChange({ ...expect, value: Number(event.target.value) })
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
