import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type NotificationStatus } from '@cairn/shared'
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ExternalLink,
  Radio,
  RefreshCw,
  Send,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchNotificationChannels,
  fetchNotificationEvent,
  fetchNotificationEvents,
  notificationCommandKey,
  notificationReceipt,
  postNotification,
  subscribeNotifications,
} from '@/lib/notifications-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CollectionSummary } from '@/components/collection-summary'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/status-badge'
import {
  RUN_EXECUTION_AXIS_LABELS,
  RUN_OUTCOME_STATUS_LABELS,
} from '@/features/runs/outcome-labels'
import { cn } from '@/lib/utils'
import { NotificationChannelsPanel } from './channels'
import { NotificationRulesPanel, NotificationAlertRules } from './rules'

export const statusLabels: Record<NotificationStatus, string> = {
  pending: '等待发送',
  sending: '正在发送',
  retry_wait: '等待重试',
  accepted: '对方已接受',
  failed: '发送失败',
  unknown: '结果不明',
  suppressed: '已停止发送',
}

export const stateLabels = {
  waiting_result: '等待结果汇总',
  filtered: '未满足通知条件',
  suppressed: '已停止发送',
  ready: '已生成摘要',
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className='grid gap-2 text-label'>
      <span className='font-medium'>{label}</span>
      {children}
      {hint && <span className='text-muted-foreground'>{hint}</span>}
    </label>
  )
}

export function Failure({ message }: { message?: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (message) ref.current?.focus()
  }, [message])
  return message ? (
    <p
      ref={ref}
      tabIndex={-1}
      role='alert'
      className='rounded-md border border-destructive/30 bg-destructive/5 p-3 text-body text-destructive'
    >
      {message}
    </p>
  ) : null
}

export function NotificationsPage() {
  const search = useSearch({ from: '/_authenticated/notifications/' }),
    navigate = useNavigate()
  const canRead = useCan('notification:read'),
    canConfig = useCan('platform-config:read'),
    canWorkflow = useCan('workflow:read'),
    canMonitor = useCan('monitor:read')
  const tab =
    search.tab ?? (canRead ? 'records' : canConfig ? 'channels' : 'results')

  const channelsQuery = useQuery({
    queryKey: ['notification-channels'],
    queryFn: () => fetchNotificationChannels(),
    enabled: canConfig,
  })

  const channelsItems = channelsQuery.data?.channels ?? []
  const activeChannelsCount = channelsItems.filter(
    (c) => c.enabled && !c.revoked
  ).length

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='通知'
        description='集中管理场景运行结果、告警与发送渠道。每个目的地的投递结果独立记录。'
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            to: '/notifications',
            search: { ...search, tab: value },
          })
        }
      >
        <TabsList className='border-b-0'>
          {canRead && <TabsTrigger value='records'>通知记录</TabsTrigger>}
          {canWorkflow && <TabsTrigger value='results'>结果通知</TabsTrigger>}
          {canMonitor && <TabsTrigger value='alerts'>告警通知</TabsTrigger>}
          {canConfig && <TabsTrigger value='channels'>通知渠道</TabsTrigger>}
        </TabsList>
        <TabsContent value='records'>
          {canRead && (
            <NotificationRecords
              runId={search.runId}
              alertId={search.alertId}
              activeChannelsCount={activeChannelsCount}
            />
          )}
        </TabsContent>
        <TabsContent value='results'>
          {canWorkflow && (
            <NotificationRulesPanel scenarioId={search.scenarioId} />
          )}
        </TabsContent>
        <TabsContent value='alerts'>
          {canMonitor && <NotificationAlertRules />}
        </TabsContent>
        <TabsContent value='channels'>
          {canConfig && <NotificationChannelsPanel />}
        </TabsContent>
      </Tabs>
    </Main>
  )
}

