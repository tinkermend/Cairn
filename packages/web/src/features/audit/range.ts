import { format } from 'date-fns'
import type { DateRange } from 'react-day-picker'

export function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

export function rangeToDayKeys(range?: DateRange): { fromDay: string; toDay: string } {
  return {
    fromDay: range?.from ? dayKey(range.from) : '',
    toDay: range?.to ? dayKey(range.to) : '',
  }
}

export function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00`)
}

export function dayAfter(date: string): Date {
  const value = dayStart(date)
  value.setDate(value.getDate() + 1)
  return value
}

export function dateRange(fromDay: string, toDay: string): { from?: Date; to?: Date } {
  const from = fromDay ? dayStart(fromDay) : undefined
  const to = toDay ? dayAfter(toDay) : undefined
  if (from && to && from.getTime() >= to.getTime()) return { from }
  return { from, to }
}
