import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  notificationChannelsResponseSchema,
  notificationChannelWriteSchema,
  notificationSettingsWriteSchema,
  notificationSmtpWriteSchema,
} from '@cairn/shared'
import { toast } from 'sonner'
import {
  fetchNotificationChannels,
  notificationReceipt,
  notificationCommandKey,
  postNotification,
  type NotificationChannels,
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
import { Field, Failure } from './index'

type Channel = NotificationChannels['channels'][number]
const selectClass = 'h-9 rounded-md border border-input bg-background px-3'
export function NotificationChannelsPanel() {
  const data = useQuery({
      queryKey: ['notification-channels'],
      queryFn: () => fetchNotificationChannels(),
    }),
    client = useQueryClient()
  const canWrite = useCan('platform-config:write')
  const [editing, setEditing] = useState<Channel | 'new'>(),
    [smtpOpen, setSmtpOpen] = useState(false)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{
    channel: Channel
    action: 'disable' | 'enable' | 'revoke' | 'test'
    key: string
  }>()
  const [reason, setReason] = useState('')
  async function changed() {
    await client.invalidateQueries({ queryKey: ['notification-channels'] })
    await client.invalidateQueries({ queryKey: ['notifications'] })
  }
  async function act() {
    if (!pending || !data.data) return
    setBusy(true)
    setError('')
    try {
      const c = pending.channel
      if (pending.action === 'test')
        await postNotification(
          `channels/${c.id}/test`,
          { reason, idempotencyKey: pending.key },
          notificationReceipt
        )
      else
        await postNotification(
          `channels/${c.id}/state`,
          {
            expectedRevision: data.data.revision,
            reason,
            ...(pending.action === 'revoke'
              ? { revokeVersion: c.version }
              : { enabled: pending.action === 'enable' }),
          },
          notificationChannelsResponseSchema
        )
      setPending(undefined)
      await changed()
      toast.success(
        pending.action === 'test'
          ? '测试已登记，请在通知记录查看结果'
          : '配置已更新'
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  const current = data.data
  return (
    <div className='space-y-6'>
      <Failure message={data.error?.message || error} />
      {data.isPending && <p role='status'>正在加载通知渠道…</p>}
      {current && (
        <>
          <Settings
            key={current.revision}
            current={current}
            canWrite={canWrite}
            onSaved={changed}
          />
          <section className='space-y-3'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h2 className='text-section font-semibold'>发送渠道</h2>
                <p className='text-label text-muted-foreground'>
                  授权到具体目标后，渠道才可用于该目标的场景。
                </p>
              </div>
              {canWrite && (
                <Button
                  disabled={current.channels.length >= 16}
                  onClick={() => setEditing('new')}
                >
                  添加渠道
                </Button>
              )}
            </div>
            {!current.channels.length && (
              <div className='rounded-lg border border-dashed p-6 text-body text-muted-foreground'>
                还没有通知渠道。添加 Webhook
                或邮件收件人后，可发送合成消息验证配置。
              </div>
            )}
            <div className='grid gap-3 lg:grid-cols-2'>
              {current.channels.map((channel) => (
                <article
                  key={channel.id}
                  className='space-y-3 rounded-lg border border-border p-4'
                >
                  <div className='flex flex-wrap justify-between gap-2'>
                    <h3 className='text-body font-semibold'>{channel.name}</h3>
                    <span className='text-label text-muted-foreground'>
                      {channel.kind === 'email' ? '邮件' : 'Webhook'} ·{' '}
                      {channel.revoked
                        ? '版本已撤销'
                        : channel.enabled
                          ? '启用'
                          : '停用'}
                    </span>
                  </div>
                  <p className='text-label break-all text-muted-foreground'>
                    {channel.kind === 'email'
                      ? `${channel.recipientCount} 位收件人`
                      : channel.host}
                  </p>
                  <p className='text-label'>
                    {channel.allowAlerts ? '可用于告警' : '不用于告警'} · 已授权{' '}
                    {channel.targetIds.length} 个目标
                    {channel.format === 'legacy_alert@1'
                      ? ' · 旧版告警格式'
                      : ''}
                  </p>
                  {canWrite && (
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => setEditing(channel)}
                      >
                        编辑
                      </Button>
                      {(
                        [
                          'test',
                          channel.enabled ? 'disable' : 'enable',
                          'revoke',
                        ] as const
                      ).map((action) => (
                        <Button
                          key={action}
                          size='sm'
                          variant='outline'
                          disabled={
                            (channel.revoked && action !== 'disable') ||
                            (action === 'test' &&
                              (!current.enabled ||
                                !channel.enabled ||
                                (channel.kind === 'email' &&
                                  (!current.smtp?.enabled ||
                                    current.smtp.revoked))))
                          }
                          onClick={() => {
                            setPending({
                              channel,
                              action,
                              key: notificationCommandKey(),
                            })
                            setReason('')
                            setError('')
                          }}
                        >
                          {action === 'test'
                            ? '测试发送'
                            : action === 'disable'
                              ? '停用'
                              : action === 'enable'
                                ? '启用'
                                : '撤销当前版本'}
                        </Button>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
          {current.smtp && canWrite && (
            <SmtpStateActions current={current} onSaved={changed} />
          )}
          <details className='rounded-lg border border-border p-4'>
            <summary className='cursor-pointer text-body font-medium'>
              固定消息模板示例
            </summary>
            <div className='mt-3 space-y-2 text-body text-muted-foreground'>
              <p>运行结果：订单检查</p>
              <p>场景：订单检查 · 目标：订单系统</p>
              <p>
                执行状态：执行完成 · 业务结果：未评价业务结果 ·
                证据状态：证据收集中
              </p>
              <p>
                结束时间、通知编号和详情链接随消息附上。证据尚未收齐会明确说明，后续补齐不会再次发送。
              </p>
              <p>
                告警消息包含规则名称、严重程度、触发／依据中断／恢复状态和监控详情链接。
              </p>
              <p>
                Webhook 使用结构化字段表达相同事实；邮件提供纯文本与 HTML
                两种正文。
              </p>
            </div>
          </details>
          <section className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4'>
            <div>
              <h2 className='font-semibold'>邮件发送配置</h2>
              <p className='mt-1 text-label text-muted-foreground'>
                {current.smtp
                  ? `${current.smtp.host} · ${current.smtp.enabled ? '启用' : '停用'}`
                  : '尚未配置 SMTP 中继'}
                。中继地址须由部署配置许可。
              </p>
            </div>
            {canWrite && (
              <Button variant='outline' onClick={() => setSmtpOpen(true)}>
                配置邮件发送
              </Button>
            )}
          </section>
          <Dialog
            open={Boolean(editing)}
            onOpenChange={(open) => {
              if (!open) setEditing(undefined)
            }}
          >
            <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-xl'>
              <DialogHeader>
                <DialogTitle>
                  {editing === 'new' ? '添加通知渠道' : '编辑通知渠道'}
                </DialogTitle>
                <DialogDescription>
                  地址和收件人加密保存。变更目的地或目标授权需要全局管理权限。
                </DialogDescription>
              </DialogHeader>
              {editing && (
                <ChannelForm
                  current={current}
                  channel={editing === 'new' ? undefined : editing}
                  onSaved={async () => {
                    setEditing(undefined)
                    await changed()
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
          <Dialog open={smtpOpen} onOpenChange={setSmtpOpen}>
            <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-xl'>
              <DialogHeader>
                <DialogTitle>邮件发送配置</DialogTitle>
                <DialogDescription>
                  必须使用 TLS 或
                  STARTTLS。密码只写不读，留空可复用同一中继身份的原密码。
                </DialogDescription>
              </DialogHeader>
              <SmtpForm
                current={current}
                onSaved={async () => {
                  setSmtpOpen(false)
                  await changed()
                }}
              />
            </DialogContent>
          </Dialog>
          <Dialog
            open={Boolean(pending)}
            onOpenChange={(open) => {
              if (!open) setPending(undefined)
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {pending?.action === 'test'
                    ? '测试发送'
                    : pending?.action === 'revoke'
                      ? '撤销当前版本'
                      : '变更渠道状态'}
                </DialogTitle>
                <DialogDescription>
                  {pending?.action === 'revoke'
                    ? '此版本将永久停止发送；回退平台配置不会恢复授权。后续使用须保存一个新版本。'
                    : pending?.action === 'disable'
                      ? '尚未提交的通知会停止发送，重新启用后也不会补发这批记录。'
                      : pending?.action === 'test'
                        ? '将向已保存的目的地发送合成消息，不包含业务数据。'
                        : '启用后可用于新通知。'}
                </DialogDescription>
              </DialogHeader>
              <Field label='操作原因'>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={512}
                />
              </Field>
              <Failure message={error} />
              <Button
                disabled={busy || !reason.trim()}
                onClick={() => void act()}
              >
                确认{pending?.action === 'test' ? '发送' : '操作'}
              </Button>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}
function Settings({
  current,
  canWrite,
  onSaved,
}: {
  current: NotificationChannels
  canWrite: boolean
  onSaved: () => Promise<void>
}) {
  const [enabled, setEnabled] = useState(current.enabled),
    [url, setUrl] = useState(current.consoleBaseUrl),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const input = notificationSettingsWriteSchema.parse({
        expectedRevision: current.revision,
        reason,
        enabled,
        consoleBaseUrl: url,
      })
      await postNotification(
        'settings',
        input,
        notificationChannelsResponseSchema
      )
      await onSaved()
      toast.success('通知设置已保存')
    } catch (e) {
      setError(validationMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className='space-y-3 rounded-lg border border-border p-4'
    >
      <h2 className='text-section font-semibold'>通知总开关</h2>
      <label className='flex items-center gap-2 text-body'>
        <input
          type='checkbox'
          disabled={!canWrite}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        启用通知
      </label>
      <p className='text-label text-muted-foreground'>
        暂停后，尚未提交的通知不再发送；恢复后仅处理新通知。
      </p>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field label='控制台地址' hint='通知中的详情链接使用此 HTTPS 地址。'>
          <Input
            type='url'
            disabled={!canWrite}
            placeholder='https://cairn.example.com'
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {canWrite && (
          <Field label='变更原因'>
            <Input
              required
              maxLength={512}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}
      </div>
      <Failure message={error} />
      {canWrite && (
        <Button disabled={busy || !reason.trim()} type='submit'>
          保存通知设置
        </Button>
      )}
    </form>
  )
}
function ChannelForm({
  current,
  channel,
  onSaved,
}: {
  current: NotificationChannels
  channel?: Channel
  onSaved: () => Promise<void>
}) {
  const [kind, setKind] = useState(channel?.kind ?? 'webhook'),
    [name, setName] = useState(channel?.name ?? ''),
    [enabled, setEnabled] = useState(channel?.enabled ?? true)
  const [allowAlerts, setAllowAlerts] = useState(channel?.allowAlerts ?? false),
    [targets, setTargets] = useState(channel?.targetIds ?? [])
  const [url, setUrl] = useState(''),
    [token, setToken] = useState(''),
    [signingKey, setSigningKey] = useState(''),
    [emails, setEmails] = useState(''),
    [reason, setReason] = useState('')
  const [clearToken, setClearToken] = useState(false),
    [clearKey, setClearKey] = useState(false),
    [format, setFormat] = useState(channel?.format ?? 'cairn.notification@1')
  const [replay, setReplay] = useState(channel?.replay ?? 'manual_on_unknown'),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const options = useQuery({
    queryKey: ['notification-targets', search],
    queryFn: () => fetchTargets({ search, limit: 100 }),
  })
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const input = notificationChannelWriteSchema.parse({
        expectedRevision: current.revision,
        reason,
        id: channel?.id,
        name,
        kind,
        enabled,
        allowAlerts,
        targetIds: targets,
        format: kind === 'email' ? 'cairn.notification@1' : format,
        replay: kind === 'email' ? 'manual_on_unknown' : replay,
        ...(kind === 'webhook'
          ? {
              url: url || undefined,
              token: clearToken ? '' : token || undefined,
              signingKey: clearKey ? '' : signingKey || undefined,
            }
          : {
              emails: emails.trim()
                ? emails.split(/[\s,;]+/).filter(Boolean)
                : undefined,
            }),
      })
      await postNotification(
        'channels',
        input,
        notificationChannelsResponseSchema
      )
      await onSaved()
      toast.success('渠道已保存')
    } catch (e) {
      setError(validationMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className='space-y-4'>
      <Field label='渠道名称'>
        <Input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label='发送方式'>
        <select
          className={selectClass}
          value={kind}
          disabled={Boolean(channel)}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value='webhook'>Webhook</option>
          <option value='email'>邮件</option>
        </select>
      </Field>
      {kind === 'webhook' ? (
        <>
          <Field
            label='Webhook 地址'
            hint={channel ? '留空复用已保存地址。' : '仅支持公开 HTTPS 地址。'}
          >
            <Input
              type='url'
              required={!channel}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete='off'
            />
          </Field>
          <Field label='Bearer Token（可选）'>
            <Input
              type='password'
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete='new-password'
            />
          </Field>
          <Field label='签名密钥（可选）'>
            <Input
              type='password'
              value={signingKey}
              onChange={(e) => setSigningKey(e.target.value)}
              autoComplete='new-password'
            />
          </Field>
          {channel && (
            <div className='flex flex-wrap gap-3 text-label'>
              <label>
                <input
                  type='checkbox'
                  checked={clearToken}
                  onChange={(e) => setClearToken(e.target.checked)}
                />{' '}
                清除原 Token
              </label>
              <label>
                <input
                  type='checkbox'
                  checked={clearKey}
                  onChange={(e) => setClearKey(e.target.checked)}
                />{' '}
                清除原签名密钥
              </label>
            </div>
          )}
          <Field label='消息格式'>
            <select
              className={selectClass}
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
            >
              <option value='cairn.notification@1'>标准通知（推荐）</option>
              <option value='legacy_alert@1'>兼容旧版告警</option>
            </select>
          </Field>
          <label className='flex items-start gap-2 text-label'>
            <input
              type='checkbox'
              checked={replay === 'receiver_deduplicates'}
              onChange={(e) =>
                setReplay(
                  e.target.checked
                    ? 'receiver_deduplicates'
                    : 'manual_on_unknown'
                )
              }
            />
            接收方已按通知编号去重，允许接收结果不明时自动重试
          </label>
        </>
      ) : (
        <Field
          label='收件人'
          hint={
            channel
              ? '留空保留原名单；修改时填写完整名单。每位收件人独立发送，最多 20 位。'
              : '使用空格、逗号或分号分隔，最多 20 位。'
          }
        >
          <Input
            required={!channel}
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            autoComplete='off'
          />
        </Field>
      )}
      <div className='flex gap-4 text-body'>
        <label>
          <input
            type='checkbox'
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          启用渠道
        </label>
        <label>
          <input
            type='checkbox'
            checked={allowAlerts}
            onChange={(e) => setAllowAlerts(e.target.checked)}
          />{' '}
          用于告警
        </label>
      </div>
      <fieldset className='space-y-2'>
        <legend className='text-label font-medium'>
          允许结果通知的目标（已选 {targets.length} 个）
        </legend>
        <Input
          aria-label='搜索授权目标'
          placeholder='搜索目标名称'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className='max-h-40 space-y-2 overflow-y-auto rounded-md border border-border p-3'>
          {options.data?.items.map((t) => (
            <label className='flex gap-2 text-body' key={t.id}>
              <input
                type='checkbox'
                checked={targets.includes(t.id)}
                onChange={(e) =>
                  setTargets(
                    e.target.checked
                      ? [...targets, t.id]
                      : targets.filter((id) => id !== t.id)
                  )
                }
              />
              {t.name}
            </label>
          ))}
          {options.data?.nextCursor && (
            <p className='text-label text-muted-foreground'>
              仅显示前 100 项，请通过搜索缩小范围。
            </p>
          )}
          {!options.isPending && !options.data?.items.length && (
            <p className='text-label text-muted-foreground'>没有匹配的目标</p>
          )}
        </div>
        <Failure message={options.error?.message} />
      </fieldset>
      <Field label='变更原因'>
        <Input
          required
          maxLength={512}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Failure message={error} />
      <Button type='submit' disabled={busy}>
        保存渠道
      </Button>
    </form>
  )
}
function SmtpForm({
  current,
  onSaved,
}: {
  current: NotificationChannels
  onSaved: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const input = notificationSmtpWriteSchema.parse({
        expectedRevision: current.revision,
        reason: f.get('reason'),
        enabled: f.get('enabled') === 'on',
        host: f.get('host'),
        port: Number(f.get('port')),
        tls: f.get('tls'),
        username: f.get('username'),
        password: f.get('password') || undefined,
        from: f.get('from'),
      })
      await postNotification('smtp', input, notificationChannelsResponseSchema)
      await onSaved()
      toast.success('邮件发送配置已保存')
    } catch (e) {
      setError(validationMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className='space-y-3'>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field label='SMTP 主机'>
          <Input name='host' required defaultValue={current.smtp?.host ?? ''} />
        </Field>
        <Field label='端口'>
          <Input
            type='number'
            name='port'
            defaultValue={587}
            min={1}
            max={65535}
            required
          />
        </Field>
      </div>
      <Field label='传输加密'>
        <select className={selectClass} name='tls' defaultValue='starttls'>
          <option value='starttls'>STARTTLS</option>
          <option value='tls'>TLS</option>
        </select>
      </Field>
      <Field label='用户名'>
        <Input name='username' required autoComplete='off' />
      </Field>
      <Field label='密码'>
        <Input
          name='password'
          type='password'
          required={!current.smtp}
          autoComplete='new-password'
        />
      </Field>
      <Field label='发件人邮箱'>
        <Input name='from' type='email' required />
      </Field>
      <label className='flex items-center gap-2 text-body'>
        <input
          name='enabled'
          type='checkbox'
          defaultChecked={current.smtp?.enabled ?? true}
        />
        启用邮件发送
      </label>
      <Field label='变更原因'>
        <Input name='reason' maxLength={512} required />
      </Field>
      <Failure message={error} />
      <Button disabled={busy} type='submit'>
        保存邮件配置
      </Button>
    </form>
  )
}
function SmtpStateActions({
  current,
  onSaved,
}: {
  current: NotificationChannels
  onSaved: () => Promise<void>
}) {
  const [action, setAction] = useState<'toggle' | 'revoke'>(),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const smtp = current.smtp!
  async function save() {
    setBusy(true)
    setError('')
    try {
      await postNotification(
        'smtp/state',
        {
          expectedRevision: current.revision,
          reason,
          ...(action === 'revoke'
            ? { revokeVersion: smtp.version }
            : { enabled: !smtp.enabled }),
        },
        notificationChannelsResponseSchema
      )
      setAction(undefined)
      await onSaved()
    } catch (e) {
      setError(validationMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <span className='text-label text-muted-foreground'>
        {smtp.revoked
          ? '当前邮件版本已撤销，请保存新配置后使用。'
          : '邮件发送控制'}
      </span>
      <Button
        variant='outline'
        disabled={smtp.revoked && !smtp.enabled}
        onClick={() => {
          setAction('toggle')
          setReason('')
        }}
      >
        {smtp.enabled ? '停用邮件发送' : '启用邮件发送'}
      </Button>
      <Button
        variant='outline'
        disabled={smtp.revoked}
        onClick={() => {
          setAction('revoke')
          setReason('')
        }}
      >
        撤销邮件当前版本
      </Button>
      <Dialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open) setAction(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === 'revoke' ? '撤销邮件当前版本' : '变更邮件发送状态'}
            </DialogTitle>
            <DialogDescription>
              {action === 'revoke'
                ? '永久停止此 SMTP 版本的外发，回退配置不会恢复。保存新版本后才能继续发送。'
                : '停用会停止尚未提交的邮件，恢复后不会补发旧积压。'}
            </DialogDescription>
          </DialogHeader>
          <Field label='操作原因'>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={512}
            />
          </Field>
          <Failure message={error} />
          <Button disabled={busy || !reason.trim()} onClick={() => void save()}>
            确认操作
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
export function validationMessage(error: unknown) {
  if (error && typeof error === 'object' && 'issues' in error)
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join('；')
  return error instanceof Error ? error.message : '保存失败，请重试'
}
