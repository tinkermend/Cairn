import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CAPTURE_MODE_LABELS } from './labels'

export function EvidenceFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <CaptureField
        name='evidence.screenshot'
        label='截图采集'
        canWrite={canWrite}
      />
      <CaptureField
        name='evidence.trace'
        label='Trace 采集'
        canWrite={canWrite}
      />
      <FormField
        name='evidence.retainDays.screenshot'
        render={({ field }) => (
          <FormItem>
            <FormLabel>截图保留（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='evidence.retainDays.trace'
        render={({ field }) => (
          <FormItem>
            <FormLabel>一般 Trace 保留（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='evidence.retainDays.debugTrace'
        render={({ field }) => (
          <FormItem>
            <FormLabel>调试 Trace 保留（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              Trace 选「始终」时使用。始终不等于永久保存。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <p className='text-label text-muted-foreground md:col-span-2'>
        必要证据由代码约束，不能在这里删掉。
      </p>
    </div>
  )
}

function CaptureField({
  name,
  label,
  canWrite,
}: {
  name: 'evidence.screenshot' | 'evidence.trace'
  label: string
  canWrite: boolean
}) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            disabled={!canWrite}
            value={field.value ?? ''}
            onValueChange={field.onChange}
          >
            <FormControl>
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {(['off', 'on_failure', 'always'] as const).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {CAPTURE_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
