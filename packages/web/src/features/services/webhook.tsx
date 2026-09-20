import { useEffect, useId, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SERVICE_WEBHOOK_EVENTS,
  type ServiceWebhookDeliveryStatus,
  type ServiceWebhookEvent,
} from '@cairn/shared'
import { RefreshCw, RotateCcw, Save } from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchServiceWebhook,
  fetchServiceWebhookDeliveries,
  retryServiceWebhookDelivery,
  saveServiceWebhook,
} from '@/lib/services-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'

const EVENT_LABELS: Record<ServiceWebhookEvent, string> = {
  'run.started': '运行开始',
  'run.completed': '运行完成',
  'run.failed': '运行失败',
  'run.cancelled': '运行取消',
}

const formatTime = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '—'

const statusMeta: Record<
  ServiceWebhookDeliveryStatus,
  { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'error' }
> = {
  pending: { label: '待投递', tone: 'neutral' },
  sending: { label: '投递中', tone: 'info' },
  retrying: { label: '等待重试', tone: 'warning' },
  success: { label: '已送达', tone: 'success' },
  dead_letter: { label: '死信', tone: 'error' },
}

const serviceWebhookKey = (callerId: string) =>
  ['service', callerId, 'webhook'] as const
const serviceWebhookDeliveriesKey = (callerId: string) =>
  ['service', callerId, 'webhook', 'deliveries'] as const

