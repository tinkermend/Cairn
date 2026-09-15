import { useRef, useState } from 'react'
import { format, subMonths } from 'date-fns'
import { Calendar as CalendarIcon } from 'lucide-react'
import { Cross2Icon } from '@radix-ui/react-icons'
import { zhCN } from 'react-day-picker/locale'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type { DateRange }

type DateRangePickerProps = {
  value?: DateRange
  onChange: (range: DateRange | undefined) => void
  placeholder?: string
  'aria-label'?: string
  className?: string
}

function formatRange(range?: DateRange): string {
  if (!range?.from) return ''
  const start = format(range.from, 'yyyy-MM-dd')
  if (!range.to) return `${start} –`
  return `${start} – ${format(range.to, 'yyyy-MM-dd')}`
}

/** 日期范围筛选。起止日在同一个日历里点选，不用并排两个原生 date 框。 */
export function DateRangePicker({
  value,
  onChange,
  placeholder = '时间',
  'aria-label': ariaLabel = '时间',
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const picking = useRef<'start' | 'end'>('start')
  const display = formatRange(value)

  return (
    <div className='flex items-center gap-1'>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) picking.current = value?.from && !value.to ? 'end' : 'start'
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            size='sm'
            aria-label={ariaLabel}
            data-empty={!display}
            className={cn(
              'h-8 min-w-56 justify-start font-normal data-[empty=true]:text-muted-foreground',
              className,
            )}
          >
            <CalendarIcon className='size-4 opacity-50' />
            <span className='truncate'>{display || placeholder}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-auto p-0'>
          <p className='border-b border-border-divider px-3 py-2 text-label text-muted-foreground'>
            按浏览器本地日历日筛选；服务端按 UTC 半开区间 [from, to) 查询。
          </p>
          <Calendar
            mode='range'
            locale={zhCN}
            numberOfMonths={2}
            defaultMonth={value?.from ?? subMonths(new Date(), 1)}
            selected={value}
            onSelect={(next) => {
              if (!next?.from) {
                picking.current = 'start'
                onChange(undefined)
                return
              }
              if (picking.current === 'start') {
                picking.current = 'end'
                onChange({ from: next.from, to: undefined })
                return
              }
              onChange(next.to ? next : { from: next.from, to: next.from })
              picking.current = 'start'
              setOpen(false)
            }}
            disabled={(date) => date > new Date() || date < new Date('1900-01-01')}
          />
        </PopoverContent>
      </Popover>
      {display ? (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-8 px-2'
          aria-label='清除日期'
          onClick={() => {
            picking.current = 'start'
            onChange(undefined)
          }}
        >
          <Cross2Icon className='size-3.5' />
        </Button>
      ) : null}
    </div>
  )
}