function NotificationRecords({
  runId,
  alertId,
  activeChannelsCount,
}: {
  runId?: string
  alertId?: string
  activeChannelsCount: number
}) {
  const page = useCursorPage()
  const [type, setType] = useState(''),
    [status, setStatus] = useState(''),
    [targetId, setTargetId] = useState('')
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const [detailId, setDetailId] = useState<string>(),
    [streamError, setStreamError] = useState(''),
    [refresh, setRefresh] = useState(0)
  const client = useQueryClient()
  const canTargets = useCan('target:read')

  const targets = useQuery({
    queryKey: ['notification-targets'],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canTargets,
  })

  const filter = useMemo(
    () => ({
      type: type || undefined,
      status: status || undefined,
      targetId: targetId || undefined,
      runId,
      alertId,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [type, status, targetId, runId, alertId, from, to, page.pageSize, page.cursor]
  )

  const list = useQuery({
    queryKey: ['notifications', filter],
    queryFn: () => fetchNotificationEvents(filter),
  })

  useEffect(() => {
    const abort = new AbortController()
    setStreamError('')
    void subscribeNotifications(filter, abort.signal, (value) => {
      client.setQueryData(['notifications', filter], value)
    })
      .then(() => {
        if (!abort.signal.aborted)
          setStreamError('实时连接已断开，刷新以重连。')
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setStreamError('实时连接暂不可用，已保留最近记录。')
      })
    return () => abort.abort()
  }, [filter, client, refresh])

  const handleStatusChange = (val: string) => {
    setStatus(val)
    page.reset()
  }

  const handleTypeChange = (val: string) => {
    setType(val === 'all' ? '' : val)
    page.reset()
  }

  const handleTargetChange = (val: string) => {
    setTargetId(val === 'all' ? '' : val)
    page.reset()
  }

  const items = list.data?.items ?? []
  const acceptedCount = items.filter((e) =>
    e.deliveries.some((d) => d.status === 'accepted')
  ).length
  const issueCount = items.filter((e) =>
    e.deliveries.some((d) => ['failed', 'unknown'].includes(d.status))
  ).length

  return (
    <div className='space-y-4'>
      <CollectionSummary
        items={[
          {
            label: '本页记录',
            value: items.length,
            description: '当前已加载的通知事件',
            icon: <Bell className='size-4 text-primary' />,
          },
          {
            label: '对方已接受',
            value: acceptedCount,
            description: '服务器成功接收的通知',
            icon: (
              <CheckCircle2 className='size-4 text-status-success-foreground' />
            ),
          },
          {
            label: '待处理异常',
            value: issueCount,
            description: '发送失败或结果不明的项',
            icon: (
              <AlertTriangle className='size-4 text-status-warning-foreground' />
            ),
          },
          {
            label: '可用渠道',
            value: activeChannelsCount,
            description: '已启用且未撤销的渠道',
            icon: <Radio className='size-4 text-primary' />,
          },
        ]}
      />
      <div className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
        <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
          <div className='flex flex-wrap gap-1' aria-label='投递状态筛选'>
            {[
              ['', '全部状态'],
              ['accepted', '对方已接受'],
              ['failed', '发送失败'],
              ['unknown', '结果不明'],
              ['retry_wait', '等待重试'],
            ].map(([val, label]) => (
              <Button
                key={val}
                variant={status === val ? 'secondary' : 'ghost'}
                size='sm'
                onClick={() => handleStatusChange(val)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Select value={type || 'all'} onValueChange={handleTypeChange}>
              <SelectTrigger className='h-8 w-32' aria-label='通知类型'>
                <SelectValue placeholder='全部类型' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部类型</SelectItem>
                <SelectItem value='run'>运行结果</SelectItem>
                <SelectItem value='alert'>告警通知</SelectItem>
                <SelectItem value='test'>渠道测试</SelectItem>
              </SelectContent>
            </Select>
            {canTargets && (
              <Select
                value={targetId || 'all'}
                onValueChange={handleTargetChange}
              >
                <SelectTrigger className='h-8 w-36' aria-label='目标系统'>
                  <SelectValue placeholder='全部目标' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部目标</SelectItem>
                  {targets.data?.items.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant='outline'
              size='sm'
              className='h-8'
              onClick={() => {
                setRefresh((v) => v + 1)
                void list.refetch()
              }}
            >
              <RefreshCw
                className={cn('size-3.5', list.isFetching && 'animate-spin')}
              />
              刷新
            </Button>
          </div>
        </div>

        {(runId || alertId) && (
          <div className='border-b border-border-divider bg-surface-subtle px-4 py-2 text-label text-muted-foreground'>
            当前仅显示此{runId ? '运行' : '告警'}的通知。
            <Link
              to='/notifications'
              search={{ tab: 'records' }}
              className='ml-2 font-medium text-primary hover:underline'
            >
              查看全部记录
            </Link>
          </div>
        )}

        <Failure message={list.error?.message || streamError} />

        {list.isPending ? (
          <div className='p-8 text-center text-body text-muted-foreground'>
            正在加载通知…
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={
              status || type || targetId
                ? '没有匹配的通知记录'
                : '暂无符合条件的通知'
            }
            description={
              status || type || targetId
                ? '试试清除或调整筛选条件。'
                : '启用结果通知或告警规则后，记录会显示在这里。'
            }
            action={
              status || type || targetId ? (
                <Button
                  variant='outline'
                  onClick={() => {
                    setStatus('')
                    setType('')
                    setTargetId('')
                    setFrom('')
                    setTo('')
                    page.reset()
                  }}
                >
                  清除筛选
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[36%]'>事件 / 标题</TableHead>
                <TableHead className='w-[18%]'>触发时间</TableHead>
                <TableHead className='w-[14%]'>汇总状态</TableHead>
                <TableHead className='w-[22%]'>投递渠道与回执</TableHead>
                <TableHead className='w-[10%] text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((event) => (
                <TableRow
                  key={event.id}
                  className='cursor-pointer'
                  onClick={() => setDetailId(event.id)}
                >
                  <TableCell className='py-3'>
                    <div className='flex items-center gap-3'>
                      <span
                        aria-hidden='true'
                        className='flex size-8 shrink-0 items-center justify-center rounded-md border border-border-default bg-card text-primary'
                      >
                        {event.type === 'run.finished' ? (
                          <Workflow className='size-4' />
                        ) : event.type.startsWith('alert') ? (
                          <AlertTriangle className='size-4 text-status-warning-foreground' />
                        ) : event.type === 'channel.test' ? (
                          <Send className='size-4 text-muted-foreground' />
                        ) : (
                          <Bell className='size-4' />
                        )}
                      </span>
                      <div className='min-w-0'>
                        <p className='truncate font-medium text-text-primary text-body'>
                          {event.payload?.title ??
                            (event.type === 'run.finished'
                              ? '运行结果通知'
                              : '通知')}
                        </p>
                        <div className='mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                          {event.runId && (
                            <span>运行 #{event.runId.slice(0, 8)}</span>
                          )}
                          {event.alertId && (
                            <span>告警 #{event.alertId.slice(0, 8)}</span>
                          )}
                          {event.reason && (
                            <span>· {reasonLabel(event.reason)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className='text-label text-muted-foreground'>
                    {new Date(event.occurredAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      tone={
                        event.state === 'ready'
                          ? 'success'
                          : event.state === 'waiting_result'
                            ? 'info'
                            : event.state === 'suppressed'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {stateLabels[event.state]}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <div className='flex flex-wrap gap-1.5'>
                      {event.deliveries.map((d) => (
                        <StatusBadge
                          key={d.id}
                          tone={
                            d.status === 'accepted'
                              ? 'success'
                              : d.status === 'failed'
                                ? 'error'
                                : ['unknown', 'retry_wait'].includes(d.status)
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {d.channelName} · {statusLabels[d.status]}
                        </StatusBadge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className='text-right'>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={(e) => {
                        e.stopPropagation()
                        setDetailId(event.id)
                      }}
                    >
                      详情
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <div className='border-t border-border-divider p-4'>
          <CursorPagination
            pageIndex={page.pageIndex}
            pageSize={page.pageSize}
            hasPreviousPage={page.pageIndex > 0}
            hasNextPage={Boolean(list.data?.nextCursor)}
            updating={list.isFetching}
            onPageSizeChange={page.setPageSize}
            onPreviousPage={page.goPrev}
            onNextPage={() => {
              if (list.data?.nextCursor) page.goNext(list.data.nextCursor)
            }}
          />
        </div>
      </div>

      <Sheet
        open={Boolean(detailId)}
        onOpenChange={(open) => {
          if (!open) setDetailId(undefined)
        }}
      >
        <SheetContent className='w-full overflow-y-auto sm:max-w-xl'>
          <SheetHeader>
            <SheetTitle>通知详情</SheetTitle>
            <SheetDescription>
              “对方已接受”表示服务器接收成功，不代表邮件已读。
            </SheetDescription>
          </SheetHeader>
          {detailId && <NotificationDetail id={detailId} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function NotificationDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['notification-detail', id],
    queryFn: () => fetchNotificationEvent(id),
  })
  const canOperate = useCan('notification:operate'),
    canMonitor = useCan('monitor:operate'),
    client = useQueryClient()
  const [operation, setOperation] = useState<{
    deliveryId: string
    action: 'retry' | 'close'
    unknown: boolean
    key: string
  }>()
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')

  async function act() {
    if (!operation) return
    setBusy(true)
    setError('')
    try {
      await postNotification(
        `deliveries/${operation.deliveryId}/${operation.action}`,
        { idempotencyKey: operation.key, reason, confirmUnknown: confirmed },
        notificationReceipt
      )
      setOperation(undefined)
      await detail.refetch()
      await client.invalidateQueries({ queryKey: ['notifications'] })
      toast.success('操作已登记')
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const event = detail.data
  return (
    <div className='space-y-5 px-6 pb-6'>
      <Failure message={detail.error?.message || error} />
      {event && (
        <>
          <div className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
            <div className='flex items-start justify-between gap-2'>
              <div>
                <h3 className='font-semibold text-text-primary text-body'>
                  {event.payload?.title ?? stateLabels[event.state]}
                </h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  触发时间：{new Date(event.occurredAt).toLocaleString()} ·{' '}
                  {stateLabels[event.state]}
                </p>
              </div>
              <StatusBadge
                tone={
                  event.state === 'ready'
                    ? 'success'
                    : event.state === 'waiting_result'
                      ? 'info'
                      : event.state === 'suppressed'
                        ? 'warning'
                        : 'neutral'
                }
              >
                {stateLabels[event.state]}
              </StatusBadge>
            </div>

            {event.payload?.status && (
              <div className='mt-4 grid grid-cols-3 gap-2 border-t border-border-divider pt-3 text-center'>
                <div className='rounded-md bg-surface-subtle p-2'>
                  <p className='text-label text-muted-foreground'>执行状态</p>
                  <p className='mt-0.5 font-medium text-text-primary text-body'>
                    {RUN_EXECUTION_AXIS_LABELS[event.payload.status]}
                  </p>
                </div>
                <div className='rounded-md bg-surface-subtle p-2'>
                  <p className='text-label text-muted-foreground'>业务结果</p>
                  <p className='mt-0.5 font-medium text-text-primary text-body'>
                    {event.payload.outcomeStatus
                      ? RUN_OUTCOME_STATUS_LABELS[event.payload.outcomeStatus]
                      : '—'}
                  </p>
                </div>
                <div className='rounded-md bg-surface-subtle p-2'>
                  <p className='text-label text-muted-foreground'>证据状态</p>
                  <p className='mt-0.5 font-medium text-text-primary text-body'>
                    {event.payload.evidenceStatus
                      ? {
                          PENDING: '收集中',
                          COMPLETE: '完整',
                          INCOMPLETE: '不完整',
                        }[event.payload.evidenceStatus]
                      : '—'}
                  </p>
                </div>
              </div>
            )}

            {event.payload?.summaryStage === 'evidence_pending' && (
              <p className='mt-3 text-label text-status-warning-foreground'>
                汇总时证据仍在收集，后续补齐不会再次通知。
              </p>
            )}

            <div className='mt-4 flex flex-wrap gap-2'>
              {event.runId && (
                <Button size='sm' variant='outline' asChild>
                  <Link to='/runs/$runId' params={{ runId: event.runId }}>
                    <ExternalLink className='size-3.5' />
                    查看对应运行
                  </Link>
                </Button>
              )}
              {event.alertId && (
                <Button size='sm' variant='outline' asChild>
                  <Link to='/monitoring'>
                    <ExternalLink className='size-3.5' />
                    查看对应告警
                  </Link>
                </Button>
              )}
            </div>
          </div>

          <div className='space-y-3'>
            <h4 className='font-semibold text-text-primary text-section'>
              投递渠道与尝试记录
            </h4>
            {event.deliveries.map((d) => (
              <section
                key={d.id}
                className='space-y-2.5 rounded-lg border border-border-card bg-card p-4 shadow-card'
              >
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <strong className='font-semibold text-text-primary text-body'>
                    {d.channelName}
                  </strong>
                  <StatusBadge
                    tone={
                      d.status === 'accepted'
                        ? 'success'
                        : d.status === 'failed'
                          ? 'error'
                          : ['unknown', 'retry_wait'].includes(d.status)
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {statusLabels[d.status]}
                    {d.closedAt ? ' · 已结案' : ''}
                  </StatusBadge>
                </div>
                <p className='text-label text-muted-foreground break-all'>
                  接收方：{d.recipientLabel} · 自动尝试{' '}
                  {d.automaticAttemptCount}/5 次
                </p>
                {d.reason && (
                  <p className='text-label text-destructive'>
                    原因：{reasonLabel(d.reason)}
                  </p>
                )}
                {d.nextAttemptAt && (
                  <p className='text-label text-muted-foreground'>
                    计划重试时间：{new Date(d.nextAttemptAt).toLocaleString()}
                  </p>
                )}
                {d.attempts && d.attempts.length > 0 && (
                  <div className='mt-2 space-y-1 rounded-md bg-surface-subtle p-2.5'>
                    <p className='text-label font-medium text-muted-foreground'>
                      尝试记录：
                    </p>
                    {d.attempts.map((a) => (
                      <p
                        key={a.id}
                        className='text-label text-muted-foreground'
                      >
                        第 {a.attemptNo} 次 ·{' '}
                        {a.origin === 'manual' ? '人工重试' : '自动尝试'} ·{' '}
                        {a.result ? statusLabels[a.result] : '进行中'}
                        {a.errorCode ? ` · ${reasonLabel(a.errorCode)}` : ''}
                      </p>
                    ))}
                  </div>
                )}
                {canOperate &&
                  (!event.alertId || canMonitor) &&
                  !d.closedAt &&
                  ['failed', 'unknown'].includes(d.status) && (
                    <div className='mt-3 flex gap-2 border-t border-border-divider pt-3'>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => {
                          setOperation({
                            deliveryId: d.id,
                            action: 'retry',
                            unknown: d.status === 'unknown',
                            key: notificationCommandKey(),
                          })
                          setReason('')
                          setConfirmed(false)
                        }}
                      >
                        再次发送
                      </Button>
                      {d.status === 'unknown' && (
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => {
                            setOperation({
                              deliveryId: d.id,
                              action: 'close',
                              unknown: true,
                              key: notificationCommandKey(),
                            })
                            setReason('')
                            setConfirmed(false)
                          }}
                        >
                          结案
                        </Button>
                      )}
                    </div>
                  )}
              </section>
            ))}
          </div>

          {operation && (
            <section className='space-y-3 rounded-lg border border-border-card bg-surface-subtle p-4 shadow-card'>
              <h3 className='font-semibold text-text-primary text-body'>
                {operation.action === 'retry' ? '确认再次发送' : '确认结案'}
              </h3>
              <Field label='处理原因'>
                <Input
                  value={reason}
                  placeholder='填写操作原因以供审计'
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={512}
                />
              </Field>
              {operation.unknown && operation.action === 'retry' && (
                <label className='flex items-start gap-2 text-body'>
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(checked) => setConfirmed(Boolean(checked))}
                  />
                  <span>
                    原发送可能已被接受，我确认再次发送可能产生重复通知。
                  </span>
                </label>
              )}
              <div className='flex gap-2 pt-2'>
                <Button
                  disabled={
                    busy ||
                    !reason.trim() ||
                    (operation.unknown &&
                      operation.action === 'retry' &&
                      !confirmed)
                  }
                  onClick={() => void act()}
                >
                  确认{operation.action === 'retry' ? '发送' : '结案'}
                </Button>
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => setOperation(undefined)}
                >
                  取消
                </Button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export function reasonLabel(reason: string) {
  const labels: Record<string, string> = {
    authorization_revoked: '原发送授权已撤销',
    notifications_paused: '通知已暂停',
    channel_disabled: '渠道已停用',
    smtp_disabled: '邮件发送已停用',
    target_use_revoked: '目标授权已撤销',
    alert_use_revoked: '告警用途已撤销',
    source_deleted: '来源已删除',
    no_destination: '未选择发送渠道',
    conditions_not_matched: '未满足通知条件',
    webhook_rejected: 'Webhook 拒绝接收',
    webhook_receipt_unknown: 'Webhook 接收结果不明',
    smtp_receipt_unknown: '邮件服务器接收结果不明',
    smtp_destination_not_approved: 'SMTP 中继未在部署配置中许可',
    secret_missing: '发送凭据不可用',
    smtp_rejected: '邮件服务器拒绝接收',
    smtp_connect_failed: '邮件服务器连接未完成，将按策略重试',
    webhook_connect_failed: 'Webhook 连接未完成，将按策略重试',
    notification_preparation_failed: '通知准备失败，请检查渠道配置',
    secret_provider_unavailable: '凭据服务不可用',
    send_aborted: '提交前已取消，将按策略重试',
    legacy_unknown: '旧通知缺少完整回执，可核对后结案，不能直接重发',
    channel_disabled_at_capture: '生成消息时渠道已停用',
    alert_silenced: '告警已静默',
    destination_blocked: '目的地不符合网络访问策略',
  }
  return labels[reason] ?? reason
}
