import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AUDIT_ACTION_LABELS,
  OPERATION_AUDIT_ACTIONS,
  operationAuditQuerySchema,
  type OperationAuditAction,
} from '@cairn/shared'
import { DateRangePicker, type DateRange } from '@/components/date-range-picker'
import { CursorPagination } from '@/components/data-table'
import { TruncatedText } from '@/components/truncated-text'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { fetchOperationAudit } from '@/lib/rbac-api'
import { AuditRecordCard } from './record-card'
import { dateRange, rangeToDayKeys } from './range'

export function OperationsAuditPanel({ header }: { header?: ReactNode }) {
  const [action, setAction] = useState<string>('all')
  const [range, setRange] = useState<DateRange | undefined>()
  const page = useCursorPage()
  const { fromDay, toDay } = rangeToDayKeys(range)
  const filters = useMemo(
    () =>
      operationAuditQuerySchema.parse({
        action: action === 'all' ? undefined : action,
        ...dateRange(fromDay, toDay),
        limit: page.pageSize,
      }),
    [action, fromDay, toDay, page.pageSize],
  )

  useEffect(() => {
    page.reset()
  }, [action, fromDay, toDay, page.reset])

  const audit = useQuery({
    queryKey: ['audit', 'operations', filters, page.cursor],
    queryFn: () => fetchOperationAudit({ ...filters, cursor: page.cursor }),
    placeholderData: keepPreviousData,
  })
  const items = audit.data?.items ?? []
  const filtered = Boolean(filters.action || filters.from || filters.to)
  const showPager = items.length > 0 || page.pageIndex > 0

  return (
    <AuditRecordCard
      ariaLabel='操作记录'
      header={header}
      toolbar={
        <>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className='h-8 w-44' aria-label='动作'>
              <SelectValue placeholder='全部动作' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部动作</SelectItem>
              {OPERATION_AUDIT_ACTIONS.map((code) => (
                <SelectItem key={code} value={code}>
                  {AUDIT_ACTION_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DateRangePicker value={range} onChange={setRange} />
        </>
      }
      pending={audit.isPending}
      error={audit.isError}
      errorTitle='无法加载操作记录'
      onRetry={() => {
        void audit.refetch()
      }}
      empty={items.length === 0}
      emptyTitle={filtered ? '没有符合筛选条件的记录' : '还没有操作记录'}
      emptyDescription={
        filtered
          ? '试试放宽动作或日期范围。'
          : '身份、权限、目标系统和运行变更会显示在这里。'
      }
      footer={
        showPager ? (
          <CursorPagination
            pageIndex={page.pageIndex}
            pageSize={page.pageSize}
            hasPreviousPage={page.pageIndex > 0}
            hasNextPage={Boolean(audit.data?.nextCursor)}
            updating={audit.isFetching && audit.isPlaceholderData}
            onPageSizeChange={page.setPageSize}
            onPreviousPage={page.goPrev}
            onNextPage={() => {
              if (audit.data?.nextCursor) page.goNext(audit.data.nextCursor)
            }}
          />
        ) : null
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead>
            <TableHead>操作者</TableHead>
            <TableHead>动作</TableHead>
            <TableHead>摘要</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((event) => (
            <TableRow key={event.id}>
              <TableCell className='whitespace-nowrap text-body'>
                {new Date(event.createdAt).toLocaleString()}
              </TableCell>
              <TableCell>
                <div className='text-body'>{event.actor?.displayName ?? '系统'}</div>
                {event.actor?.email && (
                  <div className='text-label text-muted-foreground'>{event.actor.email}</div>
                )}
              </TableCell>
              <TableCell>
                <div className='text-body'>
                  {AUDIT_ACTION_LABELS[event.action as OperationAuditAction] ?? event.action}
                </div>
                <div className='text-label text-muted-foreground'>{event.action}</div>
              </TableCell>
              <TableCell className='max-w-md'>
                <TruncatedText className='text-body text-text-secondary' text={event.summary} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </AuditRecordCard>
  )
}

export { OperationsAuditPanel as OperationsAuditPage }
