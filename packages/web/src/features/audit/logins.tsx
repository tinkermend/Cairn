import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AUDIT_CLIENT_KIND_LABELS,
  LOGIN_FAILURE_REASON_LABELS,
  loginAuditQuerySchema,
} from '@cairn/shared'
import { DateRangePicker, type DateRange } from '@/components/date-range-picker'
import { CursorPagination } from '@/components/data-table'
import { StatusBadge } from '@/components/status-badge'
import { TruncatedText } from '@/components/truncated-text'
import { Input } from '@/components/ui/input'
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
import { fetchLoginAudit } from '@/lib/rbac-api'
import { AuditRecordCard } from './record-card'
import { dateRange, rangeToDayKeys } from './range'

export function LoginsAuditPanel({ header }: { header?: ReactNode }) {
  const [outcome, setOutcome] = useState<string>('all')
  const [identifier, setIdentifier] = useState('')
  const [range, setRange] = useState<DateRange | undefined>()
  const page = useCursorPage()
  const { fromDay, toDay } = rangeToDayKeys(range)
  const filters = useMemo(
    () =>
      loginAuditQuerySchema.parse({
        outcome: outcome === 'all' ? undefined : outcome,
        identifier: identifier.trim().slice(0, 64) || undefined,
        ...dateRange(fromDay, toDay),
        limit: page.pageSize,
      }),
    [outcome, identifier, fromDay, toDay, page.pageSize],
  )

  useEffect(() => {
    page.reset()
  }, [outcome, identifier, fromDay, toDay, page.reset])

  const audit = useQuery({
    queryKey: ['audit', 'logins', filters, page.cursor],
    queryFn: () => fetchLoginAudit({ ...filters, cursor: page.cursor }),
    placeholderData: keepPreviousData,
  })
  const items = audit.data?.items ?? []
  const filtered = Boolean(filters.outcome || filters.identifier || filters.from || filters.to)
  const showPager = items.length > 0 || page.pageIndex > 0

  return (
    <AuditRecordCard
      ariaLabel='登录记录'
      header={header}
      toolbar={
        <>
          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger className='h-8 w-36' aria-label='结果'>
              <SelectValue placeholder='全部结果' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部结果</SelectItem>
              <SelectItem value='success'>成功</SelectItem>
              <SelectItem value='failure'>失败</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className='h-8 w-48'
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            aria-label='账户'
            placeholder='账户'
          />
          <DateRangePicker value={range} onChange={setRange} />
        </>
      }
      pending={audit.isPending}
      error={audit.isError}
      errorTitle='无法加载登录记录'
      onRetry={() => {
        void audit.refetch()
      }}
      empty={items.length === 0}
      emptyTitle={filtered ? '没有符合筛选条件的记录' : '还没有登录记录'}
      emptyDescription={
        filtered ? '试试放宽结果、账户或日期范围。' : '控制台和扩展的登录尝试会显示在这里。'
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
            <TableHead>账户</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>失败原因</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>客户端</TableHead>
            <TableHead className='min-w-56 max-w-72'>User-Agent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((event) => (
            <TableRow key={event.id}>
              <TableCell className='whitespace-nowrap text-body'>
                {new Date(event.createdAt).toLocaleString()}
              </TableCell>
              <TableCell>
                <div className='text-body'>{event.loginIdentifier}</div>
                {event.actor?.displayName && (
                  <div className='text-label text-muted-foreground'>{event.actor.displayName}</div>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge tone={event.outcome === 'success' ? 'success' : 'error'}>
                  {event.outcome === 'success' ? '成功' : '失败'}
                </StatusBadge>
              </TableCell>
              <TableCell className='text-body'>
                {event.failureReason ? LOGIN_FAILURE_REASON_LABELS[event.failureReason] : ''}
              </TableCell>
              <TableCell className='whitespace-nowrap text-body'>
                {event.clientIp ?? '未知'}
              </TableCell>
              <TableCell className='text-body'>
                {AUDIT_CLIENT_KIND_LABELS[event.clientKind]}
              </TableCell>
              <TableCell className='min-w-56 max-w-72'>
                <TruncatedText text={event.userAgent ?? ''} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </AuditRecordCard>
  )
}

export { LoginsAuditPanel as LoginsAuditPage }
