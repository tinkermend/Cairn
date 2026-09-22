import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  DEFAULT_NOTIFICATION_POLICY,
  notificationPolicyResponseSchema,
  notificationPolicyWriteSchema,
  type NotificationPolicy,
  type PlatformConfigDocument,
} from '@cairn/shared'
import {
  AlertTriangle,
  ExternalLink,
  Mail,
  Search,
  Webhook,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchMonitorAlertRules,
  updateMonitorAlertRules,
} from '@/lib/monitoring-api'
import {
  fetchNotificationChannels,
  fetchNotificationPolicy,
  postNotification,
} from '@/lib/notifications-api'
import { fetchScenarios, fetchScenario } from '@/lib/scenarios-api'
import { useCan } from '@/hooks/use-permissions'
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
import { StatusBadge } from '@/components/status-badge'
import { Switch } from '@/components/ui/switch'
import { AlertingFields } from '@/features/platform-config/alerting-fields'
import { cn } from '@/lib/utils'
import { validationMessage } from './channels'
import { Field, Failure } from './index'

export function NotificationRulesPanel({
  scenarioId,
}: {
  scenarioId?: string
}) {
  const [selected, setSelected] = useState(scenarioId ?? ''),
    [search, setSearch] = useState('')
  const scenarios = useQuery({
    queryKey: ['notification-scenarios', search],
    queryFn: () => fetchScenarios({ search, purpose: 'user', limit: 100 }),
  })
  const scenario = useQuery({
    queryKey: ['notification-scenario', selected],
    queryFn: () => fetchScenario(selected),
    enabled: Boolean(selected),
  })
  const policy = useQuery({
    queryKey: ['notification-policy', selected],
    queryFn: () => fetchNotificationPolicy(selected),
    enabled: Boolean(selected),
  })
  const canWrite = useCan('workflow:write') && useCan('run:read')

  useEffect(() => {
    if (!selected && scenarios.data?.items?.length) {
      setSelected(scenarios.data.items[0].id)
    }
  }, [selected, scenarios.data?.items])

  const scenarioItems = useMemo(() => {
    const list = scenarios.data?.items ? [...scenarios.data.items] : []
    if (selected && scenario.data && !list.some((s) => s.id === selected)) {
      list.unshift({
        id: selected,
        name: scenario.data.name,
        targetId: scenario.data.targetId,
      } as any)
    }
    return list
  }, [scenarios.data?.items, selected, scenario.data])

  return (
    <div className='grid gap-5 lg:grid-cols-[320px_1fr] items-start'>
      {/* 左侧 Master：场景筛选与列表 */}
      <div className='flex flex-col rounded-lg border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div className='flex items-center gap-2 border-b border-border-divider pb-3'>
          <Workflow className='size-4 text-primary' />
          <div>
            <h2 className='font-semibold text-text-primary text-body'>
              选择场景
            </h2>
            <p className='text-label text-muted-foreground'>
              共 {scenarioItems.length} 个场景
            </p>
          </div>
        </div>

        <div className='relative'>
          <Search className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground' />
          <Input
            placeholder='输入场景名称搜索…'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='pl-9 h-9'
          />
        </div>

        <div className='max-h-[600px] overflow-y-auto space-y-1.5 pr-1'>
          {scenarios.isPending && (
            <p className='py-6 text-center text-label text-muted-foreground'>
              正在加载场景…
            </p>
          )}
          {!scenarios.isPending && scenarioItems.length === 0 && (
            <p className='py-6 text-center text-label text-muted-foreground'>
              未找到匹配的场景
            </p>
          )}
          {scenarioItems.map((s) => {
            const isCurrent = s.id === selected
            return (
              <button
                key={s.id}
                type='button'
                onClick={() => setSelected(s.id)}
                className={cn(
                  'w-full text-left rounded-md px-3 py-2.5 text-body transition-colors flex flex-col gap-1 border',
                  isCurrent
                    ? 'border-primary bg-primary/5 text-text-primary font-medium'
                    : 'border-transparent hover:bg-surface-subtle text-text-primary'
                )}
              >
                <span className='truncate font-medium'>{s.name}</span>
                <span className='truncate text-label text-muted-foreground'>
                  目标：{s.targetId}
                </span>
              </button>
            )
          })}
        </div>

        {scenarios.data?.nextCursor && (
          <p className='text-label text-muted-foreground border-t border-border-divider pt-2'>
            仅显示前 100 项，可搜索精确定位。
          </p>
        )}
      </div>

      {/* 右侧 Detail：场景通知策略表单 */}
      <div className='min-w-0 space-y-4'>
        <Failure
          message={
            scenarios.error?.message ||
            scenario.error?.message ||
            policy.error?.message
          }
        />

        {selected && (policy.isPending || scenario.isPending) && (
          <div className='rounded-lg border border-border-card bg-card p-12 text-center text-body text-muted-foreground shadow-card'>
            正在加载场景通知设置…
          </div>
        )}

        {policy.data && scenario.data ? (
          <PolicyForm
            key={`${selected}:${policy.data.revision}`}
            scenarioId={selected}
            scenarioName={scenario.data.name}
            targetId={scenario.data.targetId}
            initial={policy.data.policy}
            revision={policy.data.revision}
            canWrite={canWrite}
            onSaved={() => policy.refetch()}
          />
        ) : !selected ? (
          <div className='rounded-lg border border-border-card bg-card p-12 text-center text-body text-muted-foreground shadow-card'>
            请从左侧选择一个场景以配置通知策略
          </div>
        ) : null}
      </div>
    </div>
  )
}

