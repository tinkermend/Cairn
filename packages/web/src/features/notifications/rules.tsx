import { useState, type FormEvent } from 'react'
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
import { Input } from '@/components/ui/input'
import { AlertingFields } from '@/features/platform-config/alerting-fields'
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
  return (
    <div className='space-y-4'>
      <div className='max-w-xl space-y-3'>
        <h2 className='text-section font-semibold'>场景结果通知</h2>
        <p className='text-body text-muted-foreground'>
          为场景选择通知条件和渠道。修改后对新运行生效，试跑和调试不会发送。
        </p>
        <Field label='搜索场景'>
          <Input
            placeholder='场景名称'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
        <Field label='选择场景'>
          <select
            className='h-9 rounded-md border border-input bg-background px-3'
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value=''>请选择</option>
            {selected &&
              !scenarios.data?.items.some((s) => s.id === selected) && (
                <option value={selected}>
                  {scenario.data?.name ?? '当前场景'}
                </option>
              )}
            {scenarios.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {scenarios.data?.nextCursor && (
          <p className='text-label text-muted-foreground'>
            仅显示前 100 项，可搜索其他场景。
          </p>
        )}
      </div>
      <Failure
        message={
          scenarios.error?.message ||
          scenario.error?.message ||
          policy.error?.message
        }
      />
      {selected && (policy.isPending || scenario.isPending) && (
        <p role='status'>正在加载场景通知设置…</p>
      )}
      {policy.data && scenario.data && (
        <PolicyForm
          key={`${selected}:${policy.data.revision}`}
          scenarioId={selected}
          targetId={scenario.data.targetId}
          initial={policy.data.policy}
          revision={policy.data.revision}
          canWrite={canWrite}
          onSaved={() => policy.refetch()}
        />
      )}
    </div>
  )
}
function PolicyForm({
  scenarioId,
  targetId,
  initial,
  revision,
  canWrite,
  onSaved,
}: {
  scenarioId: string
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
      className='max-w-2xl space-y-4 rounded-lg border border-border p-4'
    >
      <fieldset disabled={!canWrite || busy} className='space-y-4'>
        <label className='flex items-center gap-2 text-body'>
          <input
            type='checkbox'
            checked={policy.enabled}
            onChange={(e) =>
              setPolicy({ ...policy, enabled: e.target.checked })
            }
          />
          启用结果通知
        </label>
        <Field label='通知条件'>
          <select
            className='h-9 rounded-md border border-input bg-background px-3'
            value={policy.mode}
            onChange={(e) =>
              setPolicy({
                ...policy,
                mode: e.target.value as NotificationPolicy['mode'],
              })
            }
          >
            <option value='exceptions'>仅异常结果</option>
            <option value='all_finished'>每次运行结束</option>
          </select>
        </Field>
        <p className='text-label text-muted-foreground'>
          异常包括执行失败、业务结果为 WARN / FAIL / UNKNOWN、证据待齐或不完整。
        </p>
        {policy.mode === 'exceptions' && (
          <label className='flex items-center gap-2 text-body'>
            <input
              type='checkbox'
              checked={policy.includeCancelled}
              onChange={(e) =>
                setPolicy({ ...policy, includeCancelled: e.target.checked })
              }
            />
            取消运行也通知
          </label>
        )}
        <fieldset className='space-y-2'>
          <legend className='mb-2 text-label font-medium'>运行来源</legend>
          {(['console', 'service'] as const).map((source) => (
            <label key={source} className='mr-4 inline-flex gap-2 text-body'>
              <input
                type='checkbox'
                checked={policy.sourceKinds.includes(source)}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    sourceKinds: e.target.checked
                      ? [...policy.sourceKinds, source]
                      : policy.sourceKinds.filter((v) => v !== source),
                  })
                }
              />
              {source === 'console' ? '控制台运行' : '开放服务运行'}
            </label>
          ))}
        </fieldset>
        <fieldset className='space-y-2'>
          <legend className='mb-2 text-label font-medium'>发送渠道</legend>
          {channels.data?.channels
            .filter((c) => c.format === 'cairn.notification@1')
            .map((c) => (
              <label key={c.id} className='flex items-center gap-2 text-body'>
                <input
                  type='checkbox'
                  checked={policy.channelIds.includes(c.id)}
                  disabled={
                    (!c.enabled || c.revoked) &&
                    !policy.channelIds.includes(c.id)
                  }
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      channelIds: e.target.checked
                        ? [...policy.channelIds, c.id]
                        : policy.channelIds.filter((id) => id !== c.id),
                    })
                  }
                />
                {c.name} · {c.kind === 'email' ? '邮件' : 'Webhook'}
                {c.revoked ? '（版本已撤销）' : !c.enabled ? '（已停用）' : ''}
              </label>
            ))}
          {!channels.data?.channels.length && (
            <p className='text-label text-muted-foreground'>
              此目标暂无授权渠道，请管理员在“通知渠道”中配置。
            </p>
          )}
          {policy.channelIds
            .filter((id) => !channels.data?.channels.some((c) => c.id === id))
            .map((id) => (
              <label key={id} className='flex gap-2 text-label'>
                <input
                  type='checkbox'
                  checked
                  onChange={() =>
                    setPolicy({
                      ...policy,
                      channelIds: policy.channelIds.filter((v) => v !== id),
                    })
                  }
                />
                已不可用的原渠道（取消选择以移除）
              </label>
            ))}
        </fieldset>
        <label className='flex items-start gap-2 text-body'>
          <input
            type='checkbox'
            checked={cancelPrevious}
            onChange={(e) => setCancelPrevious(e.target.checked)}
          />
          同时停止历史运行尚未提交的通知（包括正在执行的运行）
        </label>
        <Field label='变更原因'>
          <Input
            required
            value={reason}
            maxLength={512}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </fieldset>
      <Failure message={error || channels.error?.message} />
      {canWrite && (
        <Button type='submit' disabled={busy}>
          保存结果通知
        </Button>
      )}
      <Button className='ml-2' variant='outline' asChild>
        <Link to='/scenarios/$scenarioId' params={{ scenarioId }}>
          查看场景
        </Link>
      </Button>
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
  if (!rules.data) return <p role='status'>正在加载告警规则…</p>
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
      <form onSubmit={(e) => void save(e)} className='space-y-4'>
        <p className='text-body text-muted-foreground'>
          复用运行监控的告警规则；触发、依据中断和恢复各自留下通知记录。
        </p>
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
          <>
            <Field label='变更原因'>
              <Input
                required
                maxLength={512}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Button disabled={busy} type='submit'>
              保存告警规则
            </Button>
          </>
        )}
      </form>
    </FormProvider>
  )
}
