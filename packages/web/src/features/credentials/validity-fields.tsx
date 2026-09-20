import {
  useWatch,
  type Control,
  type FieldValues,
  type Path,
} from 'react-hook-form'
import {
  computeMaintenanceDueAt,
  credentialValidityWriteSchema,
  type CredentialValidityPolicy,
  type CredentialValidityWrite,
} from '@cairn/shared'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type ValidityFormFields = {
  validityMode: 'days' | 'months' | 'permanent'
  validityAmount: string
  validityTimeZone: string
}

export function defaultValidityFields(
  policy?: CredentialValidityPolicy | null
): ValidityFormFields {
  return {
    validityMode:
      policy?.mode === 'unknown' ? 'days' : (policy?.mode ?? 'days'),
    validityAmount: policy?.amount?.toString() ?? '',
    validityTimeZone:
      policy?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

export function toValidityWrite(
  values: ValidityFormFields
): CredentialValidityWrite {
  return credentialValidityWriteSchema.parse(
    values.validityMode === 'permanent'
      ? { mode: 'permanent' }
      : {
          mode: values.validityMode,
          amount: Number(values.validityAmount),
          timeZone: values.validityTimeZone,
        }
  )
}

export function localDateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

export function validityPreview(
  values: ValidityFormFields,
  start?: string | null
) {
  try {
    const write = toValidityWrite(values)
    if (write.mode === 'permanent') return '永久有效'
    if (!start)
      return '保存新密码时从当前时间计算；仅修改有效期时保留原起算时间。'
    const due = computeMaintenanceDueAt({
      policy: {
        mode: write.mode,
        amount: write.amount ?? null,
        timeZone: write.timeZone ?? null,
      },
      startedAt: new Date(start),
    })
    return due
      ? `到期时间：${due.toLocaleString('zh-CN', { timeZone: write.timeZone })}（${write.timeZone}）`
      : '请填写起算时间'
  } catch {
    return '请选择永久，或填写有效的天数 / 月数和时区。'
  }
}

export function ValidityInput({
  value,
  onChange,
  startedAt,
}: {
  value: ValidityFormFields
  onChange: (v: ValidityFormFields) => void
  startedAt?: string | null
}) {
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-end gap-3'>
        <div className='space-y-2'>
          <Label>凭据有效期</Label>
          <Select
            value={value.validityMode}
            onValueChange={(v) =>
              onChange({
                ...value,
                validityMode: v as ValidityFormFields['validityMode'],
              })
            }
          >
            <SelectTrigger aria-label='凭据有效期' className='w-36'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='days'>按天</SelectItem>
              <SelectItem value='months'>按月</SelectItem>
              <SelectItem value='permanent'>永久</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {value.validityMode !== 'permanent' && (
          <>
            <label className='space-y-2'>
              <span className='text-label'>数量</span>
              <Input
                aria-label='有效期数量'
                className='w-28'
                inputMode='numeric'
                value={value.validityAmount}
                onChange={(e) =>
                  onChange({ ...value, validityAmount: e.target.value })
                }
                placeholder='请输入'
              />
            </label>
            <label className='min-w-40 flex-1 space-y-2'>
              <span className='text-label'>时区</span>
              <Input
                aria-label='有效期时区'
                value={value.validityTimeZone}
                onChange={(e) =>
                  onChange({ ...value, validityTimeZone: e.target.value })
                }
              />
            </label>
          </>
        )}
      </div>
      <p className='text-label text-muted-foreground'>
        {validityPreview(value, startedAt)}
      </p>
    </div>
  )
}

export function ValidityFields<T extends FieldValues>({
  control,
  required,
}: {
  control: Control<T>
  required?: boolean
}) {
  const mode = useWatch({ control, name: 'validityMode' as Path<T> })
  return (
    <div className='space-y-4 rounded-md border border-border-divider p-3'>
      <FormField
        control={control}
        name={'validityMode' as Path<T>}
        render={({ field }) => (
          <FormItem>
            <FormLabel>凭据有效期{required ? '' : '（可单独修改）'}</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value='days'>按天</SelectItem>
                <SelectItem value='months'>按月</SelectItem>
                <SelectItem value='permanent'>永久</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      {mode !== 'permanent' && (
        <>
          <FormField
            control={control}
            name={'validityAmount' as Path<T>}
            render={({ field }) => (
              <FormItem>
                <FormLabel>数量</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    inputMode='numeric'
                    placeholder='请输入天数或月数'
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name={'validityTimeZone' as Path<T>}
            render={({ field }) => (
              <FormItem>
                <FormLabel>时区</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
      <p className='text-label text-muted-foreground'>
        到期提醒你更新凭据，不会自动停用账号。单独修改有效期会保留原起算时间。
      </p>
    </div>
  )
}