function PolicyForm({
  scenarioId,
  scenarioName,
  targetId,
  initial,
  revision,
  canWrite,
  onSaved,
}: {
  scenarioId: string
  scenarioName: string
  targetId: string
  initial: NotificationPolicy
  revision: number
  canWrite: boolean
  onSaved: () => Promise<unknown>
}) {
  const [policy, setPolicy] = useState(initial ?? DEFAULT_NOTIFICATION_POLICY),
    [reason, setReason] = useState(''),
    [cancelPrevious, setCancelPrevious] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const channels = useQuery({
    queryKey: ['notification-channels', targetId],
    queryFn: () => fetchNotificationChannels(targetId),
  })

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const input = notificationPolicyWriteSchema.parse({
        expectedRevision: revision,
        policy,
        cancelPrevious,
        reason,
      })
      await postNotification(
        `scenarios/${scenarioId}/policy`,
        input,
        notificationPolicyResponseSchema
      )
      await onSaved()
      toast.success('场景通知设置已保存')
    } catch (e) {
      setError(validationMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className='space-y-5 rounded-lg border border-border-card bg-card p-6 shadow-card'
    >
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider pb-4'>
        <div>
          <h3 className='font-semibold text-text-primary text-section'>
            {scenarioName}
          </h3>
          <p className='text-label text-muted-foreground'>
            所属目标 ID：{targetId} · 当前版本修订：#{revision}
          </p>
        </div>
        <StatusBadge tone={policy.enabled ? 'success' : 'neutral'}>
          {policy.enabled ? '通知已启用' : '通知未开启'}
        </StatusBadge>
      </div>

      <fieldset disabled={!canWrite || busy} className='space-y-5'>
        <div className='flex items-center justify-between rounded-lg bg-surface-subtle p-3.5'>
          <div>
            <p className='font-medium text-text-primary text-body'>
              启用结果通知
            </p>
            <p className='text-label text-muted-foreground'>
              关闭时，新运行结束不会外发结果消息。
            </p>
          </div>
          <Switch
            checked={policy.enabled}
            onCheckedChange={(checked) =>
              setPolicy({ ...policy, enabled: checked })
            }
          />
        </div>

        <div className='space-y-3'>
          <Field
            label='通知触发条件'
            hint='异常包括执行失败、业务结果为 WARN / FAIL / UNKNOWN、证据待收齐或不完整。'
          >
            <Select
              value={policy.mode}
              onValueChange={(value) =>
                setPolicy({
                  ...policy,
                  mode: value as NotificationPolicy['mode'],
                })
              }
            >
              <SelectTrigger className='w-full sm:w-64' aria-label='通知触发条件'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='exceptions'>仅异常结果（推荐）</SelectItem>
                <SelectItem value='all_finished'>每次运行结束（含成功）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {policy.mode === 'exceptions' && (
            <label className='flex items-center gap-2 text-body'>
              <Checkbox
                checked={policy.includeCancelled}
                onCheckedChange={(checked) =>
                  setPolicy({ ...policy, includeCancelled: Boolean(checked) })
                }
              />
              <span>用户或系统取消运行也发送通知</span>
            </label>
          )}
        </div>

        <div className='space-y-2 border-t border-border-divider pt-4'>
          <p className='text-label font-medium text-text-primary'>运行来源范围</p>
          <div className='flex flex-wrap gap-6'>
            {(['console', 'service'] as const).map((source) => (
              <label key={source} className='flex items-center gap-2 text-body'>
                <Checkbox
                  checked={policy.sourceKinds.includes(source)}
                  onCheckedChange={(checked) =>
                    setPolicy({
                      ...policy,
                      sourceKinds: checked
                        ? [...policy.sourceKinds, source]
                        : policy.sourceKinds.filter((v) => v !== source),
                    })
                  }
                />
                <span>
                  {source === 'console' ? '控制台运行' : '开放服务运行'}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className='space-y-3 border-t border-border-divider pt-4'>
          <div>
            <p className='text-label font-medium text-text-primary'>
              已授权发送渠道
            </p>
            <p className='text-label text-muted-foreground'>
              仅展示已获准用于此目标系统的标准通知渠道。
            </p>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            {channels.data?.channels
              .filter((c) => c.format === 'cairn.notification@1')
              .map((c) => (
                <label
                  key={c.id}
                  className='flex cursor-pointer items-start gap-3 rounded-lg border border-border-card bg-surface-subtle p-3 hover:bg-card transition-colors'
                >
                  <Checkbox
                    checked={policy.channelIds.includes(c.id)}
                    disabled={
                      (!c.enabled || c.revoked) &&
                      !policy.channelIds.includes(c.id)
                    }
                    onCheckedChange={(checked) =>
                      setPolicy({
                        ...policy,
                        channelIds: checked
                          ? [...policy.channelIds, c.id]
                          : policy.channelIds.filter((id) => id !== c.id),
                      })
                    }
                  />
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-center gap-1.5'>
                      {c.kind === 'email' ? (
                        <Mail className='size-3.5 text-primary shrink-0' />
                      ) : (
                        <Webhook className='size-3.5 text-primary shrink-0' />
                      )}
                      <span className='truncate font-medium text-text-primary text-body'>
                        {c.name}
                      </span>
                    </div>
                    <p className='mt-0.5 text-label text-muted-foreground'>
                      {c.kind === 'email'
                        ? `${c.recipientCount} 位收件人`
                        : c.host}
                      {c.revoked
                        ? ' · 版本已撤销'
                        : !c.enabled
                          ? ' · 已停用'
                          : ''}
                    </p>
                  </div>
                </label>
              ))}
          </div>

          {!channels.data?.channels.length && (
            <p className='rounded-md bg-surface-subtle p-3 text-label text-muted-foreground'>
              此目标系统暂无已授权渠道，请联系管理员在“通知渠道”中配置并授予该目标的发送权限。
            </p>
          )}

          {policy.channelIds
            .filter((id) => !channels.data?.channels.some((c) => c.id === id))
            .map((id) => (
              <label key={id} className='flex items-center gap-2 text-label text-destructive'>
                <Checkbox
                  checked
                  onCheckedChange={() =>
                    setPolicy({
                      ...policy,
                      channelIds: policy.channelIds.filter((v) => v !== id),
                    })
                  }
                />
                <span>已不可用的原渠道（取消勾选以移除）</span>
              </label>
            ))}
        </div>

        <div className='border-t border-border-divider pt-4 space-y-3'>
          <label className='flex items-start gap-2 text-body'>
            <Checkbox
              checked={cancelPrevious}
              onCheckedChange={(checked) => setCancelPrevious(Boolean(checked))}
            />
            <span>
              同时停止此前运行尚未提交的通知（包括正在执行中的运行）
            </span>
          </label>

          <Field label='变更原因'>
            <Input
              required
              value={reason}
              maxLength={512}
              placeholder='填写修改原因以供审计'
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      <Failure message={error || channels.error?.message} />

      <div className='flex flex-wrap items-center gap-3 pt-2'>
        {canWrite && (
          <Button type='submit' disabled={busy}>
            保存场景通知策略
          </Button>
        )}
        <Button variant='outline' asChild>
          <Link to='/scenarios/$scenarioId' params={{ scenarioId }}>
            <ExternalLink className='size-3.5' />
            前往场景详情
          </Link>
        </Button>
      </div>
    </form>
  )
}

export function NotificationAlertRules() {
  const rules = useQuery({
    queryKey: ['notification-alert-rules'],
    queryFn: fetchMonitorAlertRules,
  })
  const canWrite = useCan('platform-config:write'),
    canConfig = useCan('platform-config:read')
  const channels = useQuery({
    queryKey: ['notification-channels'],
    queryFn: () => fetchNotificationChannels(),
    enabled: canConfig,
  })

  if (rules.error) return <Failure message={rules.error.message} />
  if (!rules.data)
    return (
      <div className='p-8 text-center text-body text-muted-foreground'>
        正在加载告警规则…
      </div>
    )

  return (
    <AlertRulesForm
      key={`${rules.data.revision}:${channels.data?.revision}`}
      rules={rules.data.rules}
      channels={channels.data?.channels ?? []}
      revision={channels.data?.revision ?? rules.data.revision}
      canWrite={canWrite}
    />
  )
}

function AlertRulesForm({
  rules,
  channels,
  revision,
  canWrite,
}: {
  rules: PlatformConfigDocument['alerting']['rules']
  channels: Awaited<ReturnType<typeof fetchNotificationChannels>>['channels']
  revision: number
  canWrite: boolean
}) {
  const form = useForm<PlatformConfigDocument>({
    defaultValues: { alerting: { rules }, notifications: { channels } },
  })
  const [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    client = useQueryClient()

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await updateMonitorAlertRules({
        expectedRevision: revision,
        reason,
        rules: form.getValues('alerting.rules'),
      })
      await client.invalidateQueries({ queryKey: ['notification-alert-rules'] })
      await client.invalidateQueries({ queryKey: ['notification-channels'] })
      toast.success('告警规则已保存')
    } catch (e) {
      setError(validationMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormProvider {...form}>
      <form
        onSubmit={(e) => void save(e)}
        className='space-y-5 rounded-lg border border-border-card bg-card p-6 shadow-card'
      >
        <div className='flex items-center gap-2 border-b border-border-divider pb-3'>
          <AlertTriangle className='size-4 text-status-warning-foreground' />
          <div>
            <h2 className='font-semibold text-text-primary text-section'>
              监控告警规则通知
            </h2>
            <p className='text-label text-muted-foreground'>
              复用监控的告警规则；触发、依据中断和恢复各自留下通知记录。
            </p>
          </div>
        </div>

        <AlertingFields
          hideChannels
          canWrite={canWrite}
          revision={revision}
          reason={reason}
          busy={busy}
          onRegistered={async () => undefined}
        />

        <Failure message={error} />

        {canWrite && (
          <div className='border-t border-border-divider pt-4 space-y-3'>
            <Field label='变更原因'>
              <Input
                required
                maxLength={512}
                placeholder='填写修改原因以供审计'
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Button disabled={busy} type='submit'>
              保存告警规则
            </Button>
          </div>
        )}
      </form>
    </FormProvider>
  )
}