export function ServiceWebhookPanel({
  callerId,
  writable,
  archived,
}: {
  callerId: string
  writable: boolean
  archived: boolean
}) {
  const id = useId()
  const client = useQueryClient()
  const webhook = useQuery({
    queryKey: serviceWebhookKey(callerId),
    queryFn: () => fetchServiceWebhook(callerId),
  })
  const deliveries = useQuery({
    queryKey: serviceWebhookDeliveriesKey(callerId),
    queryFn: () => fetchServiceWebhookDeliveries(callerId, { limit: 20 }),
  })
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<ServiceWebhookEvent[]>([
    'run.completed',
    'run.failed',
    'run.cancelled',
  ])
  const [enabled, setEnabled] = useState(true)
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState<string>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (webhook.data === undefined) return
    if (!webhook.data) {
      setUrl('')
      setEvents(['run.completed', 'run.failed', 'run.cancelled'])
      setEnabled(true)
      setSecret('')
      return
    }
    setUrl(webhook.data.url)
    setEvents(webhook.data.events)
    setEnabled(webhook.data.status === 'active')
    setSecret('')
  }, [webhook.data])

  const editable = writable && !archived
  const refresh = () => {
    void webhook.refetch()
    void deliveries.refetch()
  }

  function toggleEvent(event: ServiceWebhookEvent, checked: boolean) {
    setEvents((current) =>
      checked ? [...current, event] : current.filter((item) => item !== event)
    )
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editable) return
    setError('')
    if (!webhook.data && !secret.trim()) {
      setError('首次登记 Webhook 时必须填写签名密钥。')
      return
    }
    setSaving(true)
    try {
      await saveServiceWebhook(callerId, {
        url: url.trim(),
        events,
        enabled,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      })
      setSecret('')
      await Promise.all([
        client.invalidateQueries({ queryKey: serviceWebhookKey(callerId) }),
        client.invalidateQueries({
          queryKey: serviceWebhookDeliveriesKey(callerId),
        }),
      ])
      toast.success('Webhook 配置已保存')
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '保存 Webhook 配置失败'
      )
    } finally {
      setSaving(false)
    }
  }

  async function retry(deliveryId: string) {
    if (!editable) return
    setRetrying(deliveryId)
    try {
      await retryServiceWebhookDelivery(callerId, deliveryId)
      await client.invalidateQueries({
        queryKey: serviceWebhookDeliveriesKey(callerId),
      })
      toast.success('已重新排队投递')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '重新投递失败')
    } finally {
      setRetrying(undefined)
    }
  }

  return (
    <div className='space-y-6' aria-label='Webhook 配置与投递记录'>
      <section className='rounded-lg border border-border-card bg-card p-4 sm:p-5'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h3 className='text-section font-semibold'>Webhook 配置</h3>
            <p className='mt-1 max-w-3xl text-small text-muted-foreground'>
              Worker 会独立投递运行事件。接收地址必须是可公开访问的 HTTPS
              地址，投递失败不会改变 Run 的执行结果。
            </p>
          </div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={refresh}
            disabled={webhook.isFetching || deliveries.isFetching}
          >
            <RefreshCw />
            刷新
          </Button>
        </div>
        {webhook.isPending ? (
          <div className='mt-5'>
            <PageSkeleton rows={3} />
          </div>
        ) : webhook.isError ? (
          <div className='mt-5'>
            <QueryErrorState
              title='无法加载 Webhook 配置'
              onRetry={() => void webhook.refetch()}
            />
          </div>
        ) : (
          <form
            className='mt-5 space-y-5'
            onSubmit={(event) => void submit(event)}
          >
            <label htmlFor={`${id}-url`} className='block space-y-2 text-small'>
              <span>接收地址</span>
              <Input
                id={`${id}-url`}
                type='url'
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder='https://example.com/cairn/webhook'
                autoComplete='url'
                required
                disabled={!editable || saving}
              />
            </label>
            <fieldset className='space-y-2'>
              <legend className='text-small'>订阅事件</legend>
              <div className='flex flex-wrap gap-x-5 gap-y-2'>
                {SERVICE_WEBHOOK_EVENTS.map((event) => (
                  <label
                    key={event}
                    className='flex min-h-8 items-center gap-2 text-small'
                  >
                    <input
                      type='checkbox'
                      checked={events.includes(event)}
                      onChange={(input) =>
                        toggleEvent(event, input.target.checked)
                      }
                      disabled={!editable || saving}
                    />
                    {EVENT_LABELS[event]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label
              htmlFor={`${id}-secret`}
              className='block space-y-2 text-small'
            >
              <span>签名密钥</span>
              <Input
                id={`${id}-secret`}
                type='password'
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={
                  webhook.data?.secretConfigured
                    ? '已配置；填写新值以重置'
                    : '首次登记时必填'
                }
                autoComplete='new-password'
                disabled={!editable || saving}
              />
              <span className='block text-muted-foreground'>
                密钥仅用于生成 HMAC-SHA256 签名，保存后不会再次显示。
              </span>
            </label>
            <div className='flex flex-wrap items-center justify-between gap-3 border-t pt-4'>
              <label className='flex min-h-10 items-center gap-2 text-small'>
                <Switch
                  checked={enabled}
                  aria-label='启用 Webhook'
                  onCheckedChange={setEnabled}
                  disabled={!editable || saving}
                />
                {enabled ? '启用事件投递' : '停用事件投递'}
              </label>
              {editable ? (
                <Button type='submit' disabled={saving || events.length === 0}>
                  <Save />
                  {saving ? '保存中…' : '保存配置'}
                </Button>
              ) : null}
            </div>
            {archived ? (
              <p className='text-small text-status-warning-foreground'>
                已归档调用方只能查看配置与历史投递，不能修改或重新投递。
              </p>
            ) : null}
            {error ? (
              <p className='text-small text-destructive'>{error}</p>
            ) : null}
          </form>
        )}
      </section>

      <section className='space-y-4'>
        <div>
          <h3 className='text-section font-semibold'>投递记录</h3>
          <p className='mt-1 text-small text-muted-foreground'>
            仅记录受控的响应摘要。死信可以由有服务写权限的管理员显式重新推送。
          </p>
        </div>
        {deliveries.isPending ? (
          <PageSkeleton rows={4} />
        ) : deliveries.isError ? (
          <QueryErrorState
            title='无法加载 Webhook 投递记录'
            onRetry={() => void deliveries.refetch()}
          />
        ) : !deliveries.data?.items.length ? (
          <EmptyState
            title='尚无投递记录'
            description='启用 Webhook 后，后续运行的订阅事件会显示在这里。'
          />
        ) : (
          <div className='overflow-x-auto rounded-lg border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>事件 / Run</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>尝试</TableHead>
                  <TableHead>响应</TableHead>
                  <TableHead>下次动作</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.data.items.map((delivery) => {
                  const meta = statusMeta[delivery.status]
                  return (
                    <TableRow key={delivery.id}>
                      <TableCell className='min-w-52'>
                        <div className='font-medium'>
                          {EVENT_LABELS[delivery.eventType]}
                        </div>
                        <code className='mt-1 block max-w-56 truncate text-xs text-muted-foreground'>
                          {delivery.runId}
                        </code>
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                      </TableCell>
                      <TableCell>
                        {delivery.attempts} / {delivery.maxAttempts}
                        {delivery.replayCount
                          ? ` · 重放 ${delivery.replayCount}`
                          : ''}
                      </TableCell>
                      <TableCell className='max-w-72 whitespace-normal'>
                        {delivery.lastResponseCode ? (
                          <span>HTTP {delivery.lastResponseCode}</span>
                        ) : null}
                        {delivery.lastError ? (
                          <p className='mt-1 text-small break-words text-muted-foreground'>
                            {delivery.lastError}
                          </p>
                        ) : null}
                        {delivery.lastResponseBody ? (
                          <details className='mt-1'>
                            <summary className='cursor-pointer text-small text-muted-foreground'>
                              查看响应摘要
                            </summary>
                            <pre className='mt-1 max-h-28 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap'>
                              {delivery.lastResponseBody}
                            </pre>
                          </details>
                        ) : null}
                        {!delivery.lastResponseCode &&
                        !delivery.lastError &&
                        !delivery.lastResponseBody
                          ? '—'
                          : null}
                      </TableCell>
                      <TableCell>
                        {delivery.status === 'retrying'
                          ? formatTime(delivery.nextRetryAt)
                          : formatTime(delivery.updatedAt)}
                      </TableCell>
                      <TableCell className='text-right'>
                        {delivery.status === 'dead_letter' && editable ? (
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            onClick={() => void retry(delivery.id)}
                            disabled={retrying === delivery.id}
                          >
                            <RotateCcw />
                            {retrying === delivery.id ? '处理中…' : '重新投递'}
                          </Button>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {deliveries.data?.nextCursor ? (
          <p className='text-small text-muted-foreground'>
            当前展示最近 20 条投递记录。
          </p>
        ) : null}
      </section>
    </div>
  )
}
