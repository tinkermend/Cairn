import { useState } from 'react'
import { useFormContext } from 'react-hook-form'
import {
  ALERTABLE_METRIC_KEYS,
  ALERT_COMPARATORS,
  ALERT_SEVERITIES,
  FACTORY_ALERT_RULES,
  requiredAlertMetricScope,
  type AlertRule,
  type MonitorMetricKey,
  type PlatformConfigCurrent,
  type PlatformConfigDocument,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { registerMonitorAlertChannel } from '@/lib/monitoring-api'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

const COMPARATOR_LABELS: Record<(typeof ALERT_COMPARATORS)[number], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
}

const SEVERITY_LABELS: Record<(typeof ALERT_SEVERITIES)[number], string> = {
  warning: '警告',
  critical: '严重',
}

export function AlertingFields({
  canWrite,
  revision,
  reason,
  busy,
  onRegistered,
  hideChannels = false,
}: {
  canWrite: boolean
  revision?: number
  reason: string
  busy: boolean
  onRegistered: (saved: PlatformConfigCurrent) => Promise<void>
  hideChannels?: boolean
}) {
  const form = useFormContext<PlatformConfigDocument>()
  const rules = form.watch('alerting.rules') ?? FACTORY_ALERT_RULES
  const channels = (form.watch('notifications.channels') ?? []).filter(c => c.allowAlerts)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [registering, setRegistering] = useState(false)

  async function registerChannel() {
    if (!revision || !canWrite) return
    const persistReason = reason.trim()
    if (!persistReason) {
      toast.error('请填写变更原因')
      return
    }
    if (!name.trim() || !url.trim()) {
      toast.error('请填写渠道名称和 Webhook 地址')
      return
    }
    setRegistering(true)
    try {
      const saved = await registerMonitorAlertChannel({
        expectedRevision: revision,
        reason: persistReason,
        name: name.trim(),
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        enabled: true,
      })
      setName('')
      setUrl('')
      setToken('')
      await onRegistered(saved)
      toast.success(`Webhook 已登记，修订 ${saved.revision}`)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '登记失败')
    } finally {
      setRegistering(false)
    }
  }

  return (
    <div className='space-y-6'>
      <p className='text-label text-muted-foreground'>
        出厂建议规则全部关闭。Webhook 地址只在登记时提交，不会写入配置文档或变更记录。
      </p>
      <div className='space-y-3'>
        {rules.map((rule, index) => (
          <article key={rule.id} className='space-y-3 rounded-md border border-border px-3 py-3'>
            <FormField
              name={`alerting.rules.${index}.enabled`}
              render={({ field }) => (
                <FormItem className='flex items-center justify-between gap-4'>
                  <div>
                    <FormLabel>{rule.name}</FormLabel>
                    <FormDescription>
                      {rule.kind === 'threshold'
                        ? `${rule.metricKey} ${rule.comparator} ${rule.threshold}`
                        : `采集中断 · ${rule.source}`}
                      {` · ${rule.scope} · ${rule.severity}`}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      disabled={!canWrite}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <div className='grid gap-3 md:grid-cols-2'>
              <FormField
                name={`alerting.rules.${index}.forSeconds`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>迟滞（秒）</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        min={0}
                        max={86_400}
                        disabled={!canWrite}
                        value={field.value}
                        onChange={(event) => field.onChange(Number(event.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {rule.kind === 'threshold' ? (
                <FormField
                  name={`alerting.rules.${index}.threshold`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>阈值</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          disabled={!canWrite}
                          value={field.value}
                          onChange={(event) => field.onChange(Number(event.target.value))}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              ) : null}
            </div>
            {rule.id.startsWith('factory.') ? null : (
              <div className='grid gap-3 md:grid-cols-2'>
                <FormField
                  name={`alerting.rules.${index}.name`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>规则名称</FormLabel>
                      <FormControl>
                        <Input disabled={!canWrite} value={field.value} onChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                {rule.kind === 'threshold' ? (
                  <>
                    <FormField
                      name={`alerting.rules.${index}.metricKey`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>指标</FormLabel>
                          <Select
                            disabled={!canWrite}
                            value={field.value}
                            onValueChange={(value) => {
                              const metricKey = value as MonitorMetricKey
                              field.onChange(metricKey)
                              form.setValue(
                                `alerting.rules.${index}.scope`,
                                requiredAlertMetricScope(metricKey),
                                { shouldDirty: true },
                              )
                            }}
                          >
                            <FormControl>
                              <SelectTrigger className='w-full'>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {ALERTABLE_METRIC_KEYS.map((key) => (
                                <SelectItem key={key} value={key}>
                                  {key}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                    <FormField
                      name={`alerting.rules.${index}.comparator`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>比较符</FormLabel>
                          <Select
                            disabled={!canWrite}
                            value={field.value}
                            onValueChange={field.onChange}
                          >
                            <FormControl>
                              <SelectTrigger className='w-full'>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {ALERT_COMPARATORS.map((comparator) => (
                                <SelectItem key={comparator} value={comparator}>
                                  {COMPARATOR_LABELS[comparator]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </>
                ) : null}
                <FormField
                  name={`alerting.rules.${index}.severity`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>严重度</FormLabel>
                      <Select
                        disabled={!canWrite}
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ALERT_SEVERITIES.map((severity) => (
                            <SelectItem key={severity} value={severity}>
                              {SEVERITY_LABELS[severity]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                {canWrite ? (
                  <div className='flex items-end'>
                    <Button
                      type='button'
                      variant='outline'
                      disabled={busy}
                      onClick={() => {
                        form.setValue(
                          'alerting.rules',
                          rules.filter((_, ruleIndex) => ruleIndex !== index),
                          { shouldDirty: true },
                        )
                      }}
                    >
                      删除自定义规则
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
            {channels.length > 0 ? (
              <fieldset className='space-y-2'>
                <legend className='text-label text-muted-foreground'>通知渠道</legend>
                {channels.map((channel) => (
                  <label key={channel.id} className='flex items-center gap-2 text-body'>
                    <input
                      type='checkbox'
                      disabled={!canWrite}
                      checked={rule.channelIds.includes(channel.id)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...rule.channelIds, channel.id]
                          : rule.channelIds.filter((id) => id !== channel.id)
                        form.setValue(`alerting.rules.${index}.channelIds`, next, {
                          shouldDirty: true,
                        })
                      }}
                    />
                    <span>
                      {channel.name} · {channel.kind === 'email' ? '邮件' : channel.host}
                      {channel.enabled ? '' : '（已关闭）'}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </article>
        ))}
      </div>
      {canWrite ? (
        <Button
          type='button'
          variant='outline'
          disabled={busy}
          onClick={() => {
            const custom: AlertRule = {
              kind: 'threshold',
              id: `custom.${crypto.randomUUID().replace(/-/g, '')}`,
              name: '自定义阈值',
              metricKey: ALERTABLE_METRIC_KEYS[0]!,
              scope: requiredAlertMetricScope(ALERTABLE_METRIC_KEYS[0]!),
              comparator: 'gte',
              threshold: 1,
              forSeconds: 60,
              severity: 'warning',
              channelIds: [],
              enabled: false,
            }
            form.setValue('alerting.rules', [...rules, custom], { shouldDirty: true })
          }}
        >
          添加自定义规则
        </Button>
      ) : null}
      {!hideChannels && <section className='space-y-3 rounded-md border border-border px-3 py-3'>
        <h3 className='text-small font-semibold'>Webhook 渠道</h3>
        {channels.length === 0 ? (
          <p className='text-label text-muted-foreground'>还没有渠道。登记后只保存主机名。</p>
        ) : (
          <ul className='space-y-1'>
            {channels.map((channel) => (
              <li key={channel.id} className='text-body'>
                {channel.name} · {channel.host} · {channel.enabled ? '启用' : '关闭'}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <div className='grid gap-3 md:grid-cols-2'>
            <div className='space-y-2'>
              <label className='text-label' htmlFor='alert-channel-name'>
                渠道名称
              </label>
              <Input
                id='alert-channel-name'
                value={name}
                disabled={registering || busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <label className='text-label' htmlFor='alert-channel-url'>
                Webhook 地址
              </label>
              <Input
                id='alert-channel-url'
                type='url'
                autoComplete='off'
                value={url}
                disabled={registering || busy}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className='space-y-2 md:col-span-2'>
              <label className='text-label' htmlFor='alert-channel-token'>
                Bearer 令牌（可选）
              </label>
              <Input
                id='alert-channel-token'
                type='password'
                autoComplete='new-password'
                value={token}
                disabled={registering || busy}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            <Button
              type='button'
              variant='outline'
              disabled={registering || busy}
              onClick={() => void registerChannel()}
            >
              登记 Webhook
            </Button>
          </div>
        ) : null}
      </section>}
    </div>
  )
}
