import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type NotificationStatus } from '@cairn/shared'
import { toast } from 'sonner'
import {
  fetchNotificationEvent,
  fetchNotificationEvents,
  notificationReceipt,
  notificationCommandKey,
  postNotification,
  subscribeNotifications,
} from '@/lib/notifications-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/status-badge'
import {
  RUN_EXECUTION_AXIS_LABELS,
  RUN_OUTCOME_STATUS_LABELS,
} from '@/features/runs/outcome-labels'
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
  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='通知管理'
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
        <TabsList className='mb-5 flex h-auto w-full flex-wrap justify-start gap-1 sm:w-fit'>
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
}: {
  runId?: string
  alertId?: string
}) {
  const [type, setType] = useState(''),
    [status, setStatus] = useState(''),
    [targetId, setTargetId] = useState('')
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [cursor, setCursor] = useState<string>()
  const [detailId, setDetailId] = useState<string>(),
    [streamError, setStreamError] = useState(''),
    [refresh, setRefresh] = useState(0)
  const client = useQueryClient()
  const [targetSearch, setTargetSearch] = useState('')
  const canTargets = useCan('target:read')
  const targets = useQuery({
    queryKey: ['notification-targets', targetSearch],
    queryFn: () => fetchTargets({ search: targetSearch, limit: 100 }),
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
    }),
    [type, status, targetId, runId, alertId, from, to]
  )
  const query = useMemo(() => ({ ...filter, cursor }), [filter, cursor])
  const list = useQuery({
    queryKey: ['notifications', query],
    queryFn: () => fetchNotificationEvents(query),
  })
  useEffect(() => {
    setCursor(undefined)
  }, [filter])
  useEffect(() => {
    const abort = new AbortController()
    setStreamError('')
    void subscribeNotifications(query, abort.signal, (value) => {
      client.setQueryData(['notifications', query], value)
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
  }, [query, client, refresh])
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-end gap-3'>
        <Field label='通知类型'>
          <select
            className='h-9 rounded-md border border-input bg-background px-3'
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value=''>全部</option>
            <option value='run'>运行结果</option>
            <option value='alert'>告警</option>
            <option value='test'>渠道测试</option>
          </select>
        </Field>
        <Field label='投递状态'>
          <select
            className='h-9 rounded-md border border-input bg-background px-3'
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value=''>全部</option>
            {Object.entries(statusLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {canTargets && (
          <Field label='目标'>
            <Input
              aria-label='搜索通知目标'
              value={targetSearch}
              onChange={(e) => setTargetSearch(e.target.value)}
              placeholder='搜索目标名称'
            />
            <select
              className='h-9 max-w-56 rounded-md border border-input bg-background px-3'
              aria-label='筛选通知目标'
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value=''>全部目标</option>
              {targets.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label='开始时间'>
          <Input
            type='datetime-local'
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label='结束时间'>
          <Input
            type='datetime-local'
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Button
          variant='outline'
          onClick={() => {
            setRefresh((v) => v + 1)
            void list.refetch()
          }}
        >
          刷新
        </Button>
      </div>
      {(runId || alertId) && (
        <p className='text-label text-muted-foreground'>
          当前仅显示此{runId ? '运行' : '告警'}的通知。
          <Link
            to='/notifications'
            search={{ tab: 'records' }}
            className='ml-2 underline'
          >
            查看全部
          </Link>
        </p>
      )}
      <Failure message={list.error?.message || streamError} />
      {list.isPending ? (
        <p role='status'>正在加载通知…</p>
      ) : list.data?.items.length === 0 ? (
        <div className='rounded-lg border border-dashed p-8 text-center text-muted-foreground'>
          暂无符合条件的通知。启用结果通知或告警规则后，记录会显示在这里。
        </div>
      ) : null}
      <div className='space-y-3'>
        {list.data?.items.map((event) => (
          <article
            key={event.id}
            className='rounded-lg border border-border p-4'
          >
            <div className='flex flex-wrap items-start justify-between gap-2'>
              <div className='min-w-0'>
                <h2 className='text-body font-semibold break-words'>
                  {event.payload?.title ??
                    (event.type === 'run.finished' ? '运行结果通知' : '通知')}
                </h2>
                <p className='mt-1 text-label text-muted-foreground'>
                  {new Date(event.occurredAt).toLocaleString()} ·{' '}
                  {stateLabels[event.state]}
                </p>
              </div>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setDetailId(event.id)}
              >
                查看详情
              </Button>
            </div>
            <div className='mt-3 flex flex-wrap gap-2'>
              {event.deliveries.map((d) => (
                <StatusBadge
                  key={d.id}
                  tone={
                    d.status === 'accepted'
                      ? 'success'
                      : ['failed', 'unknown'].includes(d.status)
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {d.channelName} · {statusLabels[d.status]}
                </StatusBadge>
              ))}
            </div>
            {event.reason && (
              <p className='mt-2 text-label text-muted-foreground'>
                {reasonLabel(event.reason)}
              </p>
            )}
          </article>
        ))}
      </div>
      <div className='flex justify-end gap-2'>
        <Button
          variant='outline'
          disabled={!cursor}
          onClick={() => setCursor(undefined)}
        >
          返回首页
        </Button>
        <Button
          variant='outline'
          disabled={!list.data?.nextCursor}
          onClick={() => setCursor(list.data?.nextCursor ?? undefined)}
        >
          下一页
        </Button>
      </div>
      <Dialog
        open={Boolean(detailId)}
        onOpenChange={(open) => {
          if (!open) setDetailId(undefined)
        }}
      >
        <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>通知详情</DialogTitle>
            <DialogDescription>
              “对方已接受”表示服务器接收成功，不代表邮件已读。
            </DialogDescription>
          </DialogHeader>
          {detailId && <NotificationDetail id={detailId} />}
        </DialogContent>
      </Dialog>
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
    <div className='space-y-4'>
      <Failure message={detail.error?.message || error} />
      {event && (
        <>
          <p className='text-body font-medium'>
            {event.payload?.title ?? stateLabels[event.state]}
          </p>
          {event.payload?.status && (
            <dl className='grid grid-cols-2 gap-2 text-body'>
              <dt>执行状态</dt>
              <dd>{RUN_EXECUTION_AXIS_LABELS[event.payload.status]}</dd>
              <dt>业务结果</dt>
              <dd>
                {event.payload.outcomeStatus &&
                  RUN_OUTCOME_STATUS_LABELS[event.payload.outcomeStatus]}
              </dd>
              <dt>证据状态</dt>
              <dd>
                {event.payload.evidenceStatus &&
                  {
                    PENDING: '证据收集中',
                    COMPLETE: '证据完整',
                    INCOMPLETE: '证据不完整',
                  }[event.payload.evidenceStatus]}
              </dd>
            </dl>
          )}
          {event.payload?.summaryStage === 'evidence_pending' && (
            <p className='text-label text-muted-foreground'>
              汇总时证据仍在收集，后续补齐不会再次通知。
            </p>
          )}
          {event.runId && (
            <Button variant='outline' asChild>
              <Link to='/runs/$runId' params={{ runId: event.runId }}>
                查看运行
              </Link>
            </Button>
          )}
          {event.alertId && (
            <Button variant='outline' asChild>
              <Link to='/monitoring'>查看告警</Link>
            </Button>
          )}
          {event.deliveries.map((d) => (
            <section
              key={d.id}
              className='space-y-2 rounded-md border border-border p-3'
            >
              <div className='flex flex-wrap justify-between gap-2'>
                <strong className='text-body'>{d.channelName}</strong>
                <StatusBadge
                  tone={
                    d.status === 'accepted'
                      ? 'success'
                      : d.status === 'failed'
                        ? 'error'
                        : d.status === 'unknown'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {statusLabels[d.status]}
                  {d.closedAt ? ' · 已结案' : ''}
                </StatusBadge>
              </div>
              <p className='text-label break-all text-muted-foreground'>
                {d.recipientLabel} · 自动尝试 {d.automaticAttemptCount}/5
              </p>
              {d.reason && (
                <p className='text-label'>{reasonLabel(d.reason)}</p>
              )}
              {d.nextAttemptAt && (
                <p className='text-label'>
                  计划重试：{new Date(d.nextAttemptAt).toLocaleString()}
                </p>
              )}
              {d.attempts?.map((a) => (
                <p key={a.id} className='text-label text-muted-foreground'>
                  第 {a.attemptNo} 次 ·{' '}
                  {a.origin === 'manual' ? '人工' : '自动'} ·{' '}
                  {a.result ? statusLabels[a.result] : '进行中'}
                  {a.errorCode ? ` · ${reasonLabel(a.errorCode)}` : ''}
                </p>
              ))}
              {canOperate &&
                (!event.alertId || canMonitor) &&
                !d.closedAt &&
                ['failed', 'unknown'].includes(d.status) && (
                  <div className='flex gap-2'>
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
          {operation && (
            <section className='space-y-3 rounded-md border border-border p-3'>
              <h3 className='font-semibold'>
                {operation.action === 'retry' ? '确认再次发送' : '确认结案'}
              </h3>
              <Field label='处理原因'>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={512}
                />
              </Field>
              {operation.unknown && operation.action === 'retry' && (
                <label className='flex items-start gap-2 text-body'>
                  <input
                    type='checkbox'
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  原发送可能已被接受，我确认再次发送可能产生重复通知。
                </label>
              )}
              <div className='flex gap-2'>
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
