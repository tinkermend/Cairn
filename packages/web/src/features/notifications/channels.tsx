import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  notificationChannelsResponseSchema,
  notificationChannelWriteSchema,
  notificationSettingsWriteSchema,
  notificationSmtpWriteSchema,
} from '@cairn/shared'
import {
  FileText,
  Mail,
  Plus,
  Radio,
  Server,
  Webhook,
} from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectField,
  SelectFieldOption,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusBadge } from '@/components/status-badge'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Field, Failure } from './index'

type Channel = NotificationChannels['channels'][number]

export function NotificationChannelsPanel() {
  const data = useQuery({
      queryKey: ['notification-channels'],
      queryFn: () => fetchNotificationChannels(),
    }),
    client = useQueryClient()
  const canWrite = useCan('platform-config:write')
  const [editing, setEditing] = useState<Channel | 'new'>(),
    [smtpOpen, setSmtpOpen] = useState(false),
    [previewOpen, setPreviewOpen] = useState(false)
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
      {data.isPending && (
        <p className='text-body text-muted-foreground' role='status'>
          正在加载通知渠道…
        </p>
      )}
      {current && (
        <>
          <div className='grid gap-5 lg:grid-cols-2 items-stretch'>
            <Settings
              key={current.revision}
              current={current}
              canWrite={canWrite}
              onSaved={changed}
            />
            <SmtpCard
              current={current}
              canWrite={canWrite}
              onConfigure={() => setSmtpOpen(true)}
              onSaved={changed}
            />
          </div>

          <section className='space-y-4'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h2 className='font-semibold text-text-primary text-section'>
                  发送渠道
                </h2>
                <p className='text-label text-muted-foreground'>
                  授权到具体目标后，渠道才可用于该目标的场景。最多登记 16
                  个渠道。
                </p>
              </div>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setPreviewOpen(true)}
                >
                  <FileText className='size-4' />
                  查看消息格式示例
                </Button>
                {canWrite && current.channels.length > 0 && (
                  <Button
                    disabled={current.channels.length >= 16}
                    onClick={() => setEditing('new')}
                  >
                    <Plus className='size-4' />
                    添加渠道
                  </Button>
                )}
              </div>
            </div>

            {!current.channels.length ? (
              <EmptyState
                title='还没有通知渠道'
                description='添加 Webhook 或邮件收件人后，可发送合成消息验证配置。'
                action={
                  canWrite ? (
                    <Button onClick={() => setEditing('new')}>
                      <Plus className='size-4' />
                      添加第一个渠道
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className='grid gap-4 md:grid-cols-2'>
                {current.channels.map((channel) => (
                  <article
                    key={channel.id}
                    className='flex flex-col justify-between space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'
                  >
                    <div className='space-y-2.5'>
                      <div className='flex items-start justify-between gap-2'>
                        <div className='flex items-center gap-2.5'>
                          <span
                            aria-hidden='true'
                            className='flex size-9 shrink-0 items-center justify-center rounded-md border border-border-default bg-surface-subtle text-primary'
                          >
                            {channel.kind === 'email' ? (
                              <Mail className='size-4' />
                            ) : (
                              <Webhook className='size-4' />
                            )}
                          </span>
                          <div className='min-w-0'>
                            <h3 className='truncate font-semibold text-text-primary text-body'>
                              {channel.name}
                            </h3>
                            <p className='text-label text-muted-foreground'>
                              {channel.kind === 'email' ? '邮件' : 'Webhook'}
                            </p>
                          </div>
                        </div>
                        <StatusBadge
                          tone={
                            channel.revoked
                              ? 'warning'
                              : channel.enabled
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          {channel.revoked
                            ? '版本已撤销'
                            : channel.enabled
                              ? '已启用'
                              : '已停用'}
                        </StatusBadge>
                      </div>

                      <p className='text-label text-muted-foreground break-all'>
                        {channel.kind === 'email'
                          ? `收件人：${channel.recipientCount} 位`
                          : `地址：${channel.host}`}
                      </p>

                      <div className='flex flex-wrap gap-1.5 pt-1'>
                        <StatusBadge
                          tone={channel.allowAlerts ? 'info' : 'neutral'}
                        >
                          {channel.allowAlerts ? '可用于告警' : '不用于告警'}
                        </StatusBadge>
                        <StatusBadge tone='neutral'>
                          已授权 {channel.targetIds.length} 个目标
                        </StatusBadge>
                        {channel.format === 'legacy_alert@1' && (
                          <StatusBadge tone='warning'>
                            旧版告警格式
                          </StatusBadge>
                        )}
                      </div>
                    </div>

                    {canWrite && (
                      <div className='flex flex-wrap gap-2 border-t border-border-divider pt-3'>
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
                                  : '撤销版本'}
                          </Button>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
            <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
              <DialogHeader>
                <DialogTitle>固定消息模板预览</DialogTitle>
                <DialogDescription>
                  不同事件类型的通知格式参考。Webhook 使用结构化 JSON 载荷，邮件提供纯文本与 HTML 两种格式。
                </DialogDescription>
              </DialogHeader>
              <TemplatePreviewContent />
            </DialogContent>
          </Dialog>

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
                  placeholder='填写操作原因以供审计'
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
      className='flex flex-col justify-between space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'
    >
      <div className='space-y-4'>
        <div className='flex items-center justify-between gap-3 border-b border-border-divider pb-3'>
          <div className='flex items-center gap-2'>
            <Radio className='size-4 text-primary' />
            <h3 className='font-semibold text-text-primary text-section'>
              通知总开关
            </h3>
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-label text-muted-foreground'>
              {enabled ? '已启用' : '已暂停'}
            </span>
            <Switch
              disabled={!canWrite}
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label='启用通知'
            />
          </div>
        </div>

        <p className='text-label text-muted-foreground'>
          暂停后，尚未提交的通知不再发送；恢复后仅处理新通知。
        </p>

        <Field
          label='控制台访问地址'
          hint='通知正文中的运行详情及告警链接使用此地址拼接（支持 HTTP 或 HTTPS）。'
        >
          <Input
            type='url'
            disabled={!canWrite}
            placeholder='http://localhost:5173 或 https://cairn.example.com'
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>

        {canWrite && (
          <Field label='变更原因'>
            <Input
              required
              maxLength={512}
              placeholder='填写修改原因以供审计'
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}
      </div>

      <Failure message={error} />

      {canWrite && (
        <div className='border-t border-border-divider pt-3'>
          <Button disabled={busy || !reason.trim()} type='submit'>
            保存全局设置
          </Button>
        </div>
      )}
    </form>
  )
}

function SmtpCard({
  current,
  canWrite,
  onConfigure,
  onSaved,
}: {
  current: NotificationChannels
  canWrite: boolean
  onConfigure: () => void
  onSaved: () => Promise<void>
}) {
  return (
    <div className='flex flex-col justify-between space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <div className='space-y-4'>
        <div className='flex items-center justify-between gap-3 border-b border-border-divider pb-3'>
          <div className='flex items-center gap-2'>
            <Server className='size-4 text-primary' />
            <h3 className='font-semibold text-text-primary text-section'>
              邮件发送中继 (SMTP)
            </h3>
          </div>
          {current.smtp && (
            <StatusBadge
              tone={
                current.smtp.revoked
                  ? 'warning'
                  : current.smtp.enabled
                    ? 'success'
                    : 'neutral'
              }
            >
              {current.smtp.revoked
                ? '版本已撤销'
                : current.smtp.enabled
                  ? '已启用'
                  : '已停用'}
            </StatusBadge>
          )}
        </div>

        {current.smtp ? (
          <div className='space-y-2 text-label text-muted-foreground'>
            <p>
              <span className='text-text-primary font-medium'>中继主机：</span>
              {current.smtp.host}（版本 #{current.smtp.version}）
            </p>
            <p>
              <span className='text-text-primary font-medium'>中继状态：</span>
              {current.smtp.revoked
                ? '版本已撤销，需重新配置'
                : current.smtp.enabled
                  ? '服务已启用'
                  : '服务已停用'}
            </p>
            <p>中继地址须由部署配置许可；认证凭据加密保存不回显。</p>
          </div>
        ) : (
          <div className='rounded-md bg-surface-subtle p-3 text-label text-muted-foreground'>
            尚未配置 SMTP 中继服务。配置后，邮件渠道方可正式发送通知。
          </div>
        )}
      </div>

      <div className='flex flex-wrap items-center gap-2 border-t border-border-divider pt-3'>
        {canWrite && (
          <Button variant='outline' size='sm' onClick={onConfigure}>
            {current.smtp ? '重新配置 SMTP' : '配置邮件发送'}
          </Button>
        )}
        {current.smtp && canWrite && (
          <SmtpStateActions current={current} onSaved={onSaved} />
        )}
      </div>
    </div>
  )
}

function TemplatePreviewContent() {
  return (
    <div className='space-y-3 pt-1'>
      <Tabs defaultValue='run'>
        <TabsList className='border-b-0'>
          <TabsTrigger value='run'>运行结果通知</TabsTrigger>
          <TabsTrigger value='alert'>监控告警通知</TabsTrigger>
        </TabsList>
        <TabsContent value='run' className='mt-3'>
          <div className='rounded-md bg-surface-subtle p-4 font-mono text-label text-muted-foreground space-y-1'>
            <p className='font-semibold text-text-primary'>
              [识途 · 运行结果] 订单业务巡检：未通过
            </p>
            <p>目标系统：生产订单系统</p>
            <p>执行状态：执行完成 · 业务结果：未通过 · 证据状态：证据完整</p>
            <p>耗时：2 分 18 秒 · 采样时间：2026-09-21 10:00:00 +08:00</p>
            <p>查看运行详情：https://cairn.example.com/runs/run-12345678</p>
          </div>
        </TabsContent>
        <TabsContent value='alert' className='mt-3'>
          <div className='rounded-md bg-surface-subtle p-4 font-mono text-label text-muted-foreground space-y-1'>
            <p className='font-semibold text-text-primary'>
              [识途 · 告警触发] 步骤失败率过高：P1 紧急
            </p>
            <p>规则名称：连续失败率告警</p>
            <p>当前状态：触发中 · 当前读数：85%（阈值：50%）</p>
            <p>发生时间：2026-09-21 10:05:00 +08:00</p>
            <p>查看监控详情：https://cairn.example.com/monitoring</p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
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
          placeholder='如：运维告警群 Webhook / 业务通知邮件'
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label='发送方式'>
        <SelectField
          value={kind}
          disabled={Boolean(channel)}
          onValueChange={(value) => setKind(value as typeof kind)}
        >
          <SelectFieldOption value='webhook'>Webhook</SelectFieldOption>
          <SelectFieldOption value='email'>邮件</SelectFieldOption>
        </SelectField>
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
              placeholder='https://api.example.com/webhook'
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
            <div className='flex flex-wrap gap-4 text-label'>
              <label className='flex items-center gap-2'>
                <Checkbox
                  checked={clearToken}
                  onCheckedChange={(checked) => setClearToken(Boolean(checked))}
                />
                <span>清除原 Token</span>
              </label>
              <label className='flex items-center gap-2'>
                <Checkbox
                  checked={clearKey}
                  onCheckedChange={(checked) => setClearKey(Boolean(checked))}
                />
                <span>清除原签名密钥</span>
              </label>
            </div>
          )}
          <Field label='消息格式'>
            <SelectField
              value={format}
              onValueChange={(value) => setFormat(value as typeof format)}
            >
              <SelectFieldOption value='cairn.notification@1'>
                标准通知（推荐）
              </SelectFieldOption>
              <SelectFieldOption value='legacy_alert@1'>
                兼容旧版告警
              </SelectFieldOption>
            </SelectField>
          </Field>
          <label className='flex items-start gap-2 text-label'>
            <Checkbox
              checked={replay === 'receiver_deduplicates'}
              onCheckedChange={(checked) =>
                setReplay(
                  checked ? 'receiver_deduplicates' : 'manual_on_unknown'
                )
              }
            />
            <span>
              接收方已按通知编号去重，允许接收结果不明时自动重试
            </span>
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
            placeholder='ops@example.com, alert@example.com'
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            autoComplete='off'
          />
        </Field>
      )}

      <div className='grid grid-cols-2 gap-4 border-y border-border-divider py-3'>
        <label className='flex items-center justify-between text-body'>
          <span>启用渠道</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>
        <label className='flex items-center justify-between text-body'>
          <span>用于告警</span>
          <Switch checked={allowAlerts} onCheckedChange={setAllowAlerts} />
        </label>
      </div>

      <fieldset className='space-y-2'>
        <legend className='text-label font-medium'>
          允许结果通知的目标系统（已选 {targets.length} 个）
        </legend>
        <Input
          aria-label='搜索授权目标'
          placeholder='搜索目标系统名称'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className='max-h-40 space-y-2 overflow-y-auto rounded-md border border-border-card bg-surface-subtle p-3'>
          {options.data?.items.map((t) => (
            <label className='flex items-center gap-2 text-body' key={t.id}>
              <Checkbox
                checked={targets.includes(t.id)}
                onCheckedChange={(checked) =>
                  setTargets(
                    checked
                      ? [...targets, t.id]
                      : targets.filter((id) => id !== t.id)
                  )
                }
              />
              <span>{t.name}</span>
            </label>
          ))}
          {options.data?.nextCursor && (
            <p className='text-label text-muted-foreground'>
              仅显示前 100 项，请通过搜索缩小范围。
            </p>
          )}
          {!options.isPending && !options.data?.items.length && (
            <p className='text-label text-muted-foreground'>没有匹配的目标系统</p>
          )}
        </div>
        <Failure message={options.error?.message} />
      </fieldset>

      <Field label='变更原因'>
        <Input
          required
          maxLength={512}
          placeholder='填写变更原因以供审计'
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
    [error, setError] = useState(''),
    [enabled, setEnabled] = useState(current.smtp?.enabled ?? true)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const input = notificationSmtpWriteSchema.parse({
        expectedRevision: current.revision,
        reason: f.get('reason'),
        enabled,
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
          <Input
            name='host'
            required
            placeholder='smtp.example.com'
            defaultValue={current.smtp?.host ?? ''}
          />
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
        <Select name='tls' defaultValue='starttls'>
          <SelectTrigger className='w-full' aria-label='传输加密'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='starttls'>STARTTLS</SelectItem>
            <SelectItem value='tls'>TLS</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label='发件用户名'>
        <Input name='username' required autoComplete='off' />
      </Field>
      <Field
        label='发件密码 / 授权码'
        hint={current.smtp ? '留空保留原密码。' : undefined}
      >
        <Input
          name='password'
          type='password'
          required={!current.smtp}
          autoComplete='new-password'
        />
      </Field>
      <Field label='发件人邮箱'>
        <Input
          name='from'
          type='email'
          placeholder='noreply@example.com'
          required
        />
      </Field>

      <div className='flex items-center justify-between border-y border-border-divider py-3'>
        <span className='text-body'>启用邮件发送</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <Field label='变更原因'>
        <Input
          name='reason'
          maxLength={512}
          placeholder='填写修改原因以供审计'
          required
        />
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
    <>
      <Button
        variant='outline'
        size='sm'
        disabled={smtp.revoked && !smtp.enabled}
        onClick={() => {
          setAction('toggle')
          setReason('')
        }}
      >
        {smtp.enabled ? '停用邮件' : '启用邮件'}
      </Button>
      <Button
        variant='outline'
        size='sm'
        disabled={smtp.revoked}
        onClick={() => {
          setAction('revoke')
          setReason('')
        }}
      >
        撤销版本
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
              placeholder='填写操作原因以供审计'
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
    </>
  )
}

export function validationMessage(error: unknown) {
  if (error && typeof error === 'object' && 'issues' in error)
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join('；')
  return error instanceof Error ? error.message : '保存失败，请重试'
}
