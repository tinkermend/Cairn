import type { ReactNode } from 'react'
import type { FieldPath } from 'react-hook-form'
import type { PlatformConfigDocument } from '@cairn/shared'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FieldHelp } from '@/components/ui/field-help'
import { cn } from '@/lib/utils'

export { FieldHelp }

export function SettingMark({ children }: { children: ReactNode }) {
  return (
    <span className='rounded-sm bg-muted px-1.5 text-label text-muted-foreground'>
      {children}
    </span>
  )
}

export function SettingLabel({
  label,
  unit,
  mark,
  help,
}: {
  label: string
  unit?: string
  mark?: string
  help?: ReactNode
}) {
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      <FormLabel>{label}</FormLabel>
      {unit ? (
        <span className='text-label text-muted-foreground'>{unit}</span>
      ) : null}
      {mark ? <SettingMark>{mark}</SettingMark> : null}
      {help ? <FieldHelp label={label}>{help}</FieldHelp> : null}
    </div>
  )
}

export function SettingSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className='space-y-3'>
      <div className='space-y-1'>
        <h3 className='text-section font-semibold'>{title}</h3>
        {hint ? <p className='text-label text-muted-foreground'>{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function SwitchGrid({ children }: { children: ReactNode }) {
  return (
    <div className='grid gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-2 [&>*:last-child:nth-child(odd)]:md:col-span-2'>
      {children}
    </div>
  )
}

export function FieldGrid({
  children,
  columns = 2,
}: {
  children: ReactNode
  columns?: 2 | 3
}) {
  return (
    <div
      className={cn(
        'grid gap-4',
        columns === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'
      )}
    >
      {children}
    </div>
  )
}

export function SwitchRow({
  label,
  help,
  warning,
  note,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  help?: ReactNode
  warning?: string
  note?: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <FormItem className='flex h-full min-h-11 items-center justify-between gap-3 bg-card px-3 py-2'>
      <div className='min-w-0'>
        <div className='flex items-center gap-1'>
          <FormLabel className='leading-5'>{label}</FormLabel>
          {help ? <FieldHelp label={label}>{help}</FieldHelp> : null}
        </div>
        {note ? (
          <p className='mt-0.5 text-label text-muted-foreground'>{note}</p>
        ) : null}
        {checked && warning ? (
          <p className='mt-0.5 text-label text-muted-foreground'>{warning}</p>
        ) : null}
      </div>
      <FormControl>
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </FormControl>
    </FormItem>
  )
}

export function NumberSetting({
  name,
  label,
  unit,
  mark,
  help,
  canWrite,
  disabled,
  min,
  max,
  step,
}: {
  name: FieldPath<PlatformConfigDocument>
  label: string
  unit?: string
  mark?: string
  help?: ReactNode
  canWrite: boolean
  disabled?: boolean
  min?: number
  max?: number
  step?: number | string
}) {
  const locked = disabled || !canWrite
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <SettingLabel label={label} unit={unit} mark={mark} help={help} />
          <FormControl>
            <Input
              type='number'
              min={min}
              max={max}
              step={step}
              disabled={locked}
              value={field.value}
              onChange={(event) => {
                if (locked) return
                field.onChange(Number(event.target.value))
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
