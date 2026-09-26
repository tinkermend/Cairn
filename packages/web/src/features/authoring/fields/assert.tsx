import {
  ASSERT_KINDS,
  NUMBER_COMPARE_OPS,
  type AssertExpect,
  type NumberCompareOp,
} from '@cairn/shared'
import { validateAriaSnapshotTemplate } from '@cairn/authoring'
import { FieldHelp } from '@/components/ui/field-help'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
  const validation =
    expect.kind === 'aria_snapshot'
      ? validateAriaSnapshotTemplate(expect.template)
      : null

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
            else if (kind === 'aria_snapshot')
              onChange({ kind, template: '' })
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
      {expect.kind === 'aria_snapshot' ? (
        <div className='space-y-2'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-1.5'>
              <Label htmlFor='assert-aria-template'>Aria 快照模板 (YAML)</Label>
              <FieldHelp label='Aria 快照模板'>
                支持角色、无障碍名称与正则匹配（如 <code>- button /确认/</code>）。顶层必须以 <code>-</code> 开头。
              </FieldHelp>
            </div>
            <span className='text-label text-muted-foreground'>
              {expect.template.length} / 16384 字符
            </span>
          </div>
          <Textarea
            id='assert-aria-template'
            value={expect.template}
            disabled={disabled}
            placeholder={'- heading "标题" [level=1]\n- button "确认"'}
            rows={6}
            className='font-mono text-label leading-relaxed'
            onChange={(event) =>
              onChange({ ...expect, template: event.target.value.slice(0, 16384) })
            }
          />
          {validation && !validation.valid && expect.template.trim().length > 0 ? (
            <p className='text-label text-destructive'>{validation.error}</p>
          ) : (
            <p className='text-label text-muted-foreground'>
              支持角色、无障碍名称与正则匹配（如 <code>- button /确认/</code>）。顶层必须以 <code>-</code> 开头。
            </p>
          )}
        </div>
      ) : null}
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
